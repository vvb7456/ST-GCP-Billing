import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    CATALOG_SYNC_INTERVAL_MS,
    isGemini4Model,
    buildGemini4ThinkingConfig,
    fixVertexUrl,
    matchVertex,
    absorb,
    parseNonStreamBody,
    priceRecord,
    applyCatalogSync,
    recordOfflineUserEdits,
    fetchModelsDevCatalog,
    priceUnpricedRecords,
    createRecord,
    summarize,
} from './billing-core.js';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DATA_DIR = path.join(PLUGIN_DIR, 'data');
const DEFAULT_USER_HANDLE = 'default-user';
const USER_DATA_SUBDIR = 'agent-platform-billing';
const CATALOG_FETCH_TIMEOUT_MS = 15000;

const DEFAULT_SETTINGS = {
    pricing: {},
    upstreamPricing: {},
    knownDefaultModels: [],
    vertexModelGroups: [],
    catalogSource: null,
    catalogSyncedAt: null,
    migratedToModelsDev: false,
    stCompat: true,
};

// Extra hosts to treat as Agent Platform, only for pointing tests at a local mock server.
const TEST_HOSTS = (process.env.AGENT_PLATFORM_BILLING_TEST_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean);
const restoreFns = [];
const requestContext = new AsyncLocalStorage();
const userStates = new Map();
let stRoot = process.cwd();
let stFetch = globalThis.fetch;
let latestCatalog = null;
let syncInFlight = null;

function resolveStRoot() {
    const candidates = [process.cwd()];
    let dir = PLUGIN_DIR;
    for (let i = 0; i < 6; i++) {
        candidates.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'node_modules', 'node-fetch', 'src', 'index.js'))) {
            return root;
        }
    }
    return process.cwd();
}

function resolveDefaultUserDir() {
    if (process.env.AGENT_PLATFORM_BILLING_DATA_DIR) {
        return path.resolve(process.env.AGENT_PLATFORM_BILLING_DATA_DIR);
    }
    const dataRoot = globalThis.DATA_ROOT
        ? path.resolve(globalThis.DATA_ROOT)
        : path.join(stRoot, 'data');
    return path.join(dataRoot, DEFAULT_USER_HANDLE, USER_DATA_SUBDIR);
}

function resolveUserFromReq(req) {
    const handle = String(req?.user?.profile?.handle || DEFAULT_USER_HANDLE);
    const root = req?.user?.directories?.root;
    const dataDir = typeof root === 'string' && root.trim()
        ? path.resolve(root, USER_DATA_SUBDIR)
        : resolveDefaultUserDir();
    return { handle, dataDir };
}

function migrateLegacyDataIfNeeded(handle, dataDir) {
    if (handle !== DEFAULT_USER_HANDLE) return;
    if (path.resolve(dataDir) === path.resolve(LEGACY_DATA_DIR)) return;

    const legacySettings = path.join(LEGACY_DATA_DIR, 'settings.json');
    const legacyLedger = path.join(LEGACY_DATA_DIR, 'ledger.jsonl');
    const hasLegacySettings = fs.existsSync(legacySettings);
    const hasLegacyLedger = fs.existsSync(legacyLedger);
    if (!hasLegacySettings && !hasLegacyLedger) return;

    const targetSettings = path.join(dataDir, 'settings.json');
    const targetLedger = path.join(dataDir, 'ledger.jsonl');
    if (fs.existsSync(targetSettings) || fs.existsSync(targetLedger)) return;

    fs.mkdirSync(dataDir, { recursive: true });
    let migratedAny = false;
    for (const [src, dst] of [[legacySettings, targetSettings], [legacyLedger, targetLedger]]) {
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, dst);
        try {
            fs.renameSync(src, `${src}.migrated`);
        } catch (e) {
            console.warn(`[agent-platform-billing] migrated ${path.basename(src)} but could not mark legacy file:`, e.message);
        }
        migratedAny = true;
    }
    if (migratedAny) {
        console.info(`[agent-platform-billing] migrated legacy data from ${LEGACY_DATA_DIR} to ${dataDir}`);
    }
}

