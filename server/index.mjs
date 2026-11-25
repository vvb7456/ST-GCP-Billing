import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRICING, PRICING_UPDATED_AT } from './pricing.js';
import {
    GEMINI_4_MODELS,
    isGemini4Model,
    buildGemini4ThinkingConfig,
    fixVertexUrl,
    matchVertex,
    absorb,
    parseNonStreamBody,
    priceRecord,
    syncNewDefaultPricing,
    priceUnpricedRecords,
    createRecord,
    summarize,
} from './billing-core.js';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(PLUGIN_DIR, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.jsonl');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
    pricing: DEFAULT_PRICING,
    knownDefaultModels: Object.keys(DEFAULT_PRICING),
    stCompat: true,
};

let settings = structuredClone(DEFAULT_SETTINGS);
let records = [];
// Extra hosts to treat as Agent Platform, only for pointing tests at a local mock server.
const TEST_HOSTS = (process.env.AGENT_PLATFORM_BILLING_TEST_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean);
const restoreFns = [];
const generateContext = new AsyncLocalStorage();

function loadState() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let settingsChanged = false;
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
            if (!Array.isArray(saved.knownDefaultModels)) delete settings.knownDefaultModels;
            settingsChanged = syncNewDefaultPricing(settings, DEFAULT_PRICING);
        } catch (e) {
            console.error('[agent-platform-billing] settings.json is corrupted, using defaults:', e.message);
        }
    }
    if (settingsChanged) saveSettings();

    records = [];
    if (fs.existsSync(LEDGER_FILE)) {
        for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line)); } catch { /* skip torn line from a crash mid-write */ }
        }
    }
    const repriced = priceUnpricedRecords(records, settings.pricing);
    if (repriced > 0) {
        rewriteLedger();
        console.info(`[agent-platform-billing] auto-priced ${repriced} previously unpriced record(s)`);
    }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function rewriteLedger() {
    const tmp = LEDGER_FILE + '.tmp';
    fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    fs.renameSync(tmp, LEDGER_FILE);
}

function record(info, payload) {
    const usage = payload.usage;
    if (!usage) {
        console.warn(`[agent-platform-billing] ${info.model} ${info.method}: response has no usageMetadata (complete=${payload.complete})`);
    }
    const rec = createRecord(info, payload, settings.pricing);
    records.push(rec);
    try {
        fs.appendFileSync(LEDGER_FILE, JSON.stringify(rec) + '\n');
    } catch (e) {
        console.error('[agent-platform-billing] failed to append ledger:', e.message);
    }
    const c = rec.cost ? `$${rec.cost.total.toFixed(6)}` : '未定价';
    console.info(`[agent-platform-billing] ${rec.model} in=${usage?.promptTokenCount ?? '-'} out=${usage?.candidatesTokenCount ?? '-'} think=${usage?.thoughtsTokenCount ?? 0} cached=${usage?.cachedContentTokenCount ?? 0} cost=${c}${rec.complete ? '' : ' (incomplete)'}`);
}

function tapSseStream(stream, info) {
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
        if (acc.usage || complete) record(info, acc);
        else console.warn(`[agent-platform-billing] ${info.model} stream closed before any usageMetadata arrived; Google may still bill this request`);
    };

    stream.on('data', (chunk) => {
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        drain(false);
    });
    stream.on('end', () => finish(true));
    stream.on('error', () => finish(false));
    stream.on('close', () => finish(false));
}

function effectiveVertexInfo(urlString) {
    const targetUrl = settings.stCompat !== false ? fixVertexUrl(urlString).url : urlString;
    return matchVertex(targetUrl, TEST_HOSTS);
}

/**
 * Buffers an outgoing Gemini 4 JSON POST request and injects `generationConfig.thinkingConfig`
 * only when upstream SillyTavern has not already set it.
 */
