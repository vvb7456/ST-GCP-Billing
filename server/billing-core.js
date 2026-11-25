// Pure runtime-agnostic billing helpers shared by the SillyTavern server plugin and the TauriTavern frontend adapter.
import { findPrice, calculateCost } from './pricing.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const CATALOG_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

const VERTEX_PATH = /\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/[^/]+\/models\/([^/:]+):(streamGenerateContent|generateContent)$|\/publishers\/[^/]+\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;
const PROJECT_LOCATION_PATH = /\/projects\/([^/]+)\/locations\/([^/]+)/;
const TAURI_GEMINI_ENDPOINT_SUFFIX = /(?:\/|:)(streamGenerateContent|generateContent)$/i;
const GOOGLE_AGENT_PLATFORM_HOST = /^(?:aiplatform\.googleapis\.com|[a-z0-9-]+-aiplatform\.googleapis\.com|aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com)$/;
const GEMINI_4_PLUS_MODEL_RE = /^gemini-([4-9]|\d{2,})(?:\.\d+)?-/i;
const GEMINI_4_XHIGH_RE = /^gemini-4(?:\.\d+)?-(?:neon|hydrogen)(?:$|[-@])/i;

export function isGemini4Model(model) {
    return GEMINI_4_PLUS_MODEL_RE.test(String(model || '').trim());
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

function roundRate(v) {
    return Math.round(Number(v) * 1e6) / 1e6;
}

export function stableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

/** Records only keys added or modified by the user before initial models.dev migration completes. */
export function recordOfflineUserEdits(settings, nextPricing) {
    if (settings.migratedToModelsDev) return;
    const prev = settings.pricing || {};
    const edited = new Set(Array.isArray(settings.userEditedModels) ? settings.userEditedModels : []);
    for (const [k, v] of Object.entries(nextPricing)) {
        if (!(k in prev) || stableJson(prev[k]) !== stableJson(v)) {
            edited.add(k);
        }
    }
    settings.userEditedModels = [...edited];
}

function parseGeminiVersion(id) {
    const m = /^gemini-(\d+)(?:\.(\d+))?-/.exec(id);
    if (!m) return null;
    return { major: Number(m[1]), minor: m[2] !== undefined ? Number(m[2]) : 0, raw: m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1] };
}

/**
 * Parses `https://models.dev/api.json` (`google-vertex` provider) into our pricing table and Vertex dropdown groups.
 * - Filters out deprecated models and non-chat endpoints (embedding, TTS, live, customtools duplicates).
 * - Automatically synthesizes +10% `nonGlobal` regional rates for GA Gemini 3+ models (preview/beta stay global-only).
 */
export function parseModelsDevCatalog(data) {
    const providerModels = data?.['google-vertex']?.models;
    if (!providerModels || typeof providerModels !== 'object') {
        throw new Error('models.dev response is missing google-vertex models');
    }

    const activeEntries = [];
    for (const [id, m] of Object.entries(providerModels)) {
        if (!m || typeof m !== 'object') continue;
        if (!id.startsWith('gemini-')) continue;
        if (m.status === 'deprecated') continue;
        if (/(?:embedding|-tts(?:$|[-])|-live(?:$|[-])|-transcribe|-translate|-customtools$)/i.test(id)) continue;

        const cost = m.cost;
        if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number' || cost.output <= 0) continue;

        const ver = parseGeminiVersion(id);
        const isImageOnly = /-image(?:$|[-])|nano-banana/i.test(id);
        const isPreview = m.status === 'beta' || /-preview(?:$|[-])/i.test(id);

        const entry = {
            input: roundRate(cost.input),
            output: roundRate(cost.output),
        };
        if (typeof cost.cache_read === 'number') {
            entry.cachedInput = roundRate(cost.cache_read);
        }
        if (typeof cost.input_audio === 'number' && cost.input_audio !== cost.input) {
            entry.inputAudio = roundRate(cost.input_audio);
            if (entry.cachedInput != null && cost.input > 0) {
                entry.cachedInputAudio = roundRate(entry.cachedInput * (cost.input_audio / cost.input));
            }
        }

        const contextTier = Array.isArray(cost.tiers)
            ? cost.tiers.find(t => t?.tier?.type === 'context' && t.tier.size > 0)
            : null;
        const over200k = contextTier || (cost.context_over_200k ? { ...cost.context_over_200k, tier: { size: 200000 } } : null);
        if (over200k && typeof over200k.input === 'number' && typeof over200k.output === 'number') {
            entry.longContextThreshold = Number(over200k.tier.size) || 200000;
            entry.long = {
                input: roundRate(over200k.input),
                output: roundRate(over200k.output),
                ...(typeof over200k.cache_read === 'number' ? { cachedInput: roundRate(over200k.cache_read) } : {}),
            };
        }

        // Google Cloud applies a uniform +10% regional premium on GA Gemini 3+ non-global endpoints.
        if (ver && ver.major >= 3 && !isPreview && !isImageOnly) {
            const nonGlobal = {
                input: roundRate(entry.input * 1.1),
                output: roundRate(entry.output * 1.1),
            };
            if (entry.cachedInput != null) nonGlobal.cachedInput = roundRate(entry.cachedInput * 1.1);
            if (entry.inputAudio != null) nonGlobal.inputAudio = roundRate(entry.inputAudio * 1.1);
            if (entry.cachedInputAudio != null) nonGlobal.cachedInputAudio = roundRate(entry.cachedInputAudio * 1.1);
            if (entry.long) {
                nonGlobal.long = {
                    input: roundRate(entry.long.input * 1.1),
                    output: roundRate(entry.long.output * 1.1),
                    ...(entry.long.cachedInput != null ? { cachedInput: roundRate(entry.long.cachedInput * 1.1) } : {}),
                };
            }
            entry.nonGlobal = nonGlobal;
        }

        activeEntries.push({
            id,
            ver,
            isImageOnly,
            outModalities: Array.isArray(m.modalities?.output) ? m.modalities.output : ['text'],
            releaseDate: String(m.release_date || ''),
            entry,
        });
    }

    // Sort newest major/minor version first, then newest release date first.
    activeEntries.sort((a, b) => {
        const av = a.ver || { major: 0, minor: 0 };
        const bv = b.ver || { major: 0, minor: 0 };
        if (bv.major !== av.major) return bv.major - av.major;
        if (bv.minor !== av.minor) return bv.minor - av.minor;
        if (b.releaseDate !== a.releaseDate) return b.releaseDate.localeCompare(a.releaseDate);
        return a.id.localeCompare(b.id);
    });

    const pricing = {};
    const groupMap = new Map();
    for (const item of activeEntries) {
        pricing[item.id] = item.entry;
        if (item.ver && item.ver.major >= 3 && !item.isImageOnly && item.outModalities.includes('text')) {
            const label = `Gemini ${item.ver.raw}`;
            if (!groupMap.has(label)) groupMap.set(label, []);
            groupMap.get(label).push(item.id);
        }
    }

    const vertexModelGroups = [...groupMap.entries()].map(([label, models]) => ({ label, models }));
    return {
        source: 'models.dev',
        pricing,
        vertexModelGroups,
        modelCount: Object.keys(pricing).length,
    };
}

