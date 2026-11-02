// End-to-end check against a running ST test instance (with mock-vertex.mjs as reverse proxy target).
// Usage: ST_URL=http://127.0.0.1:9333 node tests/e2e.mjs
const ST = process.env.ST_URL || 'http://127.0.0.1:9333';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:9444';

let cookie = '';
async function session() {
    const r = await fetch(`${ST}/csrf-token`);
    cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    return (await r.json()).token;
}

const token = await session();
const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: cookie };
const post = (p, body, extra = {}) => fetch(ST + p, { method: 'POST', headers, body: JSON.stringify(body), ...extra });

const gen = (model, stream, extra = {}) => post('/api/backends/chat-completions/generate', {
    chat_completion_source: 'vertexai',
    reverse_proxy: MOCK,
    proxy_password: 'x',
    model,
    stream,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 100,
}, extra);

const summary = async () => (await post('/api/plugins/vertex-billing/summary', { since: 0 })).json();
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

await post('/api/plugins/vertex-billing/reset', {});

const r1 = await gen('gemini-2.5-flash', false);
const j1 = await r1.json();
assert(j1.choices?.[0]?.message?.content === 'Hello from mock' && !j1.usageMetadata, 'non-stream reply reaches client unchanged (and without usageMetadata, as in upstream ST)');
let s = await summary();
const rec1 = s.latest.at(-1);
assert(s.total.requests === 1 && rec1.usage.promptTokenCount === 1200 && rec1.usage.thoughtsTokenCount === 300, 'non-stream usage captured server-side');
const expected1 = (200 * 0.3 + 1000 * 0.03 + 80 * 2.5 + 300 * 2.5) / 1e6;
assert(Math.abs(rec1.cost.total - expected1) < 1e-12, `non-stream cost ${rec1.cost.total} == ${expected1}`);

const r2 = await gen('gemini-2.5-flash', true);
const t2 = await r2.text();
assert(t2.includes('"text":"stream"') && t2.includes('usageMetadata'), 'stream SSE passes through to client intact');
await new Promise(r => setTimeout(r, 200));
s = await summary();
const rec2 = s.latest.at(-1);
assert(s.total.requests === 2 && rec2.stream && rec2.complete && rec2.usage.candidatesTokenCount === 80, 'stream final usage captured (last chunk wins)');

const r3 = await gen('gemini-2.5-pro-long', false);
await r3.json();
s = await summary();
assert(s.latest.at(-1).cost.tier === 'long', 'long-context tier applied');

const r4 = await gen('gemini-error', false);
await r4.text();
s = await summary();
assert(s.total.requests === 3, 'upstream errors are not recorded');

const ac = new AbortController();
const r5 = await gen('gemini-2.5-flash-slow', true, { signal: ac.signal });
const reader = r5.body.getReader();
await reader.read();
ac.abort();
await new Promise(r => setTimeout(r, 1000));
s = await summary();
const rec5 = s.latest.at(-1);
assert(s.total.requests === 4 && rec5.complete === false, 'aborted stream recorded as incomplete with last seen usage');

const r6 = await gen('unknown-model-x', false);
await r6.json();
s = await summary();
assert(s.latest.at(-1).cost === null && s.total.unpriced === 1, 'unknown model recorded without price');

await post('/api/plugins/vertex-billing/settings/save', { pricing: { ...(await (await post('/api/plugins/vertex-billing/settings/get', {})).json()).pricing, 'unknown-model': { input: 1, output: 1 } } });
await post('/api/plugins/vertex-billing/recalculate', {});
s = await summary();
assert(s.total.unpriced === 0, 'recalculate applies new price to history');

await post('/api/plugins/vertex-billing/reset', {});
s = await summary();
assert(s.total.requests === 0, 'reset clears totals');