function patchGemini4ClientRequest(clientReq, model, ctx) {
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
                    thinkingConfig: buildGemini4ThinkingConfig(model, ctx),
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
 * Installs SillyTavern compatibility hooks for Vertex AI without touching ST's source files:
 * 1. Captures incoming `include_reasoning` and `reasoning_effort` per-request via AsyncLocalStorage.
 * 2. Rewrites broken non-global / multi-region (`us`/`eu`) / Express Vertex AI hostnames on outbound requests.
 * 3. Injects `thinkingConfig` for Gemini 4 models when ST omits it (auto-yields if upstream ST adds support).
 */
function installCompatHooks(router) {
    const routerProto = Object.getPrototypeOf(router);
    if (routerProto && typeof routerProto.handle === 'function') {
        const origHandle = routerProto.handle;
        routerProto.handle = function patchedRouterHandle(req, res, out) {
            if (
                settings.stCompat !== false
                && !generateContext.getStore()
                && req?.method === 'POST'
                && req?.body?.chat_completion_source === 'vertexai'
                && typeof req.originalUrl === 'string'
                && req.originalUrl.split('?')[0].endsWith('/api/backends/chat-completions/generate')
            ) {
                const store = {
                    model: req.body.model,
                    includeReasoning: Boolean(req.body.include_reasoning),
                    reasoningEffort: req.body.reasoning_effort,
                };
                return generateContext.run(store, () => origHandle.call(this, req, res, out));
            }
            return origHandle.call(this, req, res, out);
        };
        restoreFns.push(() => { routerProto.handle = origHandle; });
    }

    const wrapTransport = (mod) => {
        const origRequest = mod.request;
        mod.request = function patchedRequest(...args) {
            if (settings.stCompat !== false && (typeof args[0] === 'string' || args[0] instanceof URL)) {
                let urlStr = String(args[0]);
                const fixed = fixVertexUrl(urlStr);
                if (fixed.changed) {
                    urlStr = fixed.url;
                    args[0] = args[0] instanceof URL ? new URL(fixed.url) : fixed.url;
                    if (args[1] && typeof args[1] === 'object') args[1] = stripHostHeader(args[1]);
                    console.info(`[agent-platform-billing] fixed Vertex endpoint: ${fixed.from} -> ${fixed.to}`);
                }

                const ctx = generateContext.getStore();
                const info = ctx ? matchVertex(urlStr, TEST_HOSTS) : null;
                if (ctx && info && isGemini4Model(info.model)) {
                    const clientReq = origRequest.apply(this, args);
                    patchGemini4ClientRequest(clientReq, info.model, ctx);
                    return clientReq;
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
 * from ST's server directory (process.cwd()) rather than relative to this (possibly symlinked) file.
 */
async function installHooks() {
    const nodeFetchEntry = path.join(process.cwd(), 'node_modules', 'node-fetch', 'src', 'index.js');
    const mod = await import(new URL('file://' + fs.realpathSync(nodeFetchEntry)).href);
    const Response = mod.Response;
    const bodyProto = Object.getPrototypeOf(Response.prototype);

    const origText = bodyProto.text;
    const ownText = Object.getOwnPropertyDescriptor(Response.prototype, 'text');
    Object.defineProperty(Response.prototype, 'text', {
        configurable: true,
        writable: true,
        value: async function text() {
            const result = await origText.call(this);
            try {
                if (this.ok) {
                    const info = effectiveVertexInfo(this.url);
                    if (info && info.method === 'generateContent') record(info, parseNonStreamBody(result));
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
                if (stream && this.ok && !tapped.has(stream) && typeof stream.on === 'function') {
                    const info = effectiveVertexInfo(this.url);
                    if (info && info.method === 'streamGenerateContent') {
                        tapped.add(stream);
                        tapSseStream(stream, info);
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
    loadState();
    installCompatHooks(router);
    await installHooks();
    console.info(`[agent-platform-billing] hooks installed, ${records.length} record(s) loaded`);

    router.post('/summary', (req, res) => {
        const since = Number(req.body?.since) || 0;
        const todaySince = Number(req.body?.todaySince) || 0;
        res.json({
            ...summarize(records, since, todaySince),
            latest: records.slice(-20),
            lastTs: records.at(-1)?.ts ?? 0,
        });
    });

    router.post('/records', (req, res) => {
        const limit = Math.min(Number(req.body?.limit) || 100, 1000);
        res.json({ items: records.slice(-limit).reverse(), total: records.length });
    });

    router.post('/settings/get', (_req, res) => {
        res.json({
            ...settings,
            defaultPricing: DEFAULT_PRICING,
            pricingUpdatedAt: PRICING_UPDATED_AT,
            gemini4Models: GEMINI_4_MODELS,
        });
    });

    router.post('/settings/save', (req, res) => {
        const { pricing, stCompat } = req.body || {};
        if (pricing !== undefined) {
            if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
                return res.status(400).json({ error: 'pricing must be an object' });
            }
            settings.pricing = pricing;
        }
        if (stCompat !== undefined) {
            settings.stCompat = Boolean(stCompat);
        }
        saveSettings();
        res.json({ ok: true });
    });

    router.post('/recalculate', (_req, res) => {
        records.forEach(r => priceRecord(r, settings.pricing));
        rewriteLedger();
        res.json({ ok: true, count: records.length });
    });

    router.post('/reset', (_req, res) => {
        records = [];
        rewriteLedger();
        res.json({ ok: true });
    });
}

export async function exit() {
    while (restoreFns.length) restoreFns.pop()();
}
