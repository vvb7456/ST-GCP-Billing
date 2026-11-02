import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRICING, findPrice, calculateCost } from './pricing.mjs';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(PLUGIN_DIR, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.jsonl');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
    pricing: DEFAULT_PRICING,
};

let settings = structuredClone(DEFAULT_SETTINGS);
let records = [];
// Extra hosts to treat as Agent Platform, only for pointing tests at a local mock server.
const TEST_HOSTS = (process.env.AGENT_PLATFORM_BILLING_TEST_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean);
const restoreFns = [];

const VERTEX_PATH = /\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/[^/]+\/models\/([^/:]+):(streamGenerateContent|generateContent)$|\/publishers\/[^/]+\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

/** Express-mode URLs carry no /locations/ segment; the region is encoded in the hostname instead. */
function locationFromHost(hostname) {
    if (hostname === 'aiplatform.googleapis.com') return 'global';
    const m = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(hostname);
    return m ? m[1] : null;
}

/** Service endpoints ST can call: global `aiplatform.googleapis.com` and regional `{region}-aiplatform.googleapis.com`. */
function isAgentPlatformHost(hostname) {
    return hostname === 'aiplatform.googleapis.com'
        || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(hostname)
        || TEST_HOSTS.includes(hostname);
}

function matchVertex(urlString) {
    try {
        const url = new URL(urlString);
        if (!isAgentPlatformHost(url.hostname)) return null;
        const m = VERTEX_PATH.exec(url.pathname);
        if (!m) return null;
        return m[1]
            ? { project: decodeURIComponent(m[1]), location: m[2], model: decodeURIComponent(m[3]), method: m[4] }
            : { project: null, location: locationFromHost(url.hostname), model: decodeURIComponent(m[5]), method: m[6] };
    } catch {
        return null;
    }
}

function loadState() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
        } catch (e) {
            console.error('[agent-platform-billing] settings.json is corrupted, using defaults:', e.message);
        }
    }
    records = [];
    if (fs.existsSync(LEDGER_FILE)) {
        for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { records.push(JSON.parse(line)); } catch { /* skip torn line from a crash mid-write */ }
        }
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

function priceRecord(record) {
    const hit = findPrice(settings.pricing, record.model);
    const cost = hit ? calculateCost(record.usage, hit.price, { ts: record.ts, location: record.location }) : null;
    record.priceKey = hit?.key ?? null;
    record.cost = cost;
    return record;
}

function record(info, payload) {
    const usage = payload.usage;
    if (!usage) {
        console.warn(`[agent-platform-billing] ${info.model} ${info.method}: response has no usageMetadata (complete=${payload.complete})`);
    }
    const rec = priceRecord({
        id: crypto.randomUUID(),
        ts: Date.now(),
        model: info.model,
        modelVersion: payload.modelVersion ?? null,
        project: info.project,
        location: info.location,
        stream: info.method === 'streamGenerateContent',
        complete: payload.complete,
        responseId: payload.responseId ?? null,
        trafficType: usage?.trafficType ?? null,
        grounded: payload.grounded || false,
        searchQueries: payload.searchQueries || 0,
        usage: usage ?? null,
    });
    records.push(rec);
    try {
        fs.appendFileSync(LEDGER_FILE, JSON.stringify(rec) + '\n');
    } catch (e) {
        console.error('[agent-platform-billing] failed to append ledger:', e.message);
    }
    const c = rec.cost ? `$${rec.cost.total.toFixed(6)}` : '未定价';
    console.info(`[agent-platform-billing] ${rec.model} in=${usage?.promptTokenCount ?? '-'} out=${usage?.candidatesTokenCount ?? '-'} think=${usage?.thoughtsTokenCount ?? 0} cached=${usage?.cachedContentTokenCount ?? 0} cost=${c}${rec.complete ? '' : ' (incomplete)'}`);
}

/** Folds one GenerateContentResponse (or stream chunk) into the accumulator. Last usageMetadata wins: Vertex reports cumulative totals. */
function absorb(acc, obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.usageMetadata) acc.usage = obj.usageMetadata;
    if (obj.modelVersion) acc.modelVersion = obj.modelVersion;
    if (obj.responseId) acc.responseId = obj.responseId;
    for (const c of Array.isArray(obj.candidates) ? obj.candidates : []) {
        const g = c?.groundingMetadata;
        if (g) {
            acc.grounded = true;
            if (Array.isArray(g.webSearchQueries)) acc.searchQueries = Math.max(acc.searchQueries || 0, g.webSearchQueries.length);
        }
    }
}

