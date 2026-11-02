// All prices are USD per 1M tokens. Defaults reflect Vertex AI public on-demand (Standard PayGo) list prices;
// users must verify them against https://cloud.google.com/vertex-ai/generative-ai/pricing and edit in the UI.
export const DEFAULT_PRICING = {
    'gemini-3.1-pro': {
        input: 2.0, output: 12.0, cachedInput: 0.2,
        longContextThreshold: 200000,
        long: { input: 4.0, output: 18.0, cachedInput: 0.4 },
    },
    'gemini-3-pro': {
        input: 2.0, output: 12.0, cachedInput: 0.2,
        longContextThreshold: 200000,
        long: { input: 4.0, output: 18.0, cachedInput: 0.4 },
    },
    'gemini-3-flash': {
        input: 0.5, inputAudio: 1.0, output: 3.0, cachedInput: 0.05, cachedInputAudio: 0.1,
    },
    'gemini-2.5-pro': {
        input: 1.25, output: 10.0, cachedInput: 0.125,
        longContextThreshold: 200000,
        long: { input: 2.5, output: 15.0, cachedInput: 0.25 },
    },
    'gemini-2.5-flash': {
        input: 0.3, inputAudio: 1.0, output: 2.5, cachedInput: 0.03, cachedInputAudio: 0.1,
    },
    'gemini-2.5-flash-lite': {
        input: 0.1, inputAudio: 0.3, output: 0.4, cachedInput: 0.01, cachedInputAudio: 0.03,
    },
    'gemini-2.0-flash': {
        input: 0.15, inputAudio: 1.0, output: 0.6, cachedInput: 0.0375,
    },
    'gemini-2.0-flash-lite': {
        input: 0.075, output: 0.3,
    },
};

/**
 * Exact key wins; otherwise the longest key that is a prefix of the model id
 * (so "gemini-2.5-flash-lite-preview-09-2025" hits "gemini-2.5-flash-lite", not "gemini-2.5-flash").
 */
export function findPrice(pricing, model) {
    if (!model) return null;
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
 * Billing rules (Vertex AI):
 * - promptTokenCount includes cachedContentTokenCount; cached part is billed at the cached rate.
 * - toolUsePromptTokenCount (e.g. grounding / code execution context) is billed as input.
 * - thoughtsTokenCount is billed at the output rate and is NOT included in candidatesTokenCount.
 * - Long-context tier is selected by prompt size and applies to both input and output.
 */
export function calculateCost(usage, price) {
    if (!usage || !price) return null;

    const prompt = num(usage.promptTokenCount);
    const cached = num(usage.cachedContentTokenCount);
    const toolUse = num(usage.toolUsePromptTokenCount);
    const candidates = num(usage.candidatesTokenCount);
    const thoughts = num(usage.thoughtsTokenCount);

    const isLong = num(price.longContextThreshold) > 0 && prompt > num(price.longContextThreshold);
    const r = isLong && price.long ? { ...price, ...price.long } : price;

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
        input: inputCost / M,
        cached: cachedCost / M,
        output: outputCost / M,
        thoughts: thoughtsCost / M,
    };
    result.total = result.input + result.cached + result.output + result.thoughts;
    return result;
}

