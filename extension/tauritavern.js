// TauriTavern local backend adapter: reads Vertex AI responses from TauriTavern's built-in LLM API log store
// and persists billing settings & ledger to TauriTavern's native extensionStore (no Node server plugin needed).
import {
    CATALOG_SYNC_INTERVAL_MS,
    parseTauriEndpoint,
    parseTauriSseRaw,
    parseTauriNormalizedResponse,
    priceRecord,
    applyCatalogSync,
    recordOfflineUserEdits,
    fetchModelsDevCatalog,
    priceUnpricedRecords,
    createRecord,
    summarize,
} from '../server/billing-core.js';

const STORE_NAMESPACE = 'agent-platform-billing';
const KEY_SETTINGS = 'settings';
const KEY_LEDGER = 'ledger';
const KEY_META = 'meta';

const RAW_RETRY_DELAYS_MS = [40, 80, 120, 200, 350, 500, 750, 1000];
const MAX_PROCESSED_KEYS = 200;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getTestHosts() {
    const raw = globalThis.__AGENT_PLATFORM_BILLING_TEST_HOSTS__;
    if (Array.isArray(raw)) return raw.map(h => String(h).trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map(h => h.trim()).filter(Boolean);
    return [];
}

/**
 * TauriTavern emits `tauritavern-llm-api-log` right before its background task finishes persisting raw JSON files
 * for non-streaming calls (`store.rs`). Retry briefly if `getRaw(id)` hits ENOENT or an empty body on an ok call.
 */
async function getRawWithRetry(llmApiLogs, id, expectBody) {
    let lastErr = null;
    for (let attempt = 0; attempt <= RAW_RETRY_DELAYS_MS.length; attempt++) {
        try {
            const raw = await llmApiLogs.getRaw(id);
            if (!expectBody || (raw && typeof raw.responseRaw === 'string' && raw.responseRaw.length > 0)) {
                return raw;
            }
        } catch (e) {
            lastErr = e;
        }
        if (attempt < RAW_RETRY_DELAYS_MS.length) {
            await sleep(RAW_RETRY_DELAYS_MS[attempt]);
        }
    }
    if (lastErr) throw lastErr;
    return { id, requestRaw: '', responseRaw: '', responseRawKind: null };
}

export async function createTauriTavernBackend({
    llmApiLogs = globalThis.__TAURITAVERN__?.api?.dev?.llmApiLogs,
    extensionStore = globalThis.__TAURITAVERN__?.api?.extension?.store,
    onRecord = null,
    onCatalogUpdated = null,
    autoSync = true,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!llmApiLogs || !extensionStore) {
        throw new Error('TauriTavern native APIs (llmApiLogs / extension.store) are unavailable');
    }

    let settings = {
        pricing: {},
        upstreamPricing: {},
        knownDefaultModels: [],
        vertexModelGroups: [],
        catalogSource: null,
        catalogSyncedAt: null,
        migratedToModelsDev: false,
    };
    let records = [];
    let lastLogId = null;
    let lastLogTimestampMs = 0;
    let processedKeys = [];
    const processedSet = new Set();
    let unsubscribe = null;
    let syncTimer = null;
    let syncInFlight = null;

    // Serialize all mutations and store writes so concurrent requests / UI actions never race.
    let queue = Promise.resolve();
    const enqueue = (fn) => {
        const next = queue.then(fn, fn);
        queue = next.catch(() => {});
        return next;
    };

    const saveSettings = () => extensionStore.setJson({ namespace: STORE_NAMESPACE, key: KEY_SETTINGS, value: settings });
    const saveLedger = () => extensionStore.setJson({ namespace: STORE_NAMESPACE, key: KEY_LEDGER, value: records });
    const saveMeta = () => extensionStore.setJson({
        namespace: STORE_NAMESPACE,
        key: KEY_META,
        value: { lastLogId, lastLogTimestampMs, processedKeys },
    });

    function markProcessed(dedupeKey, entry, { resetCursor = false } = {}) {
        if (!processedSet.has(dedupeKey)) {
            processedSet.add(dedupeKey);
            processedKeys.push(dedupeKey);
            while (processedKeys.length > MAX_PROCESSED_KEYS) {
                const evicted = processedKeys.shift();
                processedSet.delete(evicted);
            }
        }
        const entryTs = Number(entry.timestampMs) || 0;
        if (resetCursor || lastLogId === null) {
            lastLogId = entry.id;
        } else {
            lastLogId = Math.max(lastLogId, entry.id);
        }
        if (entryTs > lastLogTimestampMs) {
            lastLogTimestampMs = entryTs;
        }
    }

    async function syncCatalog({ notify = false } = {}) {
        if (syncInFlight) return syncInFlight;
        syncInFlight = (async () => {
            const catalog = await fetchModelsDevCatalog({ fetchImpl });
            return enqueue(async () => {
                const result = applyCatalogSync(settings, catalog);
                await saveSettings();

                const repriced = priceUnpricedRecords(records, settings.pricing);
                if (repriced > 0) await saveLedger();
                if (notify && (result.added > 0 || result.updated > 0 || result.migrated || repriced > 0) && typeof onCatalogUpdated === 'function') {
                    onCatalogUpdated();
                }
                return {
                    ok: true,
                    source: catalog.source,
                    syncedAt: settings.catalogSyncedAt,
                    modelCount: catalog.modelCount,
                    added: result.added,
                    updated: result.updated,
                    migrated: result.migrated,
                    repriced,
                };
            });
        })().finally(() => {
            syncInFlight = null;
        });
        return syncInFlight;
    }

    async function processEntry(entry, { isLive }) {
        if (!entry || typeof entry.id !== 'number') return;
        const dedupeKey = `${entry.id}:${entry.timestampMs ?? 0}`;
        if (processedSet.has(dedupeKey)) return;

        // During startup catch-up, only process logs strictly newer than the saved cursor.
        // Live subscriptions can legitimately arrive with entry.id <= lastLogId when logs were cleared
        // mid-session (IDs restart from 1) or when concurrent requests finish out of order.
        if (!isLive && lastLogId !== null && entry.id <= lastLogId) return;

        const entryTs = Number(entry.timestampMs) || 0;
        const isLogReset = isLive
            && lastLogId !== null
            && entry.id < lastLogId
            && (entry.id === 1 || (entryTs > 0 && entryTs >= lastLogTimestampMs && lastLogId - entry.id > 1));

        if (entry.source !== 'vertexai') {
            markProcessed(dedupeKey, entry, { resetCursor: isLogReset });
            await saveMeta();
            return;
        }
        const info = parseTauriEndpoint(entry.endpoint, entry.model, Boolean(entry.stream), getTestHosts());
        if (!info) {
            markProcessed(dedupeKey, entry, { resetCursor: isLogReset });
            await saveMeta();
            return;
        }

        const complete = Boolean(entry.ok);
        // Upstream HTTP errors are not recorded; cancelled streams (WARN) are parsed for partial usageMetadata.
        if (!complete && !(entry.stream && entry.level === 'WARN')) {
            markProcessed(dedupeKey, entry, { resetCursor: isLogReset });
            await saveMeta();
            return;
        }

        let raw;
        try {
            raw = await getRawWithRetry(llmApiLogs, entry.id, complete);
        } catch (e) {
            // Do not advance the processed cursor on transient read failures so catch-up can recover it.
            console.error('[agent-platform-billing] failed to read TauriTavern LLM API log:', e);
            return;
        }

        let payload;
        try {
            if (raw.responseRawKind === 'sse' || entry.stream) {
                payload = parseTauriSseRaw(raw.responseRaw, complete);
                if (!payload.usage && !complete) {
                    console.warn(`[agent-platform-billing] ${info.model} stream closed before any usageMetadata arrived; Google may still bill this request`);
                    markProcessed(dedupeKey, entry, { resetCursor: isLogReset });
                    await saveMeta();
                    return;
                }
            } else if (raw.responseRaw) {
                payload = parseTauriNormalizedResponse(raw.responseRaw);
            } else {
                payload = { complete };
            }
        } catch (e) {
            console.error('[agent-platform-billing] failed to parse TauriTavern response:', e);
            return;
        }

        const rawTs = isLive
            ? Date.now()
            : ((entryTs || Date.now()) + (Number(entry.durationMs) || 0));
        const prevTs = records.at(-1)?.ts ?? 0;
        const ts = rawTs <= prevTs ? prevTs + 1 : rawTs;

        const rec = createRecord(info, payload, settings.pricing, { ts });
        records.push(rec);
        markProcessed(dedupeKey, entry, { resetCursor: isLogReset });
        await saveLedger();
        await saveMeta();

        const usage = rec.usage;
        const c = rec.cost ? `$${rec.cost.total.toFixed(6)}` : '未定价';
        console.info(`[agent-platform-billing] [TauriTavern] ${rec.model} in=${usage?.promptTokenCount ?? '-'} out=${usage?.candidatesTokenCount ?? '-'} think=${usage?.thoughtsTokenCount ?? 0} cached=${usage?.cachedContentTokenCount ?? 0} cost=${c}${rec.complete ? '' : ' (incomplete)'}`);

        if (isLive && typeof onRecord === 'function') {
            onRecord(rec);
        }
    }

    const initPromise = enqueue(async () => {
        const [savedSettings, savedLedger, savedMeta] = await Promise.all([
            extensionStore.tryGetJson({ namespace: STORE_NAMESPACE, key: KEY_SETTINGS }).catch(() => ({ found: false })),
            extensionStore.tryGetJson({ namespace: STORE_NAMESPACE, key: KEY_LEDGER }).catch(() => ({ found: false })),
            extensionStore.tryGetJson({ namespace: STORE_NAMESPACE, key: KEY_META }).catch(() => ({ found: false })),
        ]);

        if (savedSettings?.found && savedSettings.value && typeof savedSettings.value === 'object') {
            settings = { ...settings, ...savedSettings.value };
        }

        if (savedLedger?.found && Array.isArray(savedLedger.value)) {
            records = savedLedger.value;
            const repriced = priceUnpricedRecords(records, settings.pricing);
            if (repriced > 0) await saveLedger();
        }
        if (savedMeta?.found && savedMeta.value && typeof savedMeta.value === 'object') {
            if (typeof savedMeta.value.lastLogId === 'number') {
                lastLogId = savedMeta.value.lastLogId;
            }
            if (typeof savedMeta.value.lastLogTimestampMs === 'number') {
                lastLogTimestampMs = savedMeta.value.lastLogTimestampMs;
            }
            if (Array.isArray(savedMeta.value.processedKeys)) {
                processedKeys = savedMeta.value.processedKeys.slice(-MAX_PROCESSED_KEYS);
                processedKeys.forEach(k => processedSet.add(k));
            }
        }

        // Subscribe before reading index() so any request completing during catch-up queues strictly after init.
        unsubscribe = await llmApiLogs.subscribeIndex((entry) => {
            enqueue(() => processEntry(entry, { isLive: true }));
        });

        const existing = (await llmApiLogs.index({ limit: 50 }).catch(() => [])) || [];
        const sorted = [...existing].sort((a, b) => a.id - b.id);
        const maxExistingId = sorted.length ? sorted.at(-1).id : 0;

        if (lastLogId === null) {
            // First launch: start from current log head so historical pre-install logs are not retroactively billed.
            lastLogId = maxExistingId;
            await saveMeta();
        } else {
            // If TauriTavern's log directory was cleared and log IDs restarted from 1, reset cursor.
            if (maxExistingId > 0 && maxExistingId < lastLogId) {
                lastLogId = 0;
                await saveMeta();
            }
            for (const entry of sorted) {
                if (entry.id > lastLogId) {
                    await processEntry(entry, { isLive: false });
                }
            }
        }
    });
    await initPromise;

    if (autoSync) {
        const needsSync = !settings.migratedToModelsDev
            || !settings.catalogSyncedAt
            || (Date.now() - settings.catalogSyncedAt >= CATALOG_SYNC_INTERVAL_MS);
        if (needsSync) {
            syncCatalog({ notify: true }).catch((e) => {
                console.warn('[agent-platform-billing] [TauriTavern] models.dev sync failed:', e.message);
            });
        }
        syncTimer = setInterval(() => {
            syncCatalog({ notify: true }).catch((e) => {
                console.warn('[agent-platform-billing] [TauriTavern] periodic models.dev sync failed:', e.message);
            });
        }, CATALOG_SYNC_INTERVAL_MS);
    }

    async function handle(endpoint, body = {}) {
        if (endpoint === '/catalog/sync') {
            return syncCatalog();
        }
        return enqueue(async () => {
            if (endpoint === '/summary') {
                const since = Number(body?.since) || 0;
                const todaySince = Number(body?.todaySince) || 0;
                return {
                    ...summarize(records, since, todaySince),
                    latest: records.slice(-20),
                    lastTs: records.at(-1)?.ts ?? 0,
                };
            }
            if (endpoint === '/records') {
                const limit = Math.min(Number(body?.limit) || 100, 1000);
                return { items: records.slice(-limit).reverse(), total: records.length };
            }
            if (endpoint === '/settings/get') {
                return {
                    ...settings,
                    defaultPricing: settings.upstreamPricing || {},
                    catalogSyncing: Boolean(syncInFlight),
                };
            }
            if (endpoint === '/settings/save') {
                const { pricing } = body || {};
                if (pricing !== undefined) {
                    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
                        throw new Error('pricing must be an object');
                    }
                    recordOfflineUserEdits(settings, pricing);
                    settings.pricing = pricing;
                }
                await saveSettings();
                return { ok: true };
            }
            if (endpoint === '/recalculate') {
                records.forEach(r => priceRecord(r, settings.pricing));
                await saveLedger();
                return { ok: true, count: records.length };
            }
            if (endpoint === '/reset') {
                records = [];
                await saveLedger();
                return { ok: true };
            }
            throw new Error(`Unknown endpoint: ${endpoint}`);
        });
    }

    return {
        handle,
        async dispose() {
            if (syncTimer) {
                clearInterval(syncTimer);
                syncTimer = null;
            }
            if (typeof unsubscribe === 'function') {
                await unsubscribe();
                unsubscribe = null;
            }
        },
    };
}
