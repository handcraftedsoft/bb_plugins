import { z } from 'zod';

const historyTaskSchema = z.object({
  id: z.number().int().positive(), done: z.boolean(),
  created: z.string().nullish(), updated: z.string().nullish(), done_at: z.string().nullish(),
});
type HistoryTask = z.infer<typeof historyTaskSchema>;
export const burndownSchema = z.object({
  start: z.string().nullable(), end: z.string(), taskCount: z.number().int().nonnegative(),
  missingDates: z.number().int().nonnegative(), estimatedCompletions: z.number().int().nonnegative(),
  points: z.array(z.object({ date: z.string(), total: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() })),
});
export type BurndownData = z.infer<typeof burndownSchema>;
export const timezoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Choose a valid IANA timezone');

/** Reconstruct end-of-day totals for currently visible tasks, not an audit history. */
export function buildBurndown(tasks: HistoryTask[], now: Date, timezone: string): BurndownData {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (date: Date) => {
    const parts = formatter.formatToParts(date);
    return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-');
  };
  const timestamp = (value: string | null | undefined) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1 && date <= now ? date : null;
  };
  const end = day(now);
  const result: BurndownData = { start: null, end, taskCount: tasks.length, missingDates: 0, estimatedCompletions: 0, points: [] };
  if (!tasks.length) return result;
  const updatedDays = tasks.flatMap(t => { const date = timestamp(t.updated); return date ? [day(date)] : []; });
  const createdDays = tasks.flatMap(t => { const date = timestamp(t.created); return date ? [day(date)] : []; });
  const start = [...(updatedDays.length ? updatedDays : createdDays)].sort()[0] ?? end;
  result.start = start;
  const events = new Map<string, { added: number; completed: number }>();
  const event = (date: string) => {
    if (!events.has(date)) events.set(date, { added: 0, completed: 0 });
    return events.get(date)!;
  };
  for (const task of tasks) {
    const created = timestamp(task.created);
    const updated = timestamp(task.updated);
    if (!created) result.missingDates++;
    const birth = day(created ?? updated ?? now);
    event(birth).added++;
    if (task.done) {
      const completed = timestamp(task.done_at);
      if (!completed) result.estimatedCompletions++;
      const completion = day(completed ?? updated ?? now);
      event(completion < birth ? birth : completion).completed++;
    }
  }
  event(start); event(end);
  let total = 0; let completed = 0;
  for (const date of [...events.keys()].sort()) {
    const change = events.get(date)!;
    total += change.added; completed += change.completed;
    if (date >= start && date <= end) result.points.push({ date, total, remaining: total - completed });
  }
  return result;
}

/** Fetch every page, including closed tasks. Never return a partial project chart. */
export async function loadBurndown(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  project: number, now = new Date(), timezone = 'UTC',
): Promise<BurndownData> {
  const tasks = new Map<number, HistoryTask>();
  const pageSchema = z.object({ items: z.array(historyTaskSchema).nullable(), page: z.number().int().positive(), total_pages: z.number().int().nonnegative() });
  let perPage = 50;
  for (let page = 1; page <= 200; page++) {
    let response: unknown;
    try {
      response = await call('tasks_list', { filter: `project_id = ${project}`, page, per_page: perPage, sort_by: ['id'], order_by: ['asc'] });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Response exceeds 800 KB') && perPage > 1) {
        perPage = Math.max(1, Math.floor(perPage / 2));
        tasks.clear(); page = 0; // Page boundaries changed: restart the entire read.
        continue;
      }
      throw error;
    }
    const data = pageSchema.parse(response);
    if (data.page !== page) throw new Error('Vikunja returned an unexpected task page. Refresh to retry.');
    for (const task of data.items ?? []) tasks.set(task.id, task);
    if (page >= data.total_pages) return buildBurndown([...tasks.values()], now, timezone);
  }
  throw new Error('This project exceeds the 200-page burndown limit. No partial chart is shown.');
}