function parseNonStreamBody(text) {
    const acc = { complete: true };
    const parsed = JSON.parse(text);
    for (const obj of Array.isArray(parsed) ? parsed : [parsed]) absorb(acc, obj);
    return acc;
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
                    const info = matchVertex(this.url);
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
                    const info = matchVertex(this.url);
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

function sumInto(bucket, rec) {
    const u = rec.usage || {};
    bucket.requests += 1;
    bucket.promptTokens += u.promptTokenCount || 0;
    bucket.cachedTokens += u.cachedContentTokenCount || 0;
    bucket.toolUseTokens += u.toolUsePromptTokenCount || 0;
    bucket.outputTokens += u.candidatesTokenCount || 0;
    bucket.thoughtsTokens += u.thoughtsTokenCount || 0;
    bucket.totalTokens += u.totalTokenCount || 0;
    if (rec.cost) bucket.cost += rec.cost.total;
    else bucket.unpriced += 1;
    if (!rec.complete) bucket.incomplete += 1;
    if (rec.grounded) bucket.grounded += 1;
}

const emptyBucket = () => ({
    requests: 0, promptTokens: 0, cachedTokens: 0, toolUseTokens: 0, outputTokens: 0,
    thoughtsTokens: 0, totalTokens: 0, cost: 0, unpriced: 0, incomplete: 0, grounded: 0,
});

function summarize(since, todaySince) {
    const total = emptyBucket();
    const period = emptyBucket();
    const today = emptyBucket();
    const byModel = {};
    const unpricedModels = new Set();
    for (const rec of records) {
        sumInto(total, rec);
        if (!rec.cost) unpricedModels.add(rec.model);
        if (todaySince && rec.ts >= todaySince) sumInto(today, rec);
        if (rec.ts >= since) {
            sumInto(period, rec);
            sumInto(byModel[rec.model] ??= emptyBucket(), rec);
        }
    }
    return { total, period, today, byModel, unpricedModels: [...unpricedModels], firstTs: records[0]?.ts ?? null };
}

export const info = {
    id: 'agent-platform-billing',
    name: 'Agent Platform 费用统计',
    description: 'Records exact Agent Platform (Vertex AI) token usage from upstream usageMetadata and computes cost.',
};

export async function init(router) {
    loadState();
    await installHooks();
    console.info(`[agent-platform-billing] hooks installed, ${records.length} record(s) loaded`);

    router.post('/summary', (req, res) => {
        const since = Number(req.body?.since) || 0;
        const todaySince = Number(req.body?.todaySince) || 0;
        const after = Number(req.body?.afterTs) || 0;
        res.json({
            ...summarize(since, todaySince),
            latest: records.filter(r => r.ts > after).slice(-20),
            lastTs: records.at(-1)?.ts ?? 0,
        });
    });

    router.post('/records', (req, res) => {
        const limit = Math.min(Number(req.body?.limit) || 100, 1000);
        res.json({ items: records.slice(-limit).reverse(), total: records.length });
    });

    router.post('/settings/get', (_req, res) => {
        res.json({ ...settings, defaultPricing: DEFAULT_PRICING });
    });

    router.post('/settings/save', (req, res) => {
        const { pricing } = req.body || {};
        if (pricing !== undefined) {
            if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
                return res.status(400).json({ error: 'pricing must be an object' });
            }
            settings.pricing = pricing;
        }
        saveSettings();
        res.json({ ok: true });
    });

    router.post('/recalculate', (_req, res) => {
        records.forEach(priceRecord);
        rewriteLedger();
        res.json({ ok: true, count: records.length });
    });

    router.post('/reset', (_req, res) => {
        if (fs.existsSync(LEDGER_FILE) && records.length) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.renameSync(LEDGER_FILE, path.join(DATA_DIR, `ledger-${stamp}.jsonl.bak`));
        }
        records = [];
        res.json({ ok: true });
    });
}

export async function exit() {
    while (restoreFns.length) restoreFns.pop()();
}

