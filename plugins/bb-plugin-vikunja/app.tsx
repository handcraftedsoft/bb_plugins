import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';
import type { rpcContract } from './server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KanbanBoard, taskSchema, bucketSchema, type Task, type Bucket } from './kanban';
const viewSchema = z.object({ id: z.number(), title: z.string(), view_kind: z.string() });
const projectSchema = z.object({ id: z.number(), title: z.string(), views: z.array(viewSchema).nullish() });
function Page() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projects, setProjects] = useState<z.infer<typeof projectSchema>[]>([]);
  const [project, setProject] = useState(0); const [projectPage, setProjectPage] = useState(1); const [projectPages, setProjectPages] = useState(1);
  const [view, setView] = useState(0); const [page, setPage] = useState(1); const [pages, setPages] = useState(1);
  const [tasks, setTasks] = useState<Task[]>([]); const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [origin, setOrigin] = useState('');
  const [title, setTitle] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null); const [links, setLinks] = useState<string[]>([]); const [thread, setThread] = useState('');
  const [query, setQuery] = useState('');
  const generation = useRef(0);
  const writing = useRef(false);
  const report = (e: unknown) => setError(e instanceof Error ? e.message : 'Unable to load Vikunja');
  useEffect(() => {
    let active = true;
    Promise.all([rpc.call('status'), rpc.call('call', { name: 'projects_list', arguments: { page: projectPage, per_page: 50 } })]).then(([status, data]) => {
      if (!active) return;
      setOrigin(status.origin);
      const result = z.object({ items: z.array(projectSchema), total_pages: z.number() }).parse(data);
      setProjects(result.items); setProjectPages(result.total_pages); setProject(result.items[0]?.id ?? 0); setView(result.items[0]?.views?.find(v => v.view_kind === 'kanban')?.id ?? 0); setPage(1);
    }).catch(e => { if (active) report(e); });
    return () => { active = false; };
  }, [rpc, projectPage]);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!project) return;
    setLoading(true); setError(''); setNotice('');
    try {
      if (view) {
        try {
          const data = await rpc.call('board', { project, view });
          const result = z.object({ items: z.array(bucketSchema).nullable() }).parse(data);
          if (request === generation.current) { setBuckets(result.items ?? []); setPages(1); }
          return;
        } catch (e) { if (request === generation.current) setNotice(`${e instanceof Error ? e.message : 'Board unavailable'} Showing tasks instead.`); }
      }
      const data = await rpc.call('call', { name: 'tasks_list', arguments: { filter: `project_id = ${project}`, page, per_page: 50, format: 'markdown' } });
      const result = z.object({ items: z.array(taskSchema).nullable(), total_pages: z.number() }).parse(data);
      if (request === generation.current) { setBuckets(null); setTasks(result.items ?? []); setPages(result.total_pages); }
    } catch (e) { if (request === generation.current) report(e); }
    finally { if (request === generation.current) setLoading(false); }
  }, [rpc, project, view, page]);
  useEffect(() => { setSelected(null); setBuckets(null); setTasks([]); setQuery(''); void refresh(); return () => { generation.current++; }; }, [refresh]);
  useRealtime('vikunja-changed', () => { void refresh(); });
  async function mutate(run: () => Promise<unknown>) {
    if (writing.current) return;
    writing.current = true; setBusy(true); setError('');
    try { await run(); await refresh(); setSelected(null); } catch (e) { report(e); } finally { writing.current = false; setBusy(false); }
  }
  const openTask = (task: Task) => { setSelected(task); setLinks([]); rpc.call('links', { task: task.id }).then(setLinks).catch(report); };
  const moveTask = (task: number, bucket: number) => { void mutate(() => rpc.call('move', { project, view, bucket, task })); };
  const row = (task: Task) => <article key={task.id} className="my-2 rounded-lg border border-border bg-card p-3">
    <div className="flex gap-2"><input type="checkbox" checked={task.done} disabled={busy} aria-label={`Complete ${task.title}`} onChange={e => void mutate(() => rpc.call('call', { name: 'tasks_update', arguments: { task: task.id, done: e.target.checked } }))} />
      <button className="text-left text-sm" onClick={() => openTask(task)}>#{task.id} {task.title}</button></div>
    {buckets && <select aria-label={`Move ${task.title}`} className="mt-2 w-full rounded border border-border bg-background p-1 text-xs" value="" disabled={busy} onChange={e => { if (e.target.value) void mutate(() => rpc.call('move', { project, view, bucket: Number(e.target.value), task: task.id })); }}><option value="">Move to column…</option>{buckets.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}</select>}
  </article>;
  return <div className="h-full overflow-auto p-5"><div className={`mx-auto space-y-4 ${buckets ? 'w-full' : 'max-w-6xl'}`}>
    <div className="flex flex-wrap items-center gap-3"><h1 className="text-lg font-semibold">Vikunja</h1><Button variant="outline" onClick={() => void refresh()} disabled={loading}>Refresh</Button></div>
    <div className="flex flex-wrap gap-2"><select disabled={busy} aria-label="Project" className="rounded border border-border bg-background p-2" value={project} onChange={e => { const next = Number(e.target.value); setProject(next); setView(projects.find(p => p.id === next)?.views?.find(v => v.view_kind === 'kanban')?.id ?? 0); setPage(1); }}>{projects.map(p => <option value={p.id} key={p.id}>{p.title}</option>)}</select>
      <select disabled={busy} aria-label="View" className="rounded border border-border bg-background p-2" value={view} onChange={e => { setView(Number(e.target.value)); setPage(1); }}><option value={0}>All tasks</option>{projects.find(p => p.id === project)?.views?.filter(v => v.view_kind === 'kanban').map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select>
      {projectPages > 1 && <><Button disabled={busy || projectPage === 1} onClick={() => setProjectPage(v => v - 1)}>Previous projects</Button><Button disabled={busy || projectPage >= projectPages} onClick={() => setProjectPage(v => v + 1)}>More projects</Button></>}
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); void mutate(async () => { await rpc.call('call', { name: 'tasks_create', arguments: { project, title: title.trim() } }); setTitle(''); }); }}><Input aria-label="New task title" placeholder="New task title" value={title} onChange={e => setTitle(e.target.value)} /><Button disabled={busy || !project || !title.trim()}>Add task</Button></form>
    {buckets && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{buckets.reduce((n, b) => n + (b.tasks?.length ?? 0), 0)} tasks · Drag cards between columns, or use their move menu.</p><Input className="max-w-64" aria-label="Filter board" placeholder="Filter by title or task number" value={query} onChange={e => setQuery(e.target.value)} /></div>}
    {loading && <p role="status" className="text-sm text-muted-foreground">Refreshing…</p>}
    {buckets ? <KanbanBoard buckets={buckets} busy={busy || loading} query={query} onOpen={openTask} onMove={moveTask} onDone={(task, done) => void mutate(() => rpc.call('call', { name: 'tasks_update', arguments: { task: task.id, done } }))} /> : !loading && <div>{tasks.map(row)}{!tasks.length && <p>No tasks on this page.</p>}<div className="flex items-center gap-3"><Button disabled={busy || page <= 1} onClick={() => setPage(v => v - 1)}>Previous</Button><span>Page {page} of {Math.max(1, pages)}</span><Button disabled={busy || page >= pages} onClick={() => setPage(v => v + 1)}>Next</Button></div></div>}
    {selected && <section className="space-y-3 rounded-lg border border-border p-4"><div className="flex justify-between"><h2 className="font-medium">#{selected.id} {selected.title}</h2><Button variant="ghost" onClick={() => setSelected(null)}>Close</Button></div><p className="whitespace-pre-wrap text-sm">{selected.description || 'No description'}</p><a className="underline" href={`${origin}/tasks/${selected.id}`} target="_blank" rel="noreferrer">Open in Vikunja</a><p className="text-sm">Linked BB threads: {links.length ? links.map(t => <button key={t} className="mr-2 underline" onClick={() => navigate.toThread(t)}>{t}</button>) : 'None'}</p><form className="flex gap-2" onSubmit={e => { e.preventDefault(); rpc.call('link', { task: selected.id, thread }).then(setLinks).catch(report); }}><Input aria-label="BB thread ID" placeholder="thr_…" value={thread} onChange={e => setThread(e.target.value)} /><Button disabled={!/^thr_[a-z0-9]+$/.test(thread)}>Link thread</Button></form></section>}
  </div></div>;
}
export default definePluginApp(app => { app.slots.navPanel({ id: 'vikunja-board', title: 'Vikunja', icon: 'ListTodo', path: 'board', component: Page }); });
