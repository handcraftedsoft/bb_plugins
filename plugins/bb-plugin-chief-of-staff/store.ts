// SQLite persistence for the Chief of Staff plugin. The factory passes these
// statements through bb.storage.migrate; the constructor also applies them
// idempotently so tests can construct the store over a bare in-memory db.
// Append-only: never reorder or edit shipped statements, only push new ones.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { BUILTIN_POLICIES, parseKeywords } from "./logic";
import type { BriefingRow, DecisionKind, DecisionRow, PolicyRow, TaskMeta, TaskMode, TaskRow, TaskState } from "./logic";

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS cos_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cos_items (
     id TEXT PRIMARY KEY,
     num INTEGER NOT NULL,
     title TEXT NOT NULL,
     brief TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'queued',
     priority INTEGER NOT NULL DEFAULT 0,
     thread_id TEXT,
     created_at INTEGER NOT NULL,
     launched_at INTEGER,
     updated_at INTEGER NOT NULL,
     progress_note TEXT,
     progress_at INTEGER,
     done_at INTEGER,
     nudge_count INTEGER NOT NULL DEFAULT 0,
     retries INTEGER NOT NULL DEFAULT 0,
     stalled INTEGER NOT NULL DEFAULT 0,
     error TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cos_items_num ON cos_items (num)`,
  `CREATE INDEX IF NOT EXISTS cos_items_thread ON cos_items (thread_id)`,
  `CREATE TABLE IF NOT EXISTS cos_decisions (
     id TEXT PRIMARY KEY,
     item_id TEXT NOT NULL,
     thread_id TEXT,
     question TEXT NOT NULL,
     context TEXT,
     options TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'pending',
     answer TEXT,
     auto_answered INTEGER NOT NULL DEFAULT 0,
     asked_at INTEGER NOT NULL,
     answered_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS cos_decisions_status ON cos_decisions (status, asked_at)`,
  `CREATE TABLE IF NOT EXISTS cos_policies (
     id TEXT PRIMARY KEY,
     keywords TEXT NOT NULL,
     answer TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT 'user',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cos_briefings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     created_at INTEGER NOT NULL,
     text TEXT NOT NULL,
     signature TEXT NOT NULL
   )`,
  `INSERT OR IGNORE INTO cos_meta (key, value) VALUES ('item_seq', '0')`,
  // v0.2: the backlog moved from local items to Vikunja tasks assigned to the
  // managed user (CTO-bot). cos_tasks supersedes cos_items, which is left in
  // place for older installs.
  `CREATE TABLE IF NOT EXISTS cos_tasks (
     task_id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     project_id INTEGER NOT NULL DEFAULT 0,
     thread_id TEXT,
     state TEXT NOT NULL DEFAULT 'active',
     last_task_updated TEXT NOT NULL DEFAULT '',
     progress_note TEXT,
     progress_at INTEGER,
     launched_at INTEGER,
     closed_at INTEGER,
     nudge_count INTEGER NOT NULL DEFAULT 0,
     retries INTEGER NOT NULL DEFAULT 0,
     stalled INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS cos_tasks_thread ON cos_tasks (thread_id)`,
  // v0.3: routing facts per task (feature vs plain, deploy request, workflow
  // run) and the kind of each decision (irreversible ones never time out).
  `CREATE TABLE IF NOT EXISTS cos_task_meta (
     task_id INTEGER PRIMARY KEY,
     mode TEXT NOT NULL DEFAULT 'task',
     feature TEXT,
     deploy_requested INTEGER NOT NULL DEFAULT 0,
     workflow_run_id TEXT,
     workflow_status TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS cos_decision_meta (
     decision_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'routine'
   )`,
];

const BRIEFINGS_KEPT = 20;
const DECISIONS_LISTED = 50;

interface TaskRecord {
  task_id: number;
  title: string;
  project_id: number;
  thread_id: string | null;
  state: string;
  last_task_updated: string;
  progress_note: string | null;
  progress_at: number | null;
  launched_at: number | null;
  closed_at: number | null;
  nudge_count: number;
  retries: number;
  stalled: number;
  error: string | null;
  updated_at: number;
}

interface DecisionRecord {
  id: string;
  item_id: string;
  thread_id: string | null;
  question: string;
  context: string | null;
  options: string;
  status: string;
  answer: string | null;
  auto_answered: number;
  asked_at: number;
  answered_at: number | null;
}

interface PolicyRecord {
  id: string;
  keywords: string;
  answer: string;
  source: string;
  created_at: number;
}

function toTaskRow(record: TaskRecord): TaskRow {
  return {
    taskId: record.task_id,
    title: record.title,
    projectId: record.project_id,
    threadId: record.thread_id,
    state: record.state as TaskState,
    lastTaskUpdated: record.last_task_updated,
    progressNote: record.progress_note,
    progressAt: record.progress_at,
    launchedAt: record.launched_at,
    closedAt: record.closed_at,
    nudgeCount: record.nudge_count,
    retries: record.retries,
    stalled: record.stalled === 1 ? 1 : 0,
    error: record.error,
    updatedAt: record.updated_at,
  };
}

function toDecisionRow(record: DecisionRecord): DecisionRow {
  let options: string[] = [];
  try {
    const parsed: unknown = JSON.parse(record.options);
    if (Array.isArray(parsed)) options = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    options = [];
  }
  return {
    id: record.id,
    itemId: record.item_id,
    threadId: record.thread_id,
    question: record.question,
    context: record.context,
    options,
    status: record.status as DecisionRow["status"],
    answer: record.answer,
    autoAnswered: record.auto_answered === 1 ? 1 : 0,
    askedAt: record.asked_at,
    answeredAt: record.answered_at,
  };
}

function toPolicyRow(record: PolicyRecord): PolicyRow {
  return {
    id: record.id,
    keywords: parseKeywords(record.keywords),
    answer: record.answer,
    source: record.source === "builtin" ? "builtin" : "user",
    createdAt: record.created_at,
  };
}

export interface TaskPatch {
  title?: string;
  projectId?: number;
  threadId?: string | null;
  state?: TaskState;
  lastTaskUpdated?: string;
  progressNote?: string | null;
  progressAt?: number | null;
  launchedAt?: number | null;
  closedAt?: number | null;
  nudgeCount?: number;
  retries?: number;
  stalled?: 0 | 1;
  error?: string | null;
}

export interface DecisionPatch {
  status?: DecisionRow["status"];
  answer?: string | null;
  answeredAt?: number | null;
}

export interface NewDecision {
  itemId: string;
  threadId: string | null;
  question: string;
  context?: string | null;
  options?: string[];
  status?: DecisionRow["status"];
  answer?: string | null;
  autoAnswered?: boolean;
  answeredAt?: number | null;
}

export class ChiefStore {
  constructor(private readonly db: Database.Database) {
    for (const statement of SCHEMA) this.db.exec(statement);
    this.seedBuiltinPolicies();
  }

  /** Keep the built-in policies in step with BUILTIN_POLICIES: update the
   * answer of a matching keyword set, insert new ones, drop retired ones.
   * User policies are never touched. */
  private seedBuiltinPolicies(): void {
    const rows = this.db
      .prepare<[], { id: string; keywords: string; answer: string }>(
        "SELECT id, keywords, answer FROM cos_policies WHERE source = 'builtin'",
      )
      .all();
    const byKeywords = new Map(rows.map((row) => [row.keywords, row]));
    const wanted = new Set<string>();
    const insert = this.db.prepare(
      "INSERT INTO cos_policies (id, keywords, answer, source, created_at) VALUES (?, ?, ?, 'builtin', ?)",
    );
    const update = this.db.prepare<[string, string]>("UPDATE cos_policies SET answer = ? WHERE id = ?");
    const remove = this.db.prepare<[string]>("DELETE FROM cos_policies WHERE id = ?");
    const now = Date.now();
    const reconcile = this.db.transaction(() => {
      BUILTIN_POLICIES.forEach((policy, index) => {
        const keywords = policy.keywords.join(" ");
        wanted.add(keywords);
        const existing = byKeywords.get(keywords);
        if (existing === undefined) insert.run(randomUUID(), keywords, policy.answer, now + index);
        else if (existing.answer !== policy.answer) update.run(policy.answer, existing.id);
      });
      for (const row of rows) if (!wanted.has(row.keywords)) remove.run(row.id);
    });
    reconcile();
  }

  // ---- routing facts per task ----

  getTaskMeta(taskId: number): TaskMeta | null {
    const record = this.db
      .prepare<[number], { task_id: number; mode: string; feature: string | null; deploy_requested: number; workflow_run_id: string | null; workflow_status: string | null }>(
        "SELECT * FROM cos_task_meta WHERE task_id = ?",
      )
      .get(taskId);
    if (record === undefined) return null;
    return {
      taskId: record.task_id,
      mode: (record.mode === "feature" ? "feature" : "task") as TaskMode,
      feature: record.feature,
      deployRequested: record.deploy_requested === 1,
      workflowRunId: record.workflow_run_id,
      workflowStatus: record.workflow_status,
    };
  }

  setTaskMeta(taskId: number, patch: Partial<Omit<TaskMeta, "taskId">>, now = Date.now()): TaskMeta {
    const current = this.getTaskMeta(taskId) ?? {
      taskId,
      mode: "task" as TaskMode,
      feature: null,
      deployRequested: false,
      workflowRunId: null,
      workflowStatus: null,
    };
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `INSERT INTO cos_task_meta (task_id, mode, feature, deploy_requested, workflow_run_id, workflow_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET mode = excluded.mode, feature = excluded.feature,
           deploy_requested = excluded.deploy_requested, workflow_run_id = excluded.workflow_run_id,
           workflow_status = excluded.workflow_status, updated_at = excluded.updated_at`,
      )
      .run(taskId, next.mode, next.feature, next.deployRequested ? 1 : 0, next.workflowRunId, next.workflowStatus, now);
    return this.getTaskMeta(taskId)!;
  }

  /** Active tasks currently driving a feature workflow. */
  countActiveFeatureTasks(): number {
    return this.db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM cos_tasks t JOIN cos_task_meta m ON m.task_id = t.task_id WHERE t.state = 'active' AND t.thread_id IS NOT NULL AND m.mode = 'feature'",
      )
      .get()!.n;
  }

  setDecisionKind(decisionId: string, kind: DecisionKind): void {
    this.db
      .prepare("INSERT INTO cos_decision_meta (decision_id, kind) VALUES (?, ?) ON CONFLICT(decision_id) DO UPDATE SET kind = excluded.kind")
      .run(decisionId, kind);
  }

  decisionKind(decisionId: string): DecisionKind {
    const record = this.db
      .prepare<[string], { kind: string }>("SELECT kind FROM cos_decision_meta WHERE decision_id = ?")
      .get(decisionId);
    return record?.kind === "irreversible" ? "irreversible" : "routine";
  }

  // ---- managed Vikunja tasks ----

  upsertTask(
    input: { taskId: number; title: string; projectId: number; lastTaskUpdated: string },
    now = Date.now(),
  ): TaskRow {
    this.db
      .prepare(
        "INSERT INTO cos_tasks (task_id, title, project_id, state, last_task_updated, updated_at) VALUES (?, ?, ?, 'active', ?, ?) ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, project_id = excluded.project_id, updated_at = excluded.updated_at",
      )
      .run(input.taskId, input.title, input.projectId, input.lastTaskUpdated, now);
    return this.getTask(input.taskId)!;
  }

  getTask(taskId: number): TaskRow | null {
    const record = this.db.prepare<[number], TaskRecord>("SELECT * FROM cos_tasks WHERE task_id = ?").get(taskId);
    return record === undefined ? null : toTaskRow(record);
  }

  taskByThreadId(threadId: string): TaskRow | null {
    const record = this.db
      .prepare<[string], TaskRecord>("SELECT * FROM cos_tasks WHERE thread_id = ? ORDER BY updated_at DESC")
      .get(threadId);
    return record === undefined ? null : toTaskRow(record);
  }

  listTasks(): TaskRow[] {
    return this.db
      .prepare<[], TaskRecord>("SELECT * FROM cos_tasks ORDER BY updated_at DESC LIMIT 500")
      .all()
      .map(toTaskRow);
  }

  listTasksWithState(state: TaskState): TaskRow[] {
    return this.db
      .prepare<[string], TaskRecord>("SELECT * FROM cos_tasks WHERE state = ? ORDER BY task_id")
      .all(state)
      .map(toTaskRow);
  }

  updateTask(taskId: number, patch: TaskPatch, now = Date.now()): TaskRow | null {
    const current = this.getTask(taskId);
    if (current === null) return null;
    const next = { ...current, ...patch, updatedAt: now };
    this.db
      .prepare(
        `UPDATE cos_tasks SET title = ?, project_id = ?, thread_id = ?, state = ?,
           last_task_updated = ?, progress_note = ?, progress_at = ?, launched_at = ?, closed_at = ?,
           nudge_count = ?, retries = ?, stalled = ?, error = ?, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(
        next.title,
        next.projectId,
        next.threadId,
        next.state,
        next.lastTaskUpdated,
        next.progressNote,
        next.progressAt,
        next.launchedAt,
        next.closedAt,
        next.nudgeCount,
        next.retries,
        next.stalled,
        next.error,
        next.updatedAt,
        taskId,
      );
    return this.getTask(taskId);
  }

  deleteTask(taskId: number): boolean {
    return this.db.prepare<[number]>("DELETE FROM cos_tasks WHERE task_id = ?").run(taskId).changes === 1;
  }

  // ---- decisions ----

  insertDecision(input: NewDecision, now = Date.now()): DecisionRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO cos_decisions (id, item_id, thread_id, question, context, options, status, answer, auto_answered, asked_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.itemId,
        input.threadId,
        input.question,
        input.context ?? null,
        JSON.stringify(input.options ?? []),
        input.status ?? "pending",
        input.answer ?? null,
        input.autoAnswered === true ? 1 : 0,
        now,
        input.answeredAt ?? null,
      );
    return this.getDecision(id)!;
  }

  getDecision(id: string): DecisionRow | null {
    const record = this.db.prepare<[string], DecisionRecord>("SELECT * FROM cos_decisions WHERE id = ?").get(id);
    return record === undefined ? null : toDecisionRow(record);
  }

  updateDecision(id: string, patch: DecisionPatch, now = Date.now()): DecisionRow | null {
    const current = this.getDecision(id);
    if (current === null) return null;
    const next = { ...current, ...patch, answeredAt: patch.answeredAt ?? now };
    this.db
      .prepare("UPDATE cos_decisions SET status = ?, answer = ?, answered_at = ? WHERE id = ?")
      .run(next.status, next.answer, next.answeredAt, id);
    return this.getDecision(id);
  }

  hasPendingDecisionForTask(taskId: number): boolean {
    return (
      this.db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM cos_decisions WHERE item_id = ? AND status = 'pending'",
        )
        .get(String(taskId))!.n > 0
    );
  }

  /** Pending decisions first (oldest first), then the most recent settled ones. */
  listDecisions(): DecisionRow[] {
    const pending = this.db
      .prepare<[], DecisionRecord>("SELECT * FROM cos_decisions WHERE status = 'pending' ORDER BY asked_at")
      .all()
      .map(toDecisionRow);
    const settled = this.db
      .prepare<[number], DecisionRecord>(
        "SELECT * FROM cos_decisions WHERE status != 'pending' ORDER BY answered_at DESC, asked_at DESC LIMIT ?",
      )
      .all(DECISIONS_LISTED)
      .map(toDecisionRow);
    return [...pending, ...settled];
  }

  // ---- policies ----

  listPolicies(): PolicyRow[] {
    return this.db
      .prepare<[], PolicyRecord>("SELECT * FROM cos_policies ORDER BY source DESC, created_at")
      .all()
      .map(toPolicyRow);
  }

  addPolicy(keywords: string[], answer: string, source: "user" | "builtin" = "user", now = Date.now()): PolicyRow {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO cos_policies (id, keywords, answer, source, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, keywords.join(" "), answer, source, now);
    return toPolicyRow(this.db.prepare<[string], PolicyRecord>("SELECT * FROM cos_policies WHERE id = ?").get(id)!);
  }

  removePolicy(id: string): boolean {
    return this.db.prepare<[string]>("DELETE FROM cos_policies WHERE id = ?").run(id).changes === 1;
  }

  // ---- briefings ----

  latestBriefing(): BriefingRow | null {
    const record = this.db
      .prepare<[], { id: number; created_at: number; text: string; signature: string }>(
        "SELECT * FROM cos_briefings ORDER BY id DESC LIMIT 1",
      )
      .get();
    return record === undefined
      ? null
      : { id: record.id, createdAt: record.created_at, text: record.text, signature: record.signature };
  }

  saveBriefing(created: { createdAt: number; text: string; signature: string }): BriefingRow {
    const result = this.db
      .prepare("INSERT INTO cos_briefings (created_at, text, signature) VALUES (?, ?, ?)")
      .run(created.createdAt, created.text, created.signature);
    this.db
      .prepare(
        "DELETE FROM cos_briefings WHERE id NOT IN (SELECT id FROM cos_briefings ORDER BY id DESC LIMIT ?)",
      )
      .run(BRIEFINGS_KEPT);
    return { id: Number(result.lastInsertRowid), ...created };
  }
}