function saveUserSettings(state) {
    fs.mkdirSync(state.dataDir, { recursive: true });
    fs.writeFileSync(state.settingsFile, JSON.stringify(state.settings, null, 2));
}

function rewriteUserLedger(state) {
    fs.mkdirSync(state.dataDir, { recursive: true });
    const tmp = state.ledgerFile + '.tmp';
    fs.writeFileSync(tmp, state.records.map(r => JSON.stringify(r)).join('\n') + (state.records.length ? '\n' : ''));
    fs.renameSync(tmp, state.ledgerFile);
}

function applyCatalogToUser(state, catalog) {
    const result = applyCatalogSync(state.settings, catalog);
    saveUserSettings(state);
    const repriced = priceUnpricedRecords(state.records, state.settings.pricing);
    if (repriced > 0) rewriteUserLedger(state);
    return { ...result, repriced };
}

function getUserState(user) {
    const handle = user?.handle || DEFAULT_USER_HANDLE;
    const dataDir = path.resolve(user?.dataDir || resolveDefaultUserDir());
    let state = userStates.get(dataDir);
    if (state) return state;

    migrateLegacyDataIfNeeded(handle, dataDir);
    fs.mkdirSync(dataDir, { recursive: true });

    const settingsFile = path.join(dataDir, 'settings.json');
    const ledgerFile = path.join(dataDir, 'ledger.jsonl');
    let settings = structuredClone(DEFAULT_SETTINGS);
    if (fs.existsSync(settingsFile)) {
        try {
            const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
        } catch (e) {
            console.error(`[agent-platform-billing] [${handle}] settings.json is corrupted, using empty defaults:`, e.message);
        }
    }

    const records = [];
    if (fs.existsSync(ledgerFile)) {
        for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line)); } catch { /* skip torn line from a crash mid-write */ }
        }
    }

    state = { handle, dataDir, settingsFile, ledgerFile, settings, records };
    userStates.set(dataDir, state);

    const repriced = priceUnpricedRecords(state.records, state.settings.pricing);
    if (repriced > 0) {
        rewriteUserLedger(state);
        console.info(`[agent-platform-billing] [${handle}] auto-priced ${repriced} previously unpriced record(s)`);
    }

    if (
        latestCatalog
        && (
            !state.settings.migratedToModelsDev
            || !state.settings.catalogSyncedAt
            || (Date.now() - state.settings.catalogSyncedAt >= CATALOG_SYNC_INTERVAL_MS)
        )
    ) {
        applyCatalogToUser(state, latestCatalog);
    }

    return state;
}

function getCurrentUserState() {
    return getUserState(requestContext.getStore()?.user);
}

