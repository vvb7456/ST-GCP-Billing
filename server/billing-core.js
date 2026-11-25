// Pure runtime-agnostic billing helpers shared by the SillyTavern server plugin and the TauriTavern frontend adapter.
import { findPrice, calculateCost } from './pricing.js';

export const GEMINI_4_MODELS = [
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-4-carbon',
    'gemini-4-argon',
];

const VERTEX_PATH = /\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/[^/]+\/models\/([^/:]+):(streamGenerateContent|generateContent)$|\/publishers\/[^/]+\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;
const PROJECT_LOCATION_PATH = /\/projects\/([^/]+)\/locations\/([^/]+)/;
const TAURI_GEMINI_ENDPOINT_SUFFIX = /(?:\/|:)(streamGenerateContent|generateContent)$/i;
const GOOGLE_AGENT_PLATFORM_HOST = /^(?:aiplatform\.googleapis\.com|[a-z0-9-]+-aiplatform\.googleapis\.com|aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com)$/;
const GEMINI_4_MODEL_RE = /^gemini-4(?:\.\d+)?-/i;
const GEMINI_4_XHIGH_RE = /^gemini-4(?:\.\d+)?-(?:neon|hydrogen)(?:$|[-@])/i;

export function isGemini4Model(model) {
    return GEMINI_4_MODEL_RE.test(String(model || '').trim());
}

/**
 * Maps SillyTavern's `reasoning_effort` to a valid Vertex AI Gemini 4 `thinkingLevel`.
 * - Neon & Hydrogen support LOW, MEDIUM, HIGH (default), XHIGH.
 * - Carbon & Argon support LOW, MEDIUM (default), HIGH.
 * - All Gemini 4 models reject `MINIMAL` and `thinkingBudget` with HTTP 400.
 */
export function resolveGemini4ThinkingLevel(model, reasoningEffort) {
    const effort = String(reasoningEffort || '').trim().toLowerCase();
    if (!effort || effort === 'auto') return null;
    const supportsXHigh = GEMINI_4_XHIGH_RE.test(String(model || '').trim());
    switch (effort) {
        case 'min':
        case 'minimum':
        case 'minimal':
        case 'low':
            return 'low';
        case 'medium':
            return 'medium';
        case 'high':
            return 'high';
        case 'xhigh':
        case 'max':
        case 'maximum':
            return supportsXHigh ? 'xhigh' : 'high';
        default:
            return null;
    }
}

export function buildGemini4ThinkingConfig(model, { includeReasoning = false, reasoningEffort = 'auto' } = {}) {
    const config = { includeThoughts: Boolean(includeReasoning) };
    const level = resolveGemini4ThinkingLevel(model, reasoningEffort);
    if (level) config.thinkingLevel = level;
    return config;
}

/**
 * Fixes upstream SillyTavern Vertex AI hostname bugs (only for genuine Google *.googleapis.com hosts):
 * 1. Express mode without projectId: must use `aiplatform.googleapis.com` (ST prepends `{region}-` when region != global).
 * 2. Express mode with projectId + non-global region: ST hardcodes `aiplatform.googleapis.com` instead of regional/multi-region host.
 * 3. Multi-region `us` / `eu`: must use `aiplatform.{us|eu}.rep.googleapis.com` (ST builds nonexistent `{us|eu}-aiplatform.googleapis.com`).
 */
export function fixVertexUrl(urlString) {
    try {
        const url = new URL(urlString);
        if (!GOOGLE_AGENT_PLATFORM_HOST.test(url.hostname)) {
            return { url: urlString, changed: false };
        }
        const m = VERTEX_PATH.exec(url.pathname);
        if (!m) return { url: urlString, changed: false };

        let expectedHost;
        if (m[1]) {
            const loc = m[2].toLowerCase();
            if (loc === 'global') expectedHost = 'aiplatform.googleapis.com';
            else if (loc === 'us' || loc === 'eu') expectedHost = `aiplatform.${loc}.rep.googleapis.com`;
            else expectedHost = `${loc}-aiplatform.googleapis.com`;
        } else {
            expectedHost = 'aiplatform.googleapis.com';
        }

        if (url.hostname === expectedHost) {
            return { url: urlString, changed: false };
        }
        const from = url.hostname;
        url.hostname = expectedHost;
        return { url: url.toString(), changed: true, from, to: expectedHost };
    } catch {
        return { url: urlString, changed: false };
    }
}

