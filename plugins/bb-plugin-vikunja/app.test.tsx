import { expect, test, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const project = { id: 6, title: 'General', views: [{ id: 24, title: 'Kanban', view_kind: 'kanban' }] };
const task = { id: 9, title: 'Keep this card', done: false };
const board = { items: [{ id: 16, title: 'To-Do', tasks: [task] }, { id: 17, title: 'Doing', tasks: [] }] };
async function mount(handlers: Record<string, (...args: any[]) => any> = {}) {
  const app = await loadPluginApp(() => import('./app'));
  return renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: {
    status: () => ({ configured: true, origin: 'https://tasks.example' }),
    call: () => ({ items: [project], total_pages: 1 }), board: () => board,
    ...handlers,
  } });
}
test('project opens its kanban automatically and a failed move keeps the original card', async () => {
  const move = vi.fn().mockRejectedValue(new Error('Column is full'));
  const slot = await mount({ move });
  try {
    await slot.findByRole('region', { name: 'Kanban board' });
    fireEvent.change(slot.getByLabelText('Move Keep this card'), { target: { value: '17' } });
    await slot.findByText('Column is full');
    expect(move).toHaveBeenCalledWith({ project: 6, view: 24, bucket: 17, task: 9 });
    expect(slot.getByLabelText('To-Do column').textContent).toContain('Keep this card');
  } finally { slot.lifecycle.unmount(); }
});
test('denied kanban permissions show a notice and a usable task list', async () => {
  const slot = await mount({ board: () => { throw new Error('HTTP 403'); }, call: (input: any) => input.name === 'projects_list' ? { items: [project], total_pages: 1 } : { items: [task], total_pages: 1 } });
  try { await slot.findByText(/Showing tasks instead/); await slot.findByText(/#9 Keep this card/); expect(slot.queryByRole('region', { name: 'Kanban board' })).toBeNull(); }
  finally { slot.lifecycle.unmount(); }
});
test('a slow previous project response cannot overwrite the newly selected board', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const slot = await mount({
    call: () => ({ items: [project, { id: 5, title: 'Other', views: [{ id: 20, title: 'Kanban', view_kind: 'kanban' }] }], total_pages: 1 }),
    board: (input: any) => input.project === 6 ? pending : { items: [{ id: 13, title: 'Other column', tasks: [] }] },
  });
  try {
    await slot.findByRole('option', { name: 'General' });
    fireEvent.change(slot.getByLabelText('Project'), { target: { value: '5' } });
    await slot.findByText('Other column');
    release(board);
    await waitFor(() => { expect(slot.queryByText('Keep this card')).toBeNull(); expect(slot.getByText('Other column')).toBeTruthy(); });
  } finally { release(board); slot.lifecycle.unmount(); }
});
test('Burndown is an alternative to Kanban and follows the selected project', async () => {
  const burndown = vi.fn().mockResolvedValue({ start: '2026-10-02', end: '2026-11-09', taskCount: 2, missingDates: 0, estimatedCompletions: 0, points: [{ date: '2026-10-02', total: 2, remaining: 2 }, { date: '2026-11-09', total: 2, remaining: 1 }] });
  const slot = await mount({ burndown });
  try {
    await slot.findByRole('region', { name: 'Kanban board' });
    fireEvent.change(slot.getByLabelText('View'), { target: { value: '-1' } });
    await slot.findByRole('img', { name: 'Lifetime task burndown' });
    expect(burndown).toHaveBeenCalledWith({ project: 6, timezone: expect.any(String) });
    expect(slot.queryByRole('region', { name: 'Kanban board' })).toBeNull();
    fireEvent.change(slot.getByLabelText('View'), { target: { value: '24' } });
    await slot.findByRole('region', { name: 'Kanban board' });
  } finally { slot.lifecycle.unmount(); }
});
test('Burndown stays selected when changing projects and ignores a late prior response', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const burndown = vi.fn((input: any) => input.project === 6 ? pending : Promise.resolve({ start: null, end: '2026-11-09', taskCount: 0, missingDates: 0, estimatedCompletions: 0, points: [] }));
  const slot = await mount({
    call: () => ({ items: [project, { id: 5, title: 'Other', views: [{ id: 20, title: 'Kanban', view_kind: 'kanban' }] }], total_pages: 1 }),
    burndown,
  });
  try {
    await slot.findByRole('region', { name: 'Kanban board' });
    fireEvent.change(slot.getByLabelText('View'), { target: { value: '-1' } });
    fireEvent.change(slot.getByLabelText('Project'), { target: { value: '5' } });
    await slot.findByText(/No tasks yet. The lifetime burndown/);
    release({ start: '2026-10-02', end: '2026-11-09', taskCount: 1, missingDates: 0, estimatedCompletions: 0, points: [{ date: '2026-11-09', total: 1, remaining: 1 }] });
    await waitFor(() => { expect(slot.queryByRole('img', { name: 'Lifetime task burndown' })).toBeNull(); });
    expect(burndown).toHaveBeenCalledWith({ project: 5, timezone: expect.any(String) });
  } finally { release({}); slot.lifecycle.unmount(); }
});
