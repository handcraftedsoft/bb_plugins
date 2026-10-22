import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/v2/mcp')) throw new Error('Use an HTTPS URL ending in /api/v2/mcp, without credentials or query parameters.');
  return url;
}
export function unpack(value: unknown): unknown {
  if (!value || typeof value !== 'object') throw new Error('Vikunja returned an invalid tool response.');
  const result = value as { isError?: boolean; structuredContent?: unknown; content?: unknown };
  if (result.isError) throw new Error('Vikunja rejected the operation. Check arguments and token permissions.');
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') ?? '';
  try { return JSON.parse(text); } catch { return { text }; }
}
export class VikunjaClient {
  private active = new Set<Client>();
  private abort = new AbortController();
  private config: () => Promise<{ endpoint: string; token?: string }>;
  constructor(config: () => Promise<{ endpoint: string; token?: string }>) { this.config = config; }
  async connection<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const cfg = await this.config();
    if (!cfg.token) throw new Error('Configure the Vikunja token in Settings → Plugins → Vikunja.');
    const url = endpoint(cfg.endpoint);
    const client = new Client({ name: 'bb-vikunja', version: '0.1.0' });
    this.active.add(client);
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${cfg.token}` }, redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) } }));
      return await run(client);
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith('Vikunja') || error.message.startsWith('Response exceeds'))) throw error;
      throw new Error('Vikunja connection failed. Check the endpoint, token permissions, and network.');
    } finally { this.active.delete(client); await client.close().catch(() => {}); }
  }
  async tools() {
    return this.connection(async c => {
      const tools = []; let cursor: string | undefined;
      do { const page = await c.listTools({ cursor }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor && tools.length < 200);
      bounded(tools); return tools;
    });
  }
  async call(name: string, args: Record<string, unknown>) {
    const value = await this.connection(async c => unpack(await c.callTool({ name, arguments: args }, undefined, { timeout: 30_000 })));
    bounded(value); return value;
  }
  async rest(path: string, method = 'GET', body?: unknown) {
    const cfg = await this.config();
    if (!cfg.token) throw new Error('Configure the Vikunja token in Settings → Plugins → Vikunja.');
    const base = endpoint(cfg.endpoint);
    const url = new URL(base.pathname.slice(0, -4) + path, base.origin);
    const response = await fetch(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) throw new Error(`Vikunja API returned HTTP ${response.status}. The token may need kanban permissions.`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 800_000) throw new Error('Response exceeds 800 KB; use paginated task browsing.');
    return text ? JSON.parse(text) : null;
  }
  async dispose() { this.abort.abort(); await Promise.all([...this.active].map(c => c.close().catch(() => {}))); }
}
export function bounded(value: unknown) { if (Buffer.byteLength(JSON.stringify(value)) > 800_000) throw new Error('Response exceeds 800 KB; request a smaller page.'); }
