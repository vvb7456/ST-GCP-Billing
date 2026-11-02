// Minimal fake of the Vertex AI generateContent / streamGenerateContent endpoints, used via ST's reverse_proxy mode.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 9444);

const usage = (model) => ({
    promptTokenCount: model.includes('long') ? 250000 : 1200,
    candidatesTokenCount: 80,
    thoughtsTokenCount: 300,
    cachedContentTokenCount: model.includes('long') ? 0 : 1000,
    totalTokenCount: 1580,
    trafficType: 'ON_DEMAND',
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: model.includes('long') ? 250000 : 1200 }],
    cacheTokensDetails: [{ modality: 'TEXT', tokenCount: model.includes('long') ? 0 : 1000 }],
    candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 80 }],
});

const chunk = (text, extra = {}) => ({
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    modelVersion: 'mock-version',
    responseId: 'resp-' + Date.now(),
    ...extra,
});

http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
        const m = /models\/([^/:]+):(streamGenerateContent|generateContent)/.exec(req.url);
        if (!m) { res.writeHead(404); return res.end('{}'); }
        const [, model, method] = m;
        if (model.includes('error')) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { code: 429, message: 'quota' } }));
        }
        if (method === 'generateContent') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(chunk('Hello from mock', { usageMetadata: usage(model) })));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const parts = ['Hel', 'lo ', 'stream'];
        for (let i = 0; i < parts.length; i++) {
            const last = i === parts.length - 1;
            const u = last ? usage(model) : { promptTokenCount: usage(model).promptTokenCount, trafficType: 'ON_DEMAND' };
            res.write(`data: ${JSON.stringify(chunk(parts[i], { usageMetadata: u }))}\r\n\r\n`);
            await new Promise(r => setTimeout(r, model.includes('slow') ? 1500 : 50));
        }
        res.end();
    });
}).listen(PORT, '127.0.0.1', () => console.log('mock vertex on', PORT));

