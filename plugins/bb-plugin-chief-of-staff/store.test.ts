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

test("an existing database gains the live-run columns without losing task meta", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE cos_task_meta (
     task_id INTEGER PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'task', feature TEXT,
     deploy_requested INTEGER NOT NULL DEFAULT 0, workflow_run_id TEXT, workflow_status TEXT, updated_at INTEGER NOT NULL)`);
  db.prepare("INSERT INTO cos_task_meta (task_id, mode, feature, workflow_run_id, workflow_status, updated_at) VALUES (12, 'feature', 'x', 'wfr_1', 'queued', 1)").run();
  const store = new ChiefStore(db);
  expect(store.getTaskMeta(12)).toMatchObject({ mode: "feature", workflowRunId: "wfr_1", workflowStatus: "queued", workflowPhase: null, runStatus: null });
  store.setTaskMeta(12, { workflowPhase: "Build", runStatus: "running", phaseAt: 5 });
  expect(store.getTaskMeta(12)).toMatchObject({ workflowRunId: "wfr_1", workflowPhase: "Build", runStatus: "running", phaseAt: 5 });
  new ChiefStore(db); // idempotent re-open
});
