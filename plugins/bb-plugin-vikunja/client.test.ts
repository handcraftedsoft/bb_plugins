import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, unpack, bounded, VikunjaClient } from './client.ts';

test('endpoint keeps credentials on HTTPS MCP origin', () => {
  assert.equal(endpoint('https://tasks.example/api/v2/mcp').origin, 'https://tasks.example');
  for (const url of ['http://tasks.example/api/v2/mcp', 'https://u:p@tasks.example/api/v2/mcp', 'https://tasks.example/api/v2/mcp?token=x', 'https://tasks.example/other']) assert.throws(() => endpoint(url));
});
test('MCP payload handling supports structured and text results and rejects errors', () => {
  assert.deepEqual(unpack({ structuredContent: { items: [] } }), { items: [] });
  assert.deepEqual(unpack({ content: [{ type: 'text', text: '{"items":[1]}' }] }), { items: [1] });
  assert.throws(() => unpack({ isError: true, content: [{ type: 'text', text: 'sensitive server error' }] }), /rejected/);
  assert.throws(() => bounded('a'.repeat(800_000)), /smaller page/);
});
test('REST board calls use exact view route and token, reject permission failures, abort on dispose', async () => {
  const original = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://tasks.example/api/v2/projects/3/views/12/buckets/tasks?format=markdown');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-only');
    assert.equal(init?.redirect, 'error'); signal = init?.signal as AbortSignal;
    return new Response('{}', { status: 401 });
  };
  try {
    const client = new VikunjaClient(async () => ({ endpoint: 'https://tasks.example/api/v2/mcp', token: 'test-only' }));
    await assert.rejects(client.rest('/projects/3/views/12/buckets/tasks?format=markdown'), /HTTP 401/);
    await client.dispose(); assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});
test('missing token produces an actionable error before any network request', async () => {
  const client = new VikunjaClient(async () => ({ endpoint: 'https://tasks.example/api/v2/mcp' }));
  await assert.rejects(client.tools(), /Configure the Vikunja token/);
  await client.dispose();
});
test('MCP transport initializes, authenticates, and sends only intended update fields', async () => {
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)); methods.push(request.method);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer test-only');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else {
      assert.equal(request.method, 'tools/call');
      assert.deepEqual(request.params, { name: 'tasks_update', arguments: { task: 123, done: true } });
      result = { content: [{ type: 'text', text: '{"id":123,"done":true}' }], structuredContent: { id: 123, done: true } };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'Content-Type': 'application/json' } });
  };
  const client = new VikunjaClient(async () => ({ endpoint: 'https://tasks.example/api/v2/mcp', token: 'test-only' }));
  try {
    assert.deepEqual(await client.call('tasks_update', { task: 123, done: true }), { id: 123, done: true });
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
  } finally { await client.dispose(); globalThis.fetch = original; }
});
