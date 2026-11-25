// TauriTavern local backend adapter: reads Vertex AI responses from TauriTavern's built-in LLM API log store
// and persists billing settings & ledger to TauriTavern's native extensionStore (no Node server plugin needed).
import { DEFAULT_PRICING, PRICING_UPDATED_AT } from '../server/pricing.js';
import {
    parseTauriEndpoint,
    parseTauriSseRaw,
    parseTauriNormalizedResponse,
    priceRecord,
    syncNewDefaultPricing,
    priceUnpricedRecords,
    createRecord,
    summarize,
} from '../server/billing-core.js';

const STORE_NAMESPACE = 'agent-platform-billing';
const KEY_SETTINGS = 'settings';
const KEY_LEDGER = 'ledger';
const KEY_META = 'meta';

const RAW_RETRY_DELAYS_MS = [40, 80, 120, 180, 250, 350, 500];

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
} = {}) {
    if (!llmApiLogs || !extensionStore) {
        throw new Error('TauriTavern native APIs (llmApiLogs / extension.store) are unavailable');
    }

    let settings = {
        pricing: structuredClone(DEFAULT_PRICING),
        knownDefaultModels: Object.keys(DEFAULT_PRICING),
    };
    let records = [];
    let lastLogId = null;
    const seen = new Set();
    let unsubscribe = null;

    // Serialize all mutations and store writes so concurrent requests / UI actions never race.
    let queue = Promise.resolve();
    const enqueue = (fn) => {
        const next = queue.then(fn, fn);
        queue = next.catch(() => {});
        return next;
    };

    const saveSettings = () => extensionStore.setJson({ namespace: STORE_NAMESPACE, key: KEY_SETTINGS, value: settings });
    const saveLedger = () => extensionStore.setJson({ namespace: STORE_NAMESPACE, key: KEY_LEDGER, value: records });
    const saveMeta = () => extensionStore.setJson({ namespace: STORE_NAMESPACE, key: KEY_META, value: { lastLogId } });

    async function processEntry(entry, { isLive }) {
        if (!entry || typeof entry.id !== 'number') return;
        const dedupeKey = `${entry.id}:${entry.timestampMs ?? 0}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        if (lastLogId !== null && entry.id <= lastLogId) return;
        lastLogId = entry.id;
        await saveMeta();

        if (entry.source !== 'vertexai') return;
        const info = parseTauriEndpoint(entry.endpoint, entry.model, Boolean(entry.stream), getTestHosts());
        if (!info) return;

        const complete = Boolean(entry.ok);
        // Upstream HTTP errors are not recorded; cancelled streams (WARN) are parsed for partial usageMetadata.
        if (!complete && !(entry.stream && entry.level === 'WARN')) return;

        let raw;
        try {
            raw = await getRawWithRetry(llmApiLogs, entry.id, complete);
        } catch (e) {
            console.error('[agent-platform-billing] failed to read TauriTavern LLM API log:', e);
            return;
        }

        let payload;
        try {
            if (raw.responseRawKind === 'sse' || entry.stream) {
                payload = parseTauriSseRaw(raw.responseRaw, complete);
                if (!payload.usage && !complete) {
                    console.warn(`[agent-platform-billing] ${info.model} stream closed before any usageMetadata arrived; Google may still bill this request`);
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
            : ((Number(entry.timestampMs) || Date.now()) + (Number(entry.durationMs) || 0));
        const prevTs = records.at(-1)?.ts ?? 0;
        const ts = rawTs <= prevTs ? prevTs + 1 : rawTs;

        const rec = createRecord(info, payload, settings.pricing, { ts });
        records.push(rec);
        await saveLedger();

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

        let settingsChanged = false;
        if (savedSettings?.found && savedSettings.value && typeof savedSettings.value === 'object') {
            settings = {
                pricing: structuredClone(DEFAULT_PRICING),
                ...savedSettings.value,
            };
            if (!Array.isArray(savedSettings.value.knownDefaultModels)) delete settings.knownDefaultModels;
            settingsChanged = syncNewDefaultPricing(settings, DEFAULT_PRICING);
        }
        if (settingsChanged) await saveSettings();

        if (savedLedger?.found && Array.isArray(savedLedger.value)) {
            records = savedLedger.value;
            const repriced = priceUnpricedRecords(records, settings.pricing);
            if (repriced > 0) await saveLedger();
        }
        if (savedMeta?.found && typeof savedMeta.value?.lastLogId === 'number') {
            lastLogId = savedMeta.value.lastLogId;
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

    async function handle(endpoint, body = {}) {
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
                return { ...settings, defaultPricing: DEFAULT_PRICING, pricingUpdatedAt: PRICING_UPDATED_AT };
            }
            if (endpoint === '/settings/save') {
                const { pricing } = body || {};
                if (pricing !== undefined) {
                    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
                        throw new Error('pricing must be an object');
                    }
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
            if (typeof unsubscribe === 'function') {
                await unsubscribe();
                unsubscribe = null;
            }
        },
    };
}
