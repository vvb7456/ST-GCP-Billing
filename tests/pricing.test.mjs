// Pure unit tests for the cost calculator: node --test tests/pricing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICING, findPrice, calculateCost } from '../server/pricing.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('longest prefix match', () => {
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-2.5-flash-lite-preview-09-2025').key, 'gemini-2.5-flash-lite');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-2.5-flash-preview-09-2025').key, 'gemini-2.5-flash');
    assert.equal(findPrice(DEFAULT_PRICING, 'gemini-3-pro-preview').key, 'gemini-3-pro');
    assert.equal(findPrice(DEFAULT_PRICING, 'claude-x'), null);
});

test('cached, thoughts, tool use', () => {
    const c = calculateCost({
        promptTokenCount: 1200, cachedContentTokenCount: 1000, candidatesTokenCount: 80,
        thoughtsTokenCount: 300, toolUsePromptTokenCount: 50,
    }, DEFAULT_PRICING['gemini-2.5-flash']);
    close(c.input, (200 + 50) * 0.3 / 1e6);
    close(c.cached, 1000 * 0.03 / 1e6);
    close(c.output, 80 * 2.5 / 1e6);
    close(c.thoughts, 300 * 2.5 / 1e6);
    assert.equal(c.tier, 'standard');
});

test('audio modality and long context tier', () => {
    const a = calculateCost({
        promptTokenCount: 1000, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 400 }, { modality: 'TEXT', tokenCount: 600 }],
        candidatesTokenCount: 10,
    }, DEFAULT_PRICING['gemini-2.5-flash']);
    close(a.input, (400 * 1.0 + 600 * 0.3) / 1e6);

    const l = calculateCost({ promptTokenCount: 250000, candidatesTokenCount: 100 }, DEFAULT_PRICING['gemini-2.5-pro']);
    assert.equal(l.tier, 'long');
    close(l.input, 250000 * 2.5 / 1e6);
    close(l.output, 100 * 15 / 1e6);
});

