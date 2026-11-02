// Pure unit tests for the cost calculator: node --test tests/pricing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICING, findPrice, calculateCost } from '../server/pricing.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('longest prefix match', () => {
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-3.8-flash').key, 'gemini-3.8-flash');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-3.5-flash-lite').key, 'gemini-3.5-flash-lite');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-4-argon').key, 'gemini-4-argon');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-3.1-pro-preview').key, 'gemini-3.1-pro');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-3-flash-preview').key, 'gemini-3-flash');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-2.0-flash'), null);
});

test('cached, thoughts, tool use', () => {
    const c = calculateCost({
        promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 80,
        thoughtsTokenCount: 300, toolUsePromptTokenCount: 50,
    }, DEFAULT_PRICING['gemini-3.5-flash'], { location: 'global' });
    close(c.input, (200 + 50) * 1.5 / 1e6);
    close(c.cached, 1000 * 0.15 / 1e6);
    close(c.output, 80 * 9 / 1e6);
    close(c.thoughts, 300 * 9 / 1e6);
    assert.equal(c.tier, 'standard');
    assert.equal(c.regional, false);
});

test('regional endpoint uses nonGlobal rates', () => {
    const c = calculateCost({ promptTokenCount: 1000, candidatesTokenCount: 100 }, DEFAULT_PRICING['gemini-3.5-flash'], { location: 'us-central1' });
    close(c.input, 1000 * 1.65 / 1e6);
    close(c.output, 100 * 9.9 / 1e6);
    assert.equal(c.regional, true);
});

test('list price only, no promo discount', () => {
    const c = calculateCost({ promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 100 }, DEFAULT_PRICING['gemini-4-argon'], { location: 'global' });
    close(c.input, 600 * 4 / 1e6);
    close(c.cached, 400 * 0.2 / 1e6);
    close(c.output, 100 * 20 / 1e6);
    const r = calculateCost({ promptTokenCount: 1000, candidatesTokenCount: 100 }, DEFAULT_PRICING['gemini-3.8-flash'], { location: 'asia-northeast1' });
    close(r.input, 1000 * 1.65 / 1e6);
    close(r.output, 100 * 8.25 / 1e6);
});

test('audio modality and long context tier', () => {
    const a = calculateCost({
        promptTokenCount: 1000, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 400 }, { modality: 'TEXT', tokenCount: 600 }],
        candidatesTokenCount: 10,
    }, DEFAULT_PRICING['gemini-3.1-flash-lite'], { location: 'global' });
    close(a.input, (400 * 0.5 + 600 * 0.25) / 1e6);

    const l = calculateCost({ promptTokenCount: 250000, candidatesTokenCount: 100 }, DEFAULT_PRICING['gemini-3.1-pro'], { location: 'global' });
    assert.equal(l.tier, 'long');
    close(l.input, 250000 * 4 / 1e6);
    close(l.output, 100 * 18 / 1e6);
});
