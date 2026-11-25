// Pure pricing lookup & cost calculation engine (USD per 1M tokens).
// Model pricing data is synced dynamically from https://models.dev/api.json (google-vertex).

export const RATE_FIELDS = ['input', 'inputAudio', 'cachedInput', 'cachedInputAudio', 'output', 'outputImage'];

/**
 * Exact key wins; otherwise the longest key that is a prefix of the model id
 * (so "gemini-3.5-flash-lite" hits its own entry, not "gemini-3.5-flash").
 */
export function findPrice(pricing, model) {
    if (!pricing || !model) return null;
    if (pricing[model]) return { key: model, price: pricing[model] };
    let best = null;
    for (const key of Object.keys(pricing)) {
        if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
    }
    return best ? { key: best, price: pricing[best] } : null;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function rates(o) {
    const out = {};
    for (const f of RATE_FIELDS) if (o && typeof o[f] === 'number') out[f] = o[f];
    return out;
}

/**
 * Flattens a price entry into the rates that apply to one request.
 * Precedence (later wins): base → nonGlobal; `long` blocks follow the same order.
 */
export function resolveRates(price, { location = 'global' } = {}) {
    const regional = !!location && location !== 'global';

    const layers = [price];
    if (regional) layers.push(price.nonGlobal);

    const base = {};
    const long = {};
    for (const layer of layers) {
        Object.assign(base, rates(layer));
        Object.assign(long, rates(layer?.long));
    }
    return { base, long, regional: regional && !!price.nonGlobal };
}

/** Modality breakdown whose sum is reconciled to `total`; any unexplained remainder is treated as TEXT. */
function byModality(details, total) {
    const map = {};
    let sum = 0;
    for (const d of Array.isArray(details) ? details : []) {
        const m = String(d?.modality || 'TEXT').toUpperCase();
        const c = num(d?.tokenCount);
        map[m] = (map[m] || 0) + c;
        sum += c;
    }
    if (total > sum) map.TEXT = (map.TEXT || 0) + (total - sum);
    return map;
}

/**
 * Billing rules (Agent Platform / Vertex AI):
 * - promptTokenCount includes cachedContentTokenCount; cached part is billed at the cached rate.
 * - toolUsePromptTokenCount (e.g. code execution context) is billed as input.
 * - thoughtsTokenCount is billed at the output rate and is NOT included in candidatesTokenCount.
 * - Long-context tier is selected by prompt size and applies to both input and output.
 */
export function calculateCost(usage, price, context = {}) {
    if (!usage || !price) return null;

    const prompt = num(usage.promptTokenCount);
    const cached = num(usage.cachedContentTokenCount);
    const toolUse = num(usage.toolUsePromptTokenCount);
    const candidates = num(usage.candidatesTokenCount);
    const thoughts = num(usage.thoughtsTokenCount);

    const resolved = resolveRates(price, context);
    const isLong = num(price.longContextThreshold) > 0 && prompt > num(price.longContextThreshold);
    const r = isLong ? { ...resolved.base, ...resolved.long } : resolved.base;

    const inputRate = (m) => (m === 'AUDIO' && r.inputAudio != null ? num(r.inputAudio) : num(r.input));
    const cachedRate = (m) => {
        if (m === 'AUDIO' && r.cachedInputAudio != null) return num(r.cachedInputAudio);
        return r.cachedInput != null ? num(r.cachedInput) : inputRate(m);
    };
    const outputRate = (m) => (m === 'IMAGE' && r.outputImage != null ? num(r.outputImage) : num(r.output));

    const promptMod = byModality(usage.promptTokensDetails, prompt);
    const cacheMod = byModality(usage.cacheTokensDetails, cached);
    const toolMod = byModality(usage.toolUsePromptTokensDetails, toolUse);
    const candMod = byModality(usage.candidatesTokensDetails, candidates);

    let inputCost = 0;
    let cachedCost = 0;
    for (const [m, total] of Object.entries(promptMod)) {
        const c = Math.min(cacheMod[m] || 0, total);
        inputCost += (total - c) * inputRate(m);
        cachedCost += c * cachedRate(m);
    }
    for (const [m, total] of Object.entries(toolMod)) {
        inputCost += total * inputRate(m);
    }

    let outputCost = 0;
    for (const [m, total] of Object.entries(candMod)) {
        outputCost += total * outputRate(m);
    }
    const thoughtsCost = thoughts * num(r.output);

    const M = 1_000_000;
    const result = {
        tier: isLong ? 'long' : 'standard',
        regional: resolved.regional,
        input: inputCost / M,
        cached: cachedCost / M,
        output: outputCost / M,
        thoughts: thoughtsCost / M,
    };
    result.total = result.input + result.cached + result.output + result.thoughts;
    return result;
}
