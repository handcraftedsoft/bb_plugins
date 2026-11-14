import { expect, test } from 'vitest';
import { buildBurndown, loadBurndown } from './burndown';
const now = new Date('2026-11-09T18:00:00Z');
const task = (id: number, values = {}) => ({ id, done: false, created: '2026-10-01T12:00:00Z', updated: '2026-10-02T12:00:00Z', ...values });
test('lifetime starts at the earliest updated date and extends through today', () => {
  const result = buildBurndown([task(1), task(2, { updated: '2026-10-05T00:00:00Z', done: true, done_at: '2026-10-04T10:00:00Z' })], now, 'UTC');
  expect(result.start).toBe('2026-10-02'); expect(result.end).toBe('2026-11-09');
  expect(result.points[0]).toEqual({ date: '2026-10-02', total: 2, remaining: 2 });
  expect(result.points.at(-1)).toEqual({ date: '2026-11-09', total: 2, remaining: 1 });
  expect(result.points).toContainEqual({ date: '2026-10-04', total: 2, remaining: 1 });
});
test('scope additions can increase remaining work, while completed tasks before the start stay closed', () => {
  const result = buildBurndown([task(1, { done: true, done_at: '2026-10-01T15:00:00Z' }), task(2, { created: '2026-10-07T00:00:00Z', updated: '2026-10-07T00:00:00Z' })], now, 'UTC');
  expect(result.points[0].remaining).toBe(0);
  expect(result.points).toContainEqual({ date: '2026-10-07', total: 2, remaining: 1 });
});
test('calendar days follow the chosen timezone including daylight saving changes', () => {
  const result = buildBurndown([task(1, { created: '2026-11-01T06:30:00Z', updated: '2026-11-01T06:30:00Z', done: true, done_at: '2026-11-02T07:30:00Z' })], now, 'America/Los_Angeles');
  expect(result.start).toBe('2026-10-31');
  expect(result.points).toContainEqual({ date: '2026-11-01', total: 1, remaining: 0 });
});
test('missing completion dates are explicitly counted as estimates', () => {
  const result = buildBurndown([task(1, { done: true, done_at: '0001-01-01T00:00:00Z' }), task(2, { done: false, done_at: '2026-10-01T12:00:00Z' })], now, 'UTC');
  expect(result.estimatedCompletions).toBe(1); expect(result.points.at(-1)?.remaining).toBe(1);
});
test('empty projects return no invented timeline', () => {
  const result = buildBurndown([], now, 'UTC'); expect(result.start).toBeNull(); expect(result.points).toEqual([]);
});
test('undated tasks remain counted with an explicit missing-date count', () => {
  const result = buildBurndown([{ id: 1, done: false, updated: 'invalid', created: '0001-01-01T00:00:00Z' }], now, 'UTC');
  expect(result.missingDates).toBe(1); expect(result.points.at(-1)?.remaining).toBe(1);
});
test('paginated loading includes completed tasks and all pages despite a server page-size cap', async () => {
  const calls: unknown[] = [];
  const result = await loadBurndown(async (name, args) => {
    calls.push({ name, args });
    return { items: [task(Number(args.page), { done: args.page === 2, done_at: '2026-10-06T00:00:00Z' })], page: args.page, total_pages: 2 };
  }, 6, now, 'UTC');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual({ name: 'tasks_list', args: expect.objectContaining({ filter: 'project_id = 6', page: 1 }) });
  expect(result.taskCount).toBe(2); expect(result.points.at(-1)?.remaining).toBe(1);
});
test('a failed later page rejects the whole chart instead of showing incomplete totals', async () => {
  await expect(loadBurndown(async (_name, args) => { if (args.page === 2) throw new Error('Network lost'); return { items: [task(1)], page: 1, total_pages: 2 }; }, 6, now, 'UTC')).rejects.toThrow('Network lost');
});
test('large task descriptions shrink the page size and restart pagination without partial totals', async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await loadBurndown(async (_name, args) => {
    calls.push(args);
    if (Number(args.per_page) > 2) throw new Error('Response exceeds 800 KB; request a smaller page.');
    return { items: args.page === 1 ? [task(1), task(2)] : [task(3)], page: args.page, total_pages: 2 };
  }, 6, now, 'UTC');
  expect(result.taskCount).toBe(3);
  expect(calls.at(-1)?.page).toBe(2);
  expect(Number(calls.at(-1)?.per_page)).toBeLessThanOrEqual(2);
});
