const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function browser() {
    const calls = [];
    const context = vm.createContext({
        Request, Headers, URL,
        window: { location: { href: 'https://studio.example/pagamenti', origin: 'https://studio.example' },
            fetch: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } },
        document: { querySelector: () => ({ content: 'page-session-token' }) },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/csrf.js'), 'utf8'), context);
    return { fetch: context.window.fetch, calls };
}

test('Same-origin mutations receive CSRF while preserving payload, headers and options', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const b = browser();
        await b.fetch('/api/clienti', { method, body: '{"nome":"Test"}', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' });
        const options = b.calls[0][1];
        assert.equal(options.headers.get('X-CSRF-Token'), 'page-session-token');
        assert.equal(options.headers.get('Content-Type'), 'application/json');
        assert.equal(options.body, '{"nome":"Test"}');
        assert.equal(options.credentials, 'same-origin');
    }
});

test('Read requests and external URLs receive no automatically attached token', async () => {
    const b = browser();
    await b.fetch('/api/clienti');
    await b.fetch('https://external.example/api', { method: 'POST' });
    await b.fetch('//external.example/api', { method: 'DELETE' });
    for (const [, options] of b.calls) assert.equal(options?.headers, undefined);
});

test('Request inputs and explicit method overrides retain the effective request semantics', async () => {
    const b = browser();
    const request = new Request('https://studio.example/api/clienti', { method: 'POST', body: 'payload', headers: { 'X-Existing': 'kept' } });
    await b.fetch(request);
    assert.equal(b.calls[0][0], request);
    assert.equal(b.calls[0][1].headers.get('X-Existing'), 'kept');
    assert.equal(b.calls[0][1].headers.get('X-CSRF-Token'), 'page-session-token');
    await b.fetch(request, { method: 'GET' });
    assert.equal(b.calls[1][1].headers, undefined);
});
