import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { ChiefStore } from "./store";

test("re-introducing a closed task resets its change baseline (no stale 'task was updated' nudge)", () => {
  const store = new ChiefStore(new Database(":memory:"));
  store.upsertTask({ taskId: 11, title: "old", projectId: 5, lastTaskUpdated: "2026-10-22T10:00:00Z" }, 1);
  store.updateTask(11, { state: "closed", closedAt: 2 }, 2);
  const row = store.upsertTask({ taskId: 11, title: "new", projectId: 5, lastTaskUpdated: "2026-10-22T20:00:00Z" }, 3);
  expect(row.title).toBe("new");
  expect(row.lastTaskUpdated).toBe("2026-10-22T20:00:00Z");
});
