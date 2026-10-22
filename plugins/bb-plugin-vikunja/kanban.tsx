import { useRef, useState } from 'react';
import { z } from 'zod';

export const taskSchema = z.object({
  id: z.number(), title: z.string(), done: z.boolean(), description: z.string().nullish(),
  priority: z.number().nullish(), due_date: z.string().nullish(),
  labels: z.array(z.object({ id: z.number(), title: z.string() })).nullish(),
  assignees: z.array(z.object({ id: z.number(), username: z.string(), name: z.string().optional() })).nullish(),
});
export type Task = z.infer<typeof taskSchema>;
export const bucketSchema = z.object({ id: z.number(), title: z.string(), position: z.number().optional(), limit: z.number().optional(), tasks: z.array(taskSchema).nullish() });
export type Bucket = z.infer<typeof bucketSchema>;

type Props = {
  buckets: Bucket[]; busy: boolean; query: string;
  onOpen: (task: Task) => void;
  onMove: (task: number, bucket: number) => void;
  onDone: (task: Task, done: boolean) => void;
};

export function KanbanBoard({ buckets, busy, query, onOpen, onMove, onDone }: Props) {
  const dragging = useRef<{ task: number; bucket: number } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const filter = query.trim().toLocaleLowerCase();
  const columns = [...buckets].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const reset = () => { dragging.current = null; setOver(null); setDragged(null); };
  return <div role="region" aria-label="Kanban board" className="flex min-h-80 items-stretch gap-4 overflow-x-auto pb-4">
    {columns.map((bucket, index) => {
      const all = bucket.tasks ?? [];
      const cards = all.filter(t => !filter || `${t.id} ${t.title}`.toLocaleLowerCase().includes(filter));
      const target = over === bucket.id;
      return <section key={bucket.id} aria-label={`${bucket.title} column`}
        className={`flex w-72 min-w-72 flex-col rounded-xl border transition-colors ${target ? 'border-foreground bg-accent' : 'border-border bg-muted/30'}`}
        onDragOver={event => {
          if (busy || !dragging.current || dragging.current.bucket === bucket.id) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(bucket.id);
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}
        onDrop={event => {
          const source = dragging.current; event.preventDefault(); reset();
          if (!busy && source && source.bucket !== bucket.id) onMove(source.task, bucket.id);
        }}>
        <header className="flex items-center gap-2 border-b border-border p-3">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${index === columns.length - 1 ? 'bg-emerald-500' : index === 0 ? 'bg-sky-500' : 'bg-amber-500'}`} />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{bucket.title}</h2>
          <span className="rounded bg-background px-2 py-0.5 text-xs text-muted-foreground">{filter ? `${cards.length}/` : ''}{all.length}{bucket.limit ? ` / ${bucket.limit}` : ''}</span>
        </header>
        <div className="flex flex-1 flex-col gap-3 p-3">
          {cards.map(task => {
            const date = task.due_date && !task.due_date.startsWith('0001-') ? new Date(task.due_date) : null;
            const due = date && Number.isFinite(date.getTime()) ? date : null;
            return <article key={task.id} aria-label={`Task ${task.id}: ${task.title}`} draggable={!busy}
              className={`rounded-lg border border-border bg-card p-3 shadow-sm transition-opacity ${busy ? '' : 'cursor-grab active:cursor-grabbing'} ${dragged === task.id ? 'opacity-40' : ''}`}
              onDragStart={event => {
                if (busy) { event.preventDefault(); return; }
                dragging.current = { task: task.id, bucket: bucket.id }; setDragged(task.id);
                event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(task.id));
              }} onDragEnd={reset}>
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>#{task.id}</span>{!!task.priority && <span>Priority {task.priority}</span>}</div>
              <div className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={task.done} disabled={busy} aria-label={`Complete ${task.title}`} onChange={e => onDone(task, e.target.checked)} />
                <button className={`min-w-0 break-words text-left text-sm font-medium hover:underline ${task.done ? 'text-muted-foreground line-through' : ''}`} onClick={() => onOpen(task)}>{task.title}</button></div>
              {!!task.labels?.length && <div className="mt-3 flex flex-wrap gap-1">{task.labels.map(label => <span key={label.id} className="rounded bg-muted px-2 py-0.5 text-xs">{label.title}</span>)}</div>}
              {(due || !!task.assignees?.length) && <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">{due && <time dateTime={due.toISOString()}>Due {due.toLocaleDateString()}</time>}{task.assignees?.map(a => <span key={a.id}>@{a.name || a.username}</span>)}</div>}
              <select aria-label={`Move ${task.title}`} className="mt-3 w-full rounded border border-border bg-background p-1.5 text-xs text-muted-foreground" value="" disabled={busy}
                onChange={e => { if (e.target.value) onMove(task.id, Number(e.target.value)); }}>
                <option value="">Move to column…</option>{columns.filter(b => b.id !== bucket.id).map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
            </article>;
          })}
          {!cards.length && <div className={`flex min-h-28 flex-1 items-center justify-center rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground ${target ? 'border-foreground' : 'border-border'}`}>{filter ? 'No matching tasks' : target ? 'Drop task here' : 'Drop a task here or add one above'}</div>}
        </div>
      </section>;
    })}
    {!columns.length && <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">This view has no columns. Add columns in Vikunja, then refresh.</p>}
  </div>;
}