async function fetchAttemptWithTimeout(url, options, timeoutMs = CATALOG_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await stFetch(url, { ...options, signal: controller.signal });
        // Consume the response body while the timeout is still active so stalled downloads abort and can fall back.
        const bodyText = await res.text();
        return {
            ok: res.ok,
            status: res.status,
            json: async () => JSON.parse(bodyText),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchWithEnvProxyFallback(url, options) {
    try {
        return await fetchAttemptWithTimeout(url, options);
    } catch (firstErr) {
        const hasEnvProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
        if (!hasEnvProxy) throw firstErr;
        try {
            const proxyAgentEntry = path.join(stRoot, 'node_modules', 'proxy-agent', 'dist', 'index.js');
            const { ProxyAgent } = await import(pathToFileURL(fs.realpathSync(proxyAgentEntry)).href);
            // Use a fresh AbortController so a timeout on direct connect never aborts the proxy fallback immediately.
            return await fetchAttemptWithTimeout(url, { ...options, agent: new ProxyAgent() });
        } catch {
            throw firstErr;
        }
    }
}

async function syncCatalogFromModelsDev(targetState = null) {
    if (!syncInFlight) {
        syncInFlight = (async () => {
            // Use ST's node-fetch instance so requests honor ST's requestProxy, falling back to env proxy with an independent timeout.
            const catalog = await fetchModelsDevCatalog({ fetchImpl: fetchWithEnvProxyFallback, timeoutMs: 0 });
            latestCatalog = catalog;

            let totalAdded = 0;
            let totalUpdated = 0;
            let totalRepriced = 0;
            const results = new Map();
            for (const state of userStates.values()) {
                const res = applyCatalogToUser(state, catalog);
                results.set(state, res);
                totalAdded += res.added;
                totalUpdated += res.updated;
                totalRepriced += res.repriced;
            }
            console.info(`[agent-platform-billing] synced catalog from ${catalog.source}: ${catalog.modelCount} model(s) across ${userStates.size} loaded user(s), +${totalAdded} added, ${totalUpdated} updated, ${totalRepriced} repriced`);
            return { catalog, results };
        })().finally(() => {
            syncInFlight = null;
        });
    }

    const { catalog, results } = await syncInFlight;
    if (targetState) {
        const res = results.get(targetState) || applyCatalogToUser(targetState, catalog);
        return {
            ok: true,
            source: catalog.source,
            syncedAt: targetState.settings.catalogSyncedAt,
            modelCount: catalog.modelCount,
            added: res.added,
            updated: res.updated,
            migrated: res.migrated,
            repriced: res.repriced,
        };
    }
    return {
        ok: true,
        source: catalog.source,
        syncedAt: Date.now(),
        modelCount: catalog.modelCount,
        added: 0,
        updated: 0,
        migrated: false,
        repriced: 0,
    };
}

function triggerBackgroundSync() {
    if (process.env.AGENT_PLATFORM_BILLING_DISABLE_AUTO_SYNC === '1') return;
    if (syncInFlight) return;
    syncCatalogFromModelsDev().catch((e) => {
        console.warn('[agent-platform-billing] models.dev catalog sync failed:', e.message);
    });
}

function scheduleCatalogSync() {
    if (process.env.AGENT_PLATFORM_BILLING_DISABLE_AUTO_SYNC === '1') return;
    // Defer briefly so ST finishes initRequestProxy() before our first outbound sync request.
    const bootTimer = setTimeout(() => {
        triggerBackgroundSync();
    }, 1500);
    bootTimer.unref?.();
    restoreFns.push(() => clearTimeout(bootTimer));

    const timer = setInterval(() => {
        triggerBackgroundSync();
    }, CATALOG_SYNC_INTERVAL_MS);
    timer.unref?.();
    restoreFns.push(() => clearInterval(timer));
}

function recordForUser(state, info, payload) {
    const usage = payload.usage;
    if (!usage) {
        console.warn(`[agent-platform-billing] [${state.handle}] ${info.model} ${info.method}: response has no usageMetadata (complete=${payload.complete})`);
    }
    const rec = createRecord(info, payload, state.settings.pricing);
    state.records.push(rec);
    try {
        fs.mkdirSync(state.dataDir, { recursive: true });
        fs.appendFileSync(state.ledgerFile, JSON.stringify(rec) + '\n');
    } catch (e) {
        console.error(`[agent-platform-billing] [${state.handle}] failed to append ledger:`, e.message);
    }
    const c = rec.cost ? `$${rec.cost.total.toFixed(6)}` : '未定价';
    console.info(`[agent-platform-billing] [${state.handle}] ${rec.model} in=${usage?.promptTokenCount ?? '-'} out=${usage?.candidatesTokenCount ?? '-'} think=${usage?.thoughtsTokenCount ?? 0} cached=${usage?.cachedContentTokenCount ?? 0} cost=${c}${rec.complete ? '' : ' (incomplete)'}`);
}

function tapSseStream(stream, info, state) {
    const decoder = new TextDecoder();
    const acc = { complete: false };
    let buffer = '';
    let done = false;

    const handleEvent = (block) => {
        const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        try { absorb(acc, JSON.parse(data)); } catch { /* non-JSON keepalive */ }
    };
    const drain = (final) => {
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = final ? '' : parts.pop();
        for (const p of parts) handleEvent(p);
    };
    const finish = (complete) => {
        if (done) return;
        done = true;
        buffer += decoder.decode();
        drain(true);
        acc.complete = complete;
        if (acc.usage || complete) recordForUser(state, info, acc);
        else console.warn(`[agent-platform-billing] [${state.handle}] ${info.model} stream closed before any usageMetadata arrived; Google may still bill this request`);
    };

    stream.on('data', (chunk) => {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        drain(false);
    });
    stream.on('end', () => finish(true));
    stream.on('error', () => finish(false));
    stream.on('close', () => finish(false));
}

function isPotentialVertexUrl(urlString) {
    if (!urlString) return false;
    return Boolean(matchVertex(urlString, TEST_HOSTS) || matchVertex(fixVertexUrl(urlString).url, TEST_HOSTS));
}

function effectiveVertexInfo(urlString, state) {
    const targetUrl = state.settings.stCompat !== false ? fixVertexUrl(urlString).url : urlString;
    return matchVertex(targetUrl, TEST_HOSTS);
}

/**
 * Buffers an outgoing Gemini 4 JSON POST request and injects `generationConfig.thinkingConfig`
 * only when upstream SillyTavern has not already set it.
 */
function patchGemini4ClientRequest(clientReq, model, genCtx) {
    const origWrite = clientReq.write;
    const origEnd = clientReq.end;
    const chunks = [];

    const pushChunk = (chunk, encoding) => {
        if (chunk == null) return;
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
    };

    clientReq.write = function patchedWrite(chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        pushChunk(chunk, encoding);
        if (typeof cb === 'function') process.nextTick(cb);
        return true;
    };

    clientReq.end = function patchedEnd(chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
        else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
        pushChunk(chunk, encoding);

        const rawBuf = Buffer.concat(chunks);
        let outBuf = rawBuf;
        try {
            const parsed = JSON.parse(rawBuf.toString('utf8'));
            if (parsed && typeof parsed === 'object' && !parsed.generationConfig?.thinkingConfig) {
                parsed.generationConfig = {
                    ...(parsed.generationConfig || {}),
                    thinkingConfig: buildGemini4ThinkingConfig(model, genCtx),
                };
                outBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
                clientReq.setHeader('Content-Length', outBuf.length);
            }
        } catch (e) {
            console.error('[agent-platform-billing] failed to inject Gemini 4 thinkingConfig:', e.message);
        }

        clientReq.write = origWrite;
        clientReq.end = origEnd;
        return origEnd.call(this, outBuf, cb);
    };
}

function stripHostHeader(options) {
    if (!options || typeof options !== 'object' || !options.headers || typeof options.headers !== 'object') return options;
    const nextHeaders = {};
    let stripped = false;
    for (const [k, v] of Object.entries(options.headers)) {
        if (k.toLowerCase() === 'host') { stripped = true; continue; }
        nextHeaders[k] = v;
    }
    return stripped ? { ...options, headers: nextHeaders } : options;
}

/**
 * Installs SillyTavern compatibility & user-context hooks for Vertex AI without touching ST's source files:
 * 1. Captures `req.user` (for multi-user billing isolation) and `include_reasoning` / `reasoning_effort` per-request via AsyncLocalStorage.
 * 2. Rewrites broken non-global / multi-region (`us`/`eu`) / Express Vertex AI hostnames on outbound requests.
 * 3. Injects `thinkingConfig` for Gemini 4 models when ST omits it (auto-yields if upstream ST adds support).
 */
function installCompatHooks(router) {
    const routerProto = Object.getPrototypeOf(router);
    if (routerProto && typeof routerProto.handle === 'function') {
        const origHandle = routerProto.handle;
        routerProto.handle = function patchedRouterHandle(req, res, out) {
            const existing = requestContext.getStore();
            const hasReqUser = Boolean(req?.user?.directories?.root || req?.user?.profile?.handle);
            const needUser = hasReqUser && !existing?.user;

            const isVertexGenerate = !existing?.generate
                && req?.method === 'POST'
                && req?.body?.chat_completion_source === 'vertexai'
                && typeof req.originalUrl === 'string'
                && req.originalUrl.split('?')[0].endsWith('/api/backends/chat-completions/generate');

            if (needUser || isVertexGenerate) {
                const nextStore = { ...(existing || {}) };
                if (needUser) {
                    nextStore.user = resolveUserFromReq(req);
                }
                if (isVertexGenerate) {
                    nextStore.generate = {
                        model: req.body.model,
                        includeReasoning: Boolean(req.body.include_reasoning),
                        reasoningEffort: req.body.reasoning_effort,
                    };
                }
                return requestContext.run(nextStore, () => origHandle.call(this, req, res, out));
            }
            return origHandle.call(this, req, res, out);
        };
        restoreFns.push(() => { routerProto.handle = origHandle; });
    }

    const wrapTransport = (mod) => {
        const origRequest = mod.request;
        mod.request = function patchedRequest(...args) {
            if (typeof args[0] === 'string' || args[0] instanceof URL) {
                let urlStr = String(args[0]);
                const fixed = fixVertexUrl(urlStr);
                const store = requestContext.getStore();
                const genCtx = store?.generate;
                const matched = genCtx ? matchVertex(fixed.changed ? fixed.url : urlStr, TEST_HOSTS) : null;
                const needGemini4Patch = Boolean(genCtx && matched && isGemini4Model(matched.model));

                // Skip loading user state for unrelated outbound requests (such as models.dev catalog sync).
                if (fixed.changed || needGemini4Patch) {
                    const userState = getUserState(store?.user);
                    if (userState.settings.stCompat !== false) {
                        if (fixed.changed) {
                            urlStr = fixed.url;
                            args[0] = args[0] instanceof URL ? new URL(fixed.url) : fixed.url;
                            if (args[1] && typeof args[1] === 'object') args[1] = stripHostHeader(args[1]);
                            console.info(`[agent-platform-billing] fixed Vertex endpoint: ${fixed.from} -> ${fixed.to}`);
                        }
                        if (needGemini4Patch) {
                            const clientReq = origRequest.apply(this, args);
                            patchGemini4ClientRequest(clientReq, matched.model, genCtx);
                            return clientReq;
                        }
                    }
                }
            }
            return origRequest.apply(this, args);
        };
        restoreFns.push(() => { mod.request = origRequest; });
    };

    wrapTransport(https);
    wrapTransport(http);
}

/**
 * ST's backend calls Vertex via node-fetch and, for non-stream requests, discards usageMetadata before replying
 * to the browser. Wrapping node-fetch's Response at the prototype level observes the raw upstream payload
 * without touching ST's source. The plugin must import the exact node-fetch instance ST uses, hence resolving
 * from ST's server directory rather than relative to a symlinked copy.
 */
async function installHooks() {
    const nodeFetchEntry = path.join(stRoot, 'node_modules', 'node-fetch', 'src', 'index.js');
    const mod = await import(pathToFileURL(fs.realpathSync(nodeFetchEntry)).href);
    if (typeof mod.default === 'function') stFetch = mod.default;
    const Response = mod.Response;
    const bodyProto = Object.getPrototypeOf(Response.prototype);

    const origText = bodyProto.text;
    const ownText = Object.getOwnPropertyDescriptor(Response.prototype, 'text');
    Object.defineProperty(Response.prototype, 'text', {
        configurable: true,
        writable: true,
        value: async function text() {
            const isVertex = this.ok && isPotentialVertexUrl(this.url);
            const userState = isVertex ? getCurrentUserState() : null;
            const result = await origText.call(this);
            try {
                if (userState) {
                    const info = effectiveVertexInfo(this.url, userState);
                    if (info && info.method === 'generateContent') recordForUser(userState, info, parseNonStreamBody(result));
                }
            } catch (e) {
                console.error('[agent-platform-billing] failed to parse non-stream response:', e.message);
            }
            return result;
        },
    });
    restoreFns.push(() => {
        if (ownText) Object.defineProperty(Response.prototype, 'text', ownText);
        else delete Response.prototype.text;
    });

    const bodyDesc = Object.getOwnPropertyDescriptor(bodyProto, 'body');
    const ownBody = Object.getOwnPropertyDescriptor(Response.prototype, 'body');
    const tapped = new WeakSet();
    Object.defineProperty(Response.prototype, 'body', {
        configurable: true,
        enumerable: true,
        get() {
            const stream = bodyDesc.get.call(this);
            try {
                if (stream && this.ok && !tapped.has(stream) && typeof stream.on === 'function' && isPotentialVertexUrl(this.url)) {
                    const userState = getCurrentUserState();
                    const info = effectiveVertexInfo(this.url, userState);
                    if (info && info.method === 'streamGenerateContent') {
                        tapped.add(stream);
                        tapSseStream(stream, info, userState);
                    }
                }
            } catch (e) {
                console.error('[agent-platform-billing] failed to tap stream:', e.message);
            }
            return stream;
        },
    });
    restoreFns.push(() => {
        if (ownBody) Object.defineProperty(Response.prototype, 'body', ownBody);
        else delete Response.prototype.body;
    });
}

export const info = {
    id: 'agent-platform-billing',
    name: 'Agent Platform 助手',
    description: 'SillyTavern Agent Platform 用量统计、Gemini 4 与区域端点兼容服务端插件',
};

export async function init(router) {
    stRoot = resolveStRoot();
    installCompatHooks(router);
    await installHooks();
    scheduleCatalogSync();
    console.info('[agent-platform-billing] hooks installed (multi-user storage enabled)');

    router.post('/summary', (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        const since = Number(req.body?.since) || 0;
        const todaySince = Number(req.body?.todaySince) || 0;
        res.json({
            ...summarize(state.records, since, todaySince),
            latest: state.records.slice(-20),
            lastTs: state.records.at(-1)?.ts ?? 0,
        });
    });

    router.post('/records', (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        const limit = Math.min(Number(req.body?.limit) || 100, 1000);
        res.json({ items: state.records.slice(-limit).reverse(), total: state.records.length });
    });

    router.post('/settings/get', (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        if (!state.settings.catalogSyncedAt && process.env.AGENT_PLATFORM_BILLING_DISABLE_AUTO_SYNC !== '1') {
            if (latestCatalog) {
                applyCatalogToUser(state, latestCatalog);
            } else {
                triggerBackgroundSync();
            }
        }
        res.json({
            ...state.settings,
            defaultPricing: state.settings.upstreamPricing || {},
            vertexCompatModelGroups: state.settings.vertexModelGroups || [],
            catalogSyncing: Boolean(syncInFlight),
        });
    });

    router.post('/catalog/sync', async (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        try {
            res.json(await syncCatalogFromModelsDev(state));
        } catch (e) {
            console.warn('[agent-platform-billing] manual catalog sync failed:', e.message);
            res.status(502).json({ error: e.message });
        }
    });

    router.post('/settings/save', (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        const { pricing, stCompat } = req.body || {};
        if (pricing !== undefined) {
            if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
                return res.status(400).json({ error: 'pricing must be an object' });
            }
            recordOfflineUserEdits(state.settings, pricing);
            state.settings.pricing = pricing;
        }
        if (stCompat !== undefined) {
            state.settings.stCompat = Boolean(stCompat);
        }
        saveUserSettings(state);
        res.json({ ok: true });
    });

    router.post('/recalculate', (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        state.records.forEach(r => priceRecord(r, state.settings.pricing));
        rewriteUserLedger(state);
        res.json({ ok: true, count: state.records.length });
    });

    router.post('/reset', (req, res) => {
        const state = getUserState(resolveUserFromReq(req));
        state.records = [];
        rewriteUserLedger(state);
        res.json({ ok: true });
    });
}

export async function exit() {
    while (restoreFns.length) restoreFns.pop()();
    userStates.clear();
    latestCatalog = null;
    syncInFlight = null;
}
