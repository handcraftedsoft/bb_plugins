import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KanbanBoard, type Bucket } from './kanban';
afterEach(cleanup);
const buckets: Bucket[] = [
  { id: 2, title: 'Doing', position: 200, tasks: [] },
  { id: 1, title: 'To-Do', position: 100, tasks: [{ id: 7, title: 'Ship board', done: false, labels: [{ id: 3, title: 'Frontend' }] }] },
];
function setup(busy = false, query = '') {
  const onMove = vi.fn(); const onDone = vi.fn(); const onOpen = vi.fn();
  render(<KanbanBoard buckets={buckets} busy={busy} query={query} onMove={onMove} onDone={onDone} onOpen={onOpen} />);
  return { onMove, onDone, onOpen };
}
function transfer() { return { setData: vi.fn(), effectAllowed: '', dropEffect: '' }; }
test('native drag moves a card to another column but ignores external and same-column drops', () => {
  const { onMove } = setup(); const dataTransfer = transfer();
  const card = screen.getByRole('article'); const target = screen.getByRole('region', { name: 'Doing column' });
  fireEvent.drop(target, { dataTransfer }); expect(onMove).not.toHaveBeenCalled();
  fireEvent.dragStart(card, { dataTransfer }); fireEvent.drop(screen.getByLabelText('To-Do column'), { dataTransfer }); expect(onMove).not.toHaveBeenCalled();
  fireEvent.dragStart(card, { dataTransfer }); fireEvent.dragOver(target, { dataTransfer }); fireEvent.drop(target, { dataTransfer });
  expect(onMove).toHaveBeenCalledExactlyOnceWith(7, 2);
  fireEvent.drop(target, { dataTransfer }); expect(onMove).toHaveBeenCalledTimes(1);
});
test('move menu, completion, and opening a card work without dragging', () => {
  const { onMove, onDone, onOpen } = setup();
  fireEvent.change(screen.getByLabelText('Move Ship board'), { target: { value: '2' } }); expect(onMove).toHaveBeenCalledWith(7, 2);
  fireEvent.click(screen.getByLabelText('Complete Ship board')); expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), true);
  fireEvent.click(screen.getByRole('button', { name: 'Ship board' })); expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
});
test('busy board rejects moves and disables controls', () => {
  const { onMove } = setup(true); const dataTransfer = transfer();
  fireEvent.dragStart(screen.getByRole('article'), { dataTransfer }); fireEvent.drop(screen.getByLabelText('Doing column'), { dataTransfer });
  expect(onMove).not.toHaveBeenCalled(); expect(screen.getByLabelText('Move Ship board').hasAttribute('disabled')).toBe(true);
});
test('filter keeps empty columns visible and sorts by server positions', () => {
  setup(false, 'missing');
  expect(screen.queryByRole('article')).toBeNull(); expect(screen.getAllByText('No matching tasks')).toHaveLength(2);
  expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['To-Do', 'Doing']);
});