/** Express-mode URLs carry no /locations/ segment; the region is encoded in the hostname instead. */
export function locationFromHost(hostname) {
    if (hostname === 'aiplatform.googleapis.com') return 'global';
    const rep = /^aiplatform\.([a-z0-9-]+)\.rep\.googleapis\.com$/.exec(hostname);
    if (rep) return rep[1];
    const m = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(hostname);
    return m ? m[1] : null;
}

/**
 * Service endpoints Google Agent Platform exposes:
 * global `aiplatform.googleapis.com`, regional `{region}-aiplatform.googleapis.com`,
 * and multi-region `aiplatform.{us|eu}.rep.googleapis.com`.
 */
export function isAgentPlatformHost(hostname, extraHosts = []) {
    return hostname === 'aiplatform.googleapis.com'
        || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(hostname)
        || /^aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(hostname)
        || extraHosts.includes(hostname);
}

export function matchVertex(urlString, extraHosts = []) {
    try {
        const url = new URL(urlString);
        if (!isAgentPlatformHost(url.hostname, extraHosts)) return null;
        const m = VERTEX_PATH.exec(url.pathname);
        if (!m) return null;
        return m[1]
            ? { project: decodeURIComponent(m[1]), location: m[2], model: decodeURIComponent(m[3]), method: m[4] }
            : { project: null, location: locationFromHost(url.hostname), model: decodeURIComponent(m[5]), method: m[6] };
    } catch {
        return null;
    }
}

/**
 * TauriTavern's LLM API log records `format_endpoint(base_url, endpoint_path)` where Gemini's `endpoint_path`
 * is `/generateContent` or `/streamGenerateContent` (without `/publishers/google/models/{model}`), while
 * Vertex AI Claude uses `/publishers/anthropic/models/{model}:rawPredict`.
 */
export function parseTauriEndpoint(endpoint, model, stream, extraHosts = []) {
    if (!endpoint || !model) return null;
    try {
        const url = new URL(endpoint);
        if (!isAgentPlatformHost(url.hostname, extraHosts)) return null;
        if (url.pathname.includes('/publishers/anthropic/')) return null;
        const suffix = TAURI_GEMINI_ENDPOINT_SUFFIX.exec(url.pathname);
        if (!suffix) return null;
        const pl = PROJECT_LOCATION_PATH.exec(url.pathname);
        return {
            project: pl ? decodeURIComponent(pl[1]) : null,
            location: pl ? pl[2] : locationFromHost(url.hostname),
            model,
            method: stream || suffix[1].toLowerCase() === 'streamgeneratecontent' ? 'streamGenerateContent' : 'generateContent',
        };
    } catch {
        return null;
    }
}

/** Folds one GenerateContentResponse (or stream chunk) into the accumulator. Last usageMetadata wins: Vertex reports cumulative totals. */
export function absorb(acc, obj) {
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

export function parseNonStreamBody(text) {
    const acc = { complete: true };
    const parsed = JSON.parse(text);
    for (const obj of Array.isArray(parsed) ? parsed : [parsed]) absorb(acc, obj);
    return acc;
}

/** Parses TauriTavern's `response.sse` raw log (one raw upstream JSON event per line, optionally prefixed with `data:`). */
export function parseTauriSseRaw(text, complete = true) {
    const acc = { complete };
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : rawLine.trim();
        if (!line || line === '[DONE]') continue;
        try {
            absorb(acc, JSON.parse(line));
        } catch {
            // Skip malformed or keepalive lines.
        }
    }
    return acc;
}