export async function fetchModelsDevCatalog({ fetchImpl = globalThis.fetch, url = MODELS_DEV_URL, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
        const json = await res.json();
        return parseModelsDevCatalog(json);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Keys shipped in legacy v1.0-v1.3.1 hardcoded DEFAULT_PRICING, used solely for one-time migration to models.dev.
const LEGACY_BUILTIN_KEYS = new Set([
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro',
    'gemini-3.1-flash-lite',
    'gemini-3-flash',
]);

/**
 * Applies a freshly fetched upstream catalog to `settings`:
 * - One-time migration from legacy hardcoded pricing (`!settings.migratedToModelsDev`):
 *   replaces old hardcoded entries (including shortened prefixes & deprecated models) with the live models.dev
 *   catalog while preserving any extra user-defined custom model keys.
 * - Steady-state sync (`settings.migratedToModelsDev === true`):
 *   adds newly introduced models, updates prices of unmodified upstream models, and preserves user edits/deletions.
 */
export function applyCatalogSync(settings, catalog) {
    const nextDefaults = catalog.pricing || {};
    settings.pricing ??= {};

    let added = 0;
    let updated = 0;
    let migrated = false;

    if (!settings.migratedToModelsDev) {
        migrated = true;
        const legacyKnown = new Set([
            ...LEGACY_BUILTIN_KEYS,
            ...(Array.isArray(settings.knownDefaultModels) ? settings.knownDefaultModels : []),
        ]);
        const userEdited = new Set(Array.isArray(settings.userEditedModels) ? settings.userEditedModels : []);
        const nextPricing = structuredClone(nextDefaults);
        // Preserve any non-legacy custom models and any models the user explicitly saved while offline.
        for (const [k, v] of Object.entries(settings.pricing)) {
            if (userEdited.has(k) || (!legacyKnown.has(k) && !(k in nextPricing))) {
                nextPricing[k] = v;
            }
        }
        added = Object.keys(nextDefaults).length;
        settings.pricing = nextPricing;
        settings.upstreamPricing = structuredClone(nextDefaults);
        settings.knownDefaultModels = Object.keys(nextDefaults);
        settings.migratedToModelsDev = true;
        delete settings.userEditedModels;
    } else {
        const prevUpstream = settings.upstreamPricing || {};
        const known = new Set(Array.isArray(settings.knownDefaultModels) ? settings.knownDefaultModels : []);
        for (const [key, nextPrice] of Object.entries(nextDefaults)) {
            if (!known.has(key)) {
                if (!(key in settings.pricing)) {
                    settings.pricing[key] = structuredClone(nextPrice);
                    added += 1;
                }
                known.add(key);
            } else if (key in settings.pricing) {
                const prevPrice = prevUpstream[key];
                if (prevPrice && stableJson(settings.pricing[key]) === stableJson(prevPrice) && stableJson(prevPrice) !== stableJson(nextPrice)) {
                    settings.pricing[key] = structuredClone(nextPrice);
                    updated += 1;
                }
            }
        }
        settings.upstreamPricing = structuredClone(nextDefaults);
        settings.knownDefaultModels = [...known];
    }

    settings.vertexModelGroups = Array.isArray(catalog.vertexModelGroups) ? catalog.vertexModelGroups : [];
    settings.catalogSource = catalog.source || 'models.dev';
    settings.catalogSyncedAt = Date.now();
    return { added, updated, migrated };
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
    else if (rec.usage) bucket.unpriced += 1;
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
        if (rec.usage && !rec.cost) unpricedModels.add(rec.model);
        if (todaySince && rec.ts >= todaySince) sumInto(today, rec);
        if (rec.ts >= since) {
            sumInto(period, rec);
            sumInto(byModel[rec.model] ??= emptyBucket(), rec);
        }
    }
    return { total, period, today, byModel, unpricedModels: [...unpricedModels], firstTs: records[0]?.ts ?? null };
}
