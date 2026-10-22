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