/**
 * Parses TauriTavern's non-streaming `response.json` log.
 * TauriTavern normalizes non-stream Gemini responses into OpenAI-style `{ model, usage }` before logging.
 * In Vertex AI, `totalTokenCount = promptTokenCount + candidatesTokenCount + thoughtsTokenCount` (plus rare toolUse),
 * so `total_tokens - prompt_tokens - completion_tokens` recovers thinking tokens accurately for standard chat calls.
 */
export function parseTauriNormalizedResponse(text) {
    const acc = { complete: true };
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of items) {
        if (!obj || typeof obj !== 'object') continue;
        if (obj.usageMetadata) {
            absorb(acc, obj);
            continue;
        }
        if (obj.model && !acc.modelVersion) acc.modelVersion = obj.model;
        const u = obj.usage;
        if (u && typeof u === 'object') {
            const promptTokenCount = Number(u.prompt_tokens) || 0;
            const candidatesTokenCount = Number(u.completion_tokens) || 0;
            const totalTokenCount = Number(u.total_tokens) || (promptTokenCount + candidatesTokenCount);
            const cachedContentTokenCount = Number(u.prompt_tokens_details?.cached_tokens) || 0;
            const thoughtsTokenCount = Math.max(0, totalTokenCount - promptTokenCount - candidatesTokenCount);
            acc.usage = {
                promptTokenCount,
                candidatesTokenCount,
                totalTokenCount,
                ...(cachedContentTokenCount > 0 ? { cachedContentTokenCount } : {}),
                ...(thoughtsTokenCount > 0 ? { thoughtsTokenCount } : {}),
            };
        }
    }
    return acc;
}

export function priceRecord(record, pricing) {
    const hit = findPrice(pricing, record.model);
    const cost = hit ? calculateCost(record.usage, hit.price, { ts: record.ts, location: record.location }) : null;
    record.priceKey = hit?.key ?? null;
    record.cost = cost;
    return record;
}

/**
 * Merges newly introduced built-in models from `defaultPricing` into a user's saved settings without
 * overwriting customized prices or reviving built-in models the user previously deleted.
 * Returns true if `settings` was mutated and should be persisted.
 */
export function syncNewDefaultPricing(settings, defaultPricing) {
    settings.pricing ??= {};
    const known = new Set(Array.isArray(settings.knownDefaultModels) ? settings.knownDefaultModels : []);
    let changed = !Array.isArray(settings.knownDefaultModels);

    for (const [key, price] of Object.entries(defaultPricing)) {
        if (!known.has(key)) {
            if (!(key in settings.pricing)) {
                settings.pricing[key] = structuredClone(price);
                changed = true;
            }
            known.add(key);
            changed = true;
        }
    }

    if (changed) {
        settings.knownDefaultModels = [...known];
    }
    return changed;
}

/** Prices only historical records that previously had no price (`!rec.cost`) when a price now exists. */
export function priceUnpricedRecords(records, pricing) {
    let updated = 0;
    for (const rec of records) {
        if (!rec.cost && rec.usage && findPrice(pricing, rec.model)) {
            priceRecord(rec, pricing);
            if (rec.cost) updated += 1;
        }
    }
    return updated;
}

function randomId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createRecord(info, payload, pricing, { ts = Date.now(), id = randomId() } = {}) {
    const usage = payload.usage;
    return priceRecord({
        id,
        ts,
        model: info.model,
        modelVersion: payload.modelVersion ?? null,
        project: info.project ?? null,
        location: info.location ?? null,
        stream: info.method === 'streamGenerateContent',
        complete: payload.complete,
        responseId: payload.responseId ?? null,
        trafficType: usage?.trafficType ?? null,
        grounded: payload.grounded || false,
        searchQueries: payload.searchQueries || 0,
        usage: usage ?? null,
    }, pricing);
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

export function summarize(records, since, todaySince) {
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
