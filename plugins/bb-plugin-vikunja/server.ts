import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { VikunjaClient, endpoint, bounded } from './client';
const id = z.number().int().positive();
const args = z.record(z.string(), z.unknown());
const callInput = z.object({ name: z.string().regex(/^[a-zA-Z0-9_]+$/), arguments: args });
export const rpcContract = defineRpcContract({
  call: { input: callInput, output: z.unknown() },
  tools: { input: z.null(), output: z.unknown() },
  board: { input: z.object({ project: id, view: id }), output: z.unknown() },
  buckets: { input: z.object({ project: id, view: id }), output: z.unknown() },
  move: { input: z.object({ project: id, view: id, bucket: id, task: id }), output: z.unknown() },
  links: { input: z.object({ task: id }), output: z.array(z.string()) },
  link: { input: z.object({ task: id, thread: z.string().regex(/^thr_[a-z0-9]+$/) }), output: z.array(z.string()) },
  status: { input: z.null(), output: z.object({ configured: z.boolean(), origin: z.string() }) },
});
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    endpoint: { type: 'string', label: 'MCP endpoint', default: 'https://tasks.corp.rateyourfood.asia/api/v2/mcp', experimental_schema: z.string().refine(v => { try { endpoint(v); return true; } catch { return false; } }, 'Use an HTTPS endpoint ending in /api/v2/mcp') },
    token: { type: 'string', label: 'Vikunja API token', secret: true },
  });
  const client = new VikunjaClient(() => settings.get());
  bb.onDispose(() => client.dispose());
  async function call(input: z.infer<typeof callInput>) {
    const result = await client.call(input.name, input.arguments);
    if (/(create|update|delete)$/.test(input.name) || input.name === 'do_action') bb.realtime.publish('vikunja-changed', {});
    return result;
  }
  const links = async (task: number) => (await bb.storage.kv.get<string[]>(`task:${task}`)) ?? [];
  async function link(task: number, thread: string) {
    await bb.sdk.threads.get({ threadId: thread });
    const next = [...new Set([...(await links(task)), thread])].slice(-50);
    await bb.storage.kv.set(`task:${task}`, next); return next;
  }
  bb.rpc.register(rpcContract, {
    call, tools: () => client.tools(),
    status: async () => { const c = await settings.get(); return { configured: !!c.token, origin: endpoint(c.endpoint).origin }; },
    board: ({ project, view }) => client.rest(`/projects/${project}/views/${view}/buckets/tasks?format=markdown`),
    buckets: ({ project, view }) => client.rest(`/projects/${project}/views/${view}/buckets`),
    move: async ({ project, view, bucket, task }) => { const r = await client.rest(`/projects/${project}/views/${view}/buckets/${bucket}/tasks`, 'PUT', { task_id: task }); bb.realtime.publish('vikunja-changed', {}); return r; },
    links: ({ task }) => links(task), link: ({ task, thread }) => link(task, thread),
  });
  const usage = 'bb vikunja tools | call <tool> <JSON-object> | link <task-id> <thread-id> | links <task-id> [--json]';
  bb.cli.register({ name: 'vikunja', summary: 'Browse and update Vikunja through its MCP server', commands: [
    { name: 'tools', summary: 'Discover permitted tools and input schemas', usage: 'bb vikunja tools [--json]' },
    { name: 'call', summary: 'Call a discovered tool (JSON arguments, paginated results)', usage: 'bb vikunja call <tool> <JSON-object> [--json]' },
    { name: 'link', summary: 'Link a Vikunja task to a BB thread locally', usage: 'bb vikunja link <task-id> <thread-id> [--json]' },
    { name: 'links', summary: 'Read local task-to-thread links', usage: 'bb vikunja links <task-id> [--json]' },
  ], async run(argv) {
    const a = argv.filter(v => v !== '--json');
    try {
      let value: unknown;
      if (!a.length || a[0] === 'help' || a.includes('--help')) return { exitCode: 0, stdout: usage };
      if (a[0] === 'tools' && a.length === 1) value = await client.tools();
      else if (a[0] === 'call' && a.length === 3) value = await call(callInput.parse({ name: a[1], arguments: JSON.parse(a[2]!) }));
      else if (a[0] === 'links' && a.length === 2) value = await links(id.parse(Number(a[1])));
      else if (a[0] === 'link' && a.length === 3) { const i = rpcContract.link.input.parse({ task: Number(a[1]), thread: a[2] }); value = await link(i.task, i.thread); }
      else throw new Error(usage);
      bounded(value); return { exitCode: 0, stdout: JSON.stringify(value) };
    } catch (e) { return { exitCode: 1, stderr: e instanceof Error ? e.message : 'Vikunja operation failed' }; }
  } });
  bb.agents.registerTool({ name: 'vikunja_tools', description: 'Discover Vikunja MCP tools and their argument schemas.', parameters: z.object({}), execute: async () => JSON.stringify(await client.tools()) });
  bb.agents.registerTool({ name: 'vikunja_call', description: 'Call a Vikunja MCP tool. Discover its schema with vikunja_tools first. Writes change live tasks.', parameters: callInput, execute: async input => JSON.stringify(await call(input)) });
}
