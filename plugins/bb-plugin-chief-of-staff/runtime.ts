// The Chief of Staff runtime: watches Vikunja for tasks assigned to the
// managed user (CTO-bot), reuses or spawns one BB worker thread per task in
// the configured project, keeps workers moving, triages their questions, and
// composes briefings. Vikunja access goes through the vikunja plugin's RPC
// (call / links / link / buckets / move / status) via bb.sdk.plugins.callRpc.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  bucketForColumn,
  buildBriefing,
  buildWorkerPrompt,
  columnForPhase,
  parseBuckets,
  phaseFromNote,
  workflowPhaseFromTimeline,
  type BoardColumn,
  CHANGED_CHANNEL,
  classifyQuestion,
  triageQuestion,
  classifyDependencies,
  classifyTask,
  describeAnswer,
  describeDeps,
  schedulingDecision,
  KNOWN_RESOURCES,
  type TaskDeps,
  featureDoneAllowed,
  operatingRules,
  filterByAssignee,
  matchPolicy,
  parseKeywords,
  parseVikunjaTasksPage,
  type BriefingRow,
  type CosSettings,
  type DecisionKind,
  type DecisionRow,
  type PolicyRow,
  type ReportStage,
  type TaskMeta,
  type TaskRow,
  type VikunjaTask,
  type WorkerPlan,
} from "./logic";
import { ChiefStore } from "./store";

const VIKUNJA_PLUGIN_ID = "vikunja";
const AUTO_RETRIES = 1;
const MAX_TASK_PAGES = 10;
const VIEW_CACHE_MS = 10 * 60_000;
/** The builtin workflows plugin (owns feature-delivery runs; exposes run view/stop RPCs). */
const WORKFLOWS_PLUGIN_ID = "workflows";
/**
 * Workflow phases a close-in-Vikunja never interrupts: a half-applied merge or
 * delivery is worse than closing a few minutes late. The chief of staff waits
 * for the run to leave these phases (or finish), then closes.
 */
const UNINTERRUPTIBLE_PHASES = new Set(["merge", "deliver"]);
/** Prefix of the row error while a Vikunja close waits for an in-flight Merge/Deliver. */
export const VIKUNJA_CLOSE_PENDING = "closed in Vikunja; waiting for the in-flight";

type LeftVikunja = "done" | "deleted" | "unassigned";

interface ActiveRunView {
  id: string;
  status: string;
  currentPhase: string | null;
}

/** Branch and worktree names in a local git checkout (feature slug collision
 * check). Best effort: any failure yields no names. */
function gitNames(repo: string): Promise<string[]> {
  const run = (args: string[]) =>
    new Promise<string>((resolve) => {
      execFile("git", ["-C", repo, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? "" : String(stdout));
      });
    });
  return Promise.all([
    run(["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    run(["worktree", "list", "--porcelain"]),
  ]).then(([branches, worktrees]) => {
    const names = new Set<string>();
    for (const branch of branches.split("\n").map((line) => line.trim()).filter(Boolean)) {
      names.add(branch);
      const leaf = branch.split("/").pop();
      if (leaf) names.add(leaf);
    }
    for (const line of worktrees.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const parts = line.slice("worktree ".length).trim().split("/").filter(Boolean);
      for (const part of parts.slice(-2)) names.add(part);
    }
    return [...names];
  });
}

/** True when feature/<slug> is merged into main, or main has a `feature: <slug>`
 * commit (mirrors the feature-delivery lease helper's hard-dependency check). */
function featureMerged(repo: string, slug: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return Promise.resolve(false);
  const run = (args: string[]) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile("git", ["-C", repo, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        resolve({ ok: !error, out: String(stdout ?? "") });
      });
    });
  const branch = `refs/heads/feature/${slug}`;
  return run(["rev-parse", "--verify", "-q", branch]).then(async (exists) => {
    if (exists.ok && (await run(["merge-base", "--is-ancestor", branch, "main"])).ok) return true;
    const log = await run(["log", "main", "--format=%s", "--max-count=2000"]);
    return log.ok && log.out.split("\n").some((subject) => subject === `feature: ${slug}` || subject.startsWith(`feature: ${slug} `));
  });
}

/** Resources a workflow run's live lease holds (feature-delivery lock helper:
 * ~/.bb/locks/<lock>.leases/<run-id>.json), or null when it holds none / no lease. */
async function leaseResources(runId: string): Promise<string[] | null> {
  const dir = join(homedir(), ".bb", "locks");
  const file = runId.replace(/[^A-Za-z0-9_.:-]/g, "_") + ".json";
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const entry of entries.filter((name) => name.endsWith(".leases"))) {
    try {
      const lease = JSON.parse(await readFile(join(dir, entry, file), "utf8")) as { resources?: unknown };
      if (Array.isArray(lease.resources)) return lease.resources.filter((item): item is string => typeof item === "string");
    } catch {
      // no lease for this run under this lock
    }
  }
  return null;
}

/** Test seams: existing branch/worktree names; whether a feature is merged to main;
 * the resources a workflow run's live lease holds. */
export const runtimeHooks: {
  gitNames: (repo: string) => Promise<string[]>;
  featureMerged: (repo: string, slug: string) => Promise<boolean>;
  leaseResources: (runId: string) => Promise<string[] | null>;
} = { gitNames, featureMerged, leaseResources };

/** Error prefix for a paused feature task that keeps its worker thread but is
 * held back by the scheduler (resource / cap); the sweep resumes it when eligible. */
export const SCHEDULER_HOLD = "held by scheduler: ";

export interface TaskView {
  taskId: number;
  title: string;
  projectId: number;
  state: TaskRow["state"];
  threadId: string | null;
  progressNote: string | null;
  progressAt: number | null;
  stalled: boolean;
  nudgeCount: number;
  error: string | null;
  threadStatus: string | null;
  mode: TaskMeta["mode"];
  deployRequested: boolean;
  workflowStatus: string | null;
  /** Live workflow phase / run status (workflows plugin), feature tasks only. */
  workflowPhase: string | null;
  runStatus: string | null;
  /** Dependency layers (feature tasks): hard deps, shared resources, soft deps. */
  dependsOn: string[];
  resources: string[];
  softAfter: string[];
  /** Why a feature task is not started yet (hard dep / resource / cap), else null. */
  blockReason: string | null;
}

export interface DecisionView {
  id: string;
  taskId: number | null;
  taskTitle: string | null;
  question: string;
  context: string | null;
  options: string[];
  status: DecisionRow["status"];
  answer: string | null;
  autoAnswered: boolean;
  askedAt: number;
  answeredAt: number | null;
  kind: DecisionKind;
}

export interface PolicyView {
  id: string;
  keywords: string[];
  answer: string;
  source: PolicyRow["source"];
}

export interface BriefingView {
  id: number;
  createdAt: number;
  text: string;
}

export interface Overview {
  configured: boolean;
  assignee: string;
  settings: { maxConcurrent: number; stallMinutes: number; maxNudges: number };
  counts: { active: number; paused: number; closed: number; pendingDecisions: number };
  briefing: BriefingView | null;
  tasks: TaskView[];
  decisions: DecisionView[];
  policies: PolicyView[];
}

export interface AskInput {
  question: string;
  context?: string;
  options?: string[];
  kind?: DecisionKind;
}

export interface WorkflowReport {
  runId?: string;
  status?: string;
  /** Workflow phase (feature drivers) or "verifying"/"building" (plain tasks). */
  phase?: string;
}

interface KanbanView {
  id: number;
  doneBucketId: number | null;
}

/** Where a card should go and where it was last put. */
interface CardRef {
  id: number;
  projectId: number;
  bucketId?: number | null;
  viewId?: number | null;
}

type AskOutcome = { kind: "answered"; answer: string } | { kind: "dismissed" } | { kind: "withdrawn" | "timeout" };

export class ChiefOfStaff {
  private readonly resolvers = new Map<string, (outcome: AskOutcome) => void>();
  private wakeDeferred: Promise<void> | null = null;
  private wakeResolve: (() => void) | null = null;
  private sweeping = false;
  /** Last column the chief of staff moved each task to (avoids re-moving every sweep). */
  private readonly columns = new Map<number, BoardColumn>();
  private readonly viewCache = new Map<number, { views: KanbanView[]; at: number }>();

  constructor(
    private readonly bb: BbPluginApi,
    private readonly store: ChiefStore,
    private readonly readSettings: () => Promise<CosSettings>,
  ) {}

  // ---- Vikunja bridge (cross-plugin RPC into the vikunja plugin) ----

  private async vikunja<T>(method: string, input: unknown): Promise<T> {
    return this.bb.sdk.plugins.callRpc<T>({
      pluginId: VIKUNJA_PLUGIN_ID,
      method,
      input: input as never,
      outputSchema: z.unknown() as never,
    }) as Promise<T>;
  }

  async vikunjaConfigured(): Promise<boolean> {
    try {
      const status = await this.vikunja<{ configured?: boolean }>("status", null);
      return status?.configured === true;
    } catch {
      return false;
    }
  }

  /** All open Vikunja tasks assigned to the managed user; throws on failure. */
  async fetchManagedTasks(assignee: string): Promise<VikunjaTask[]> {
    const collected: VikunjaTask[] = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, MAX_TASK_PAGES); page += 1) {
      const envelope = await this.vikunja<unknown>("call", {
        name: "tasks_list",
        arguments: { page, per_page: 50, expand: ["buckets"], filter: "done = false" },
      });
      const parsed = parseVikunjaTasksPage(envelope);
      if (parsed === null) throw new Error("Vikunja returned an unexpected tasks_list envelope");
      collected.push(...parsed.tasks);
      totalPages = parsed.totalPages;
    }
    return filterByAssignee(collected, assignee);
  }

  // ---- worker threads ----

  private planFor(meta: TaskMeta, settings: CosSettings): WorkerPlan {
    return {
      mode: meta.mode,
      feature: meta.feature,
      deployRequested: meta.deployRequested,
      workflowName: settings.workflowName,
    };
  }

  /** Routing facts for a task: derived from the task text on first sight and
   * kept afterwards (the workflow args are frozen at dispatch). */
  private async metaFor(task: VikunjaTask, settings: CosSettings): Promise<TaskMeta> {
    const existing = this.store.getTaskMeta(task.id);
    if (existing !== null) return existing;
    const taken = new Set(this.store.listFeatureNames(task.id));
    const repo = await this.projectRepo(settings.project);
    if (repo !== null) {
      try {
        for (const name of await runtimeHooks.gitNames(repo)) {
          taken.add(name);
          const leaf = name.split("/").pop(); // feature/<slug>, bb/<...>
          if (leaf) taken.add(leaf);
        }
      } catch (cause) {
        this.bb.log.warn(`git names in ${repo}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    return this.store.setTaskMeta(task.id, classifyTask(task, settings.featureLabel, (name) => taken.has(name)));
  }

  /** Dependency layers for a feature task. Re-read from the task text until
   * the task is dispatched (the description may gain Depends-on lines), then
   * frozen with the workflow args. */
  private depsFor(task: VikunjaTask, meta: TaskMeta): TaskDeps {
    const row = this.store.getTask(task.id);
    const stored = this.store.getSchedule(task.id).deps;
    if (stored !== null && row !== null && row.threadId !== null) return stored;
    const deps = classifyDependencies(task, meta.feature);
    if (stored === null || JSON.stringify(stored) !== JSON.stringify(deps)) this.store.setSchedule(task.id, { deps });
    return deps;
  }

  /** Whether a hard dependency is merged to main: its CoS task finished, or git says so. */
  private async dependencyDone(slug: string, repo: string | null): Promise<boolean> {
    if (this.store.featureTask(slug)?.finished === true) return true;
    if (repo === null) return false;
    try {
      return await runtimeHooks.featureMerged(repo, slug);
    } catch {
      return false;
    }
  }

  /** Hard deps merged, shared resources free, slot under the cap? Soft deps never block. */
  private async scheduleFeature(task: VikunjaTask, meta: TaskMeta, settings: CosSettings) {
    const deps = this.depsFor(task, meta);
    const repo = deps.dependsOn.length === 0 ? null : await this.projectRepo(settings.project);
    const done = new Map<string, boolean>();
    for (const slug of deps.dependsOn) done.set(slug, await this.dependencyDone(slug, repo));
    const decision = schedulingDecision({
      deps,
      active: this.store.activeFeatureRuns().filter((run) => run.taskId !== task.id),
      maxFeatureRuns: settings.maxFeatureRuns,
      depDone: (slug) => done.get(slug) === true,
      taskForFeature: (slug) => this.store.featureTask(slug)?.taskId ?? null,
    });
    return { deps, decision };
  }

  /** Record resources a running feature task's workflow lease actually holds
   * (e.g. ios-simulator on a ticket that said "Resources: none"), so scheduling
   * and status see them. Only ever adds resources. */
  private async recordLeaseResources(): Promise<void> {
    for (const run of this.store.activeFeatureRuns()) {
      const meta = this.store.getTaskMeta(run.taskId);
      const runId = meta?.workflowRunId ?? null;
      if (runId === null) continue;
      let held: string[] | null = null;
      try {
        held = await runtimeHooks.leaseResources(runId);
      } catch {
        held = null;
      }
      this.addHeldResources(run.taskId, held ?? [], `held by workflow lease ${runId}`);
    }
  }

  /** Operator override (`bb chief resources`): record resources a feature task
   * really needs when its ticket's Resources line is wrong. Adds only. */
  addTaskResources(taskId: number, resources: string[]): TaskDeps {
    if (this.store.getTaskMeta(taskId)?.mode !== "feature") throw new Error(`Task #${taskId} is not a feature task`);
    const unknown = resources.filter((resource) => !KNOWN_RESOURCES.includes(resource));
    if (unknown.length > 0) throw new Error(`unknown resource: ${unknown.join(", ")} (known: ${KNOWN_RESOURCES.join(", ")})`);
    if (this.store.getSchedule(taskId).deps === null) {
      this.store.setSchedule(taskId, {
        deps: { dependsOn: [], resources: [], softAfter: [], source: { dependsOn: "", resources: "", softAfter: "" } },
      });
    }
    this.addHeldResources(taskId, resources, "set by operator");
    this.publish();
    return this.store.getSchedule(taskId).deps!;
  }

  /** Add resources a task's workflow run actually held to its recorded deps (never removes). */
  private addHeldResources(taskId: number, held: string[], why: string): void {
    const deps = this.store.getSchedule(taskId).deps;
    if (deps === null) return;
    const extra = [...new Set(held)].filter((resource) => !deps.resources.includes(resource));
    if (extra.length === 0) return;
    this.store.setSchedule(taskId, {
      deps: {
        ...deps,
        resources: [...deps.resources, ...extra],
        source: { ...deps.source, resources: `${deps.source.resources} + ${why}` },
      },
    });
    this.bb.log.info(`task ${taskId}: ${extra.join(", ")} ${why}; recorded`);
  }

  /** Scheduling for a task that already has a worker thread (frozen deps):
   * its hard deps were met at dispatch, so only resources and the cap count. */
  private scheduleHeld(taskId: number, settings: CosSettings) {
    const deps = this.store.getSchedule(taskId).deps;
    if (deps === null) return { eligible: true, layer: null, reason: null } as const;
    return schedulingDecision({
      deps: { ...deps, dependsOn: [] },
      active: this.store.activeFeatureRuns().filter((run) => run.taskId !== taskId),
      maxFeatureRuns: settings.maxFeatureRuns,
      depDone: () => true,
    });
  }

  /** Local checkout of the BB project (default local_path source), if any. */
  private async projectRepo(projectId: string): Promise<string | null> {
    try {
      const project = (await this.bb.sdk.projects.get({ projectId } as never)) as unknown as {
        sources?: Array<{ type?: string; path?: string; isDefault?: boolean }>;
      };
      const sources = (project?.sources ?? []).filter((source) => source.type === "local_path" && typeof source.path === "string");
      const chosen = sources.find((source) => source.isDefault) ?? sources[0];
      return chosen?.path ?? null;
    } catch {
      return null;
    }
  }

  private async spawnWorker(task: VikunjaTask, settings: CosSettings, meta: TaskMeta): Promise<string> {
    const base = {
      projectId: settings.project,
      environment: { type: "project-default" } as const,
      prompt: buildWorkerPrompt(task, this.planFor(meta, settings)),
      title: `#${task.id} ${task.title}`.slice(0, 120),
      pluginMetadata: { itemId: String(task.id), mode: meta.mode },
    };
    const model = meta.mode === "feature" ? settings.featureWorkerModel : settings.taskWorkerModel;
    if (settings.workerProvider !== "" && model !== "") {
      try {
        const thread = await this.bb.sdk.threads.spawn({
          ...base,
          providerId: settings.workerProvider,
          model,
          ...(settings.workerReasoning === "" ? {} : { reasoningLevel: settings.workerReasoning }),
        });
        return thread.id;
      } catch (cause) {
        this.bb.log.warn(
          `spawn with ${settings.workerProvider}/${model} failed (${cause instanceof Error ? cause.message : String(cause)}); retrying with the project default`,
        );
      }
    }
    const thread = await this.bb.sdk.threads.spawn(base);
    return thread.id;
  }

  private async threadAlive(threadId: string) {
    try {
      return await this.bb.sdk.threads.get({ threadId });
    } catch {
      return null;
    }
  }

  /** Best-effort comment on the Vikunja task; never blocks the sweep. */
  private async commentOnTask(task: VikunjaTask, comment: string): Promise<void> {
    try {
      await this.vikunja("call", {
        name: "task_comments_create",
        arguments: { task: task.id, comment, format: "markdown" },
      });
    } catch (cause) {
      this.bb.log.warn(
        `comment on task ${task.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** Kanban views of a Vikunja project (cached), from projects_read. */
  private async kanbanViews(projectId: number): Promise<KanbanView[]> {
    const cached = this.viewCache.get(projectId);
    if (cached !== undefined && Date.now() - cached.at < VIEW_CACHE_MS) return cached.views;
    const project = await this.vikunja<{ views?: unknown }>("call", { name: "projects_read", arguments: { id: projectId } });
    const views = (Array.isArray(project?.views) ? project.views : [])
      .filter((view): view is { id: number; view_kind?: unknown; done_bucket_id?: unknown } =>
        typeof view === "object" && view !== null && typeof (view as { id?: unknown }).id === "number")
      .filter((view) => view.view_kind === "kanban" || view.view_kind === 3)
      .map((view) => ({ id: view.id, doneBucketId: typeof view.done_bucket_id === "number" && view.done_bucket_id > 0 ? view.done_bucket_id : null }));
    this.viewCache.set(projectId, { views, at: Date.now() });
    return views;
  }

  /**
   * Best-effort move of a task's card to a column in every kanban view of its
   * project. Buckets are looked up by name per project/view (no hardcoded
   * ids); Testing falls back to Doing on boards without a testing column.
   * Never throws; failures are logged.
   */
  async moveTaskToColumn(card: CardRef, column: BoardColumn, why: string): Promise<boolean> {
    if (this.columns.get(card.id) === column) return false;
    let moved = false;
    let effective: BoardColumn = column;
    try {
      let views = await this.kanbanViews(card.projectId);
      if (views.length === 0 && typeof card.viewId === "number") views = [{ id: card.viewId, doneBucketId: null }];
      if (views.length === 0) {
        this.bb.log.warn(`move task ${card.id} to ${column}: project ${card.projectId} has no kanban view`);
        return false;
      }
      for (const view of views) {
        const buckets = parseBuckets(await this.vikunja<unknown>("buckets", { project: card.projectId, view: view.id }));
        const target = bucketForColumn(buckets, column, view.doneBucketId);
        if (target === null) {
          this.bb.log.warn(
            `move task ${card.id} to ${column}: no matching bucket in project ${card.projectId} view ${view.id} (buckets: ${buckets.map((bucket) => bucket.title).join(", ") || "none"})`,
          );
          continue;
        }
        effective = target.column;
        if ((card.viewId === view.id && card.bucketId === target.bucket.id) || this.columns.get(card.id) === target.column) {
          moved = true;
          continue;
        }
        await this.vikunja("move", { project: card.projectId, view: view.id, bucket: target.bucket.id, task: card.id });
        moved = true;
        this.bb.log.info(
          `moved task ${card.id} to ${target.bucket.title} (project ${card.projectId} view ${view.id}${target.column !== column ? ", no " + column + " column" : ""}; ${why})`,
        );
      }
    } catch (cause) {
      this.bb.log.warn(`move task ${card.id} to ${column}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
    if (moved) this.columns.set(card.id, effective);
    return moved;
  }

  private async moveTaskToDoing(task: VikunjaTask): Promise<void> {
    this.columns.delete(task.id); // a fresh dispatch always (re)asserts Doing
    await this.moveTaskToColumn(task, "doing", "dispatched");
  }

  /**
   * Feature drivers: read the live run (id, status, current phase) from the
   * workflows plugin and store it, so status, brief and kanban never depend on
   * the driver reporting each phase. Uses the reported run id, else the latest
   * run started from the driver thread. Returns the live phase (the last known
   * one once the run is terminal), or null when the run cannot be read.
   */
  async refreshLiveRun(taskId: number, threadId: string): Promise<string | null> {
    const meta = this.store.getTaskMeta(taskId);
    if (meta === null || meta.mode !== "feature") return null;
    type RunView = { id?: unknown; status?: unknown; currentPhase?: unknown };
    let run: RunView | null = null;
    for (const runId of meta.workflowRunId === null ? [null] : [meta.workflowRunId, null]) {
      try {
        const view: { run?: RunView | null } | null = await this.workflowsRpc<{ run?: RunView | null }>("workflowRunView", { threadId, runId });
        run = view?.run ?? null;
        if (run !== null) break;
      } catch {
        // reported run not started from this thread (e.g. adopted driver): try its latest run
      }
    }
    if (run === null || typeof run.id !== "string") return null;
    const status = typeof run.status === "string" ? run.status : null;
    const phase = typeof run.currentPhase === "string" && run.currentPhase !== "" ? run.currentPhase : meta.workflowPhase;
    if (meta.workflowRunId !== run.id || meta.runStatus !== status || meta.workflowPhase !== phase) {
      this.store.setTaskMeta(taskId, { workflowRunId: run.id, runStatus: status, workflowPhase: phase, phaseAt: Date.now() });
      this.publish();
    } else {
      this.store.setTaskMeta(taskId, { phaseAt: Date.now() });
    }
    return phase;
  }

  /** Live run views for every active/paused feature task with a driver thread (CLI, panel, brief). */
  async refreshLivePhases(): Promise<void> {
    for (const row of this.store.listTasks()) {
      if (row.threadId === null || row.state === "closed") continue;
      await this.refreshLiveRun(row.taskId, row.threadId);
    }
  }

  /** Feature drivers: follow the live workflow phase (timeline fallback) on the kanban. */
  private async syncWorkflowPhase(taskId: number, projectId: number, threadId: string): Promise<void> {
    let phase: string | null = await this.refreshLiveRun(taskId, threadId);
    if (phase === null) {
      try {
        const timeline = await this.bb.sdk.threads.timeline({ threadId, deferContent: "true" } as never);
        phase = workflowPhaseFromTimeline(timeline);
      } catch {
        return; // optional; the driver's phase reports still move the card
      }
    }
    const column = columnForPhase(phase);
    if (column !== null && column !== "done") {
      await this.moveTaskToColumn({ id: taskId, projectId }, column, `workflow phase ${phase}`);
    }
  }

  private async sendToThread(threadId: string, text: string): Promise<void> {
    await this.bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  /** Registers the task↔thread link so both plugins agree on the pairing. */
  private async registerLink(taskId: number, threadId: string): Promise<void> {
    try {
      await this.vikunja("link", { task: taskId, thread: threadId });
    } catch (cause) {
      this.bb.log.warn(
        `link task ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** Adopts a task that already has a linked thread (reuse, never respawn). */
  private async adoptTask(task: VikunjaTask, threadId: string, now: number, settings: CosSettings): Promise<void> {
    const meta = await this.metaFor(task, settings);
    // The tools are gated on pluginMetadata.itemId; claim the thread so the
    // next turn constructs its session with chief_of_staff_* available.
    try {
      await this.bb.sdk.threads.updatePluginMetadata({ threadId, set: { itemId: String(task.id), mode: meta.mode } });
    } catch (cause) {
      this.bb.log.warn(
        `claim thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    this.store.upsertTask(
      { taskId: task.id, title: task.title, projectId: task.projectId, lastTaskUpdated: task.updated },
      now,
    );
    this.store.updateTask(
      task.id,
      { threadId, state: "active", progressNote: "adopted existing thread", progressAt: now, stalled: 0, nudgeCount: 0 },
      now,
    );
    await this.sendToThread(
      threadId,
      [
        `The Chief of Staff plugin now manages Vikunja task #${task.id} (${JSON.stringify(task.title)}). Continue working on it. From now on, report with chief_of_staff_report and, when blocked on the user, call chief_of_staff_ask.`,
        "",
        "Operating rules from now on:",
        ...operatingRules(this.planFor(meta, settings)),
      ].join("\n"),
    );
    this.bb.log.info(`adopted thread ${threadId} for task ${task.id}`);
  }

  private async introduceTask(task: VikunjaTask, settings: CosSettings): Promise<void> {
    const now = Date.now();
    // Reuse first: the vikunja plugin's task↔thread links.
    let links: string[] = [];
    try {
      links = await this.vikunja<string[]>("links", { task: task.id });
    } catch (cause) {
      this.bb.log.warn(
        `links for task ${task.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    // Feature tasks are scheduled before anything runs, adopted threads included
    // (an adopted driver would otherwise relaunch its run beside a conflicting one).
    const meta = await this.metaFor(task, settings);
    const scheduled = meta.mode === "feature" ? await this.scheduleFeature(task, meta, settings) : null;
    if (scheduled === null || scheduled.decision.eligible) {
      for (const candidate of [...links].reverse()) {
        const alive = await this.threadAlive(candidate);
        if (alive === null || alive.archivedAt !== null) continue;
        await this.adoptTask(task, candidate, now, settings);
        if (scheduled !== null) this.store.setSchedule(task.id, { deps: scheduled.deps, blockReason: null });
        await this.moveTaskToDoing(task);
        return;
      }
    }
    // No reusable thread: spawn a fresh worker, within the concurrency budget.
    let deps: TaskDeps | null = null;
    if (scheduled !== null) {
      deps = scheduled.deps;
      if (!scheduled.decision.eligible) {
        const reason = scheduled.decision.reason!;
        this.store.upsertTask(
          { taskId: task.id, title: task.title, projectId: task.projectId, lastTaskUpdated: task.updated },
          now,
        );
        this.store.updateTask(task.id, { state: "paused", error: reason }, now);
        // Comment only when the blocking reason changes (not every sweep).
        if (this.store.getSchedule(task.id).blockReason !== reason) {
          this.store.setSchedule(task.id, { blockReason: reason });
          await this.commentOnTask(
            task,
            `Chief of Staff: not started yet — ${reason}. Dependency layers: ${describeDeps(deps)} (soft deps never block).`,
          );
        }
        return;
      }
    }
    const active = this.store.listTasksWithState("active").length;
    if (active >= settings.maxConcurrent) {
      this.store.upsertTask(
        { taskId: task.id, title: task.title, projectId: task.projectId, lastTaskUpdated: task.updated },
        now,
      );
      this.store.updateTask(task.id, { state: "paused", error: `waiting for a free worker slot (${active}/${settings.maxConcurrent})` }, now);
      return;
    }
    let threadId: string;
    try {
      threadId = await this.spawnWorker(task, settings, meta);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.store.upsertTask(
        { taskId: task.id, title: task.title, projectId: task.projectId, lastTaskUpdated: task.updated },
        now,
      );
      this.store.updateTask(task.id, { error: `spawn failed: ${message}` }, now);
      this.bb.log.warn(`spawn for task ${task.id}: ${message}`);
      return;
    }
    this.store.upsertTask(
      { taskId: task.id, title: task.title, projectId: task.projectId, lastTaskUpdated: task.updated },
      now,
    );
    if (deps !== null) this.store.setSchedule(task.id, { deps, blockReason: null });
    this.store.updateTask(
      task.id,
      {
        threadId,
        state: "active",
        launchedAt: now,
        progressNote: "worker launched",
        progressAt: now,
        stalled: 0,
        nudgeCount: 0,
        error: null,
      },
      now,
    );
    await this.registerLink(task.id, threadId);
    await this.moveTaskToDoing(task);
    await this.commentOnTask(
      task,
      meta.mode === "feature"
        ? `Chief of Staff: dispatched a worker that runs this through the \`${settings.workflowName}\` workflow (feature \`${meta.feature}\`${meta.deployRequested ? ", delivery requested" : ""}). Dependency layers: ${describeDeps(deps ?? classifyDependencies(task, meta.feature))}.`
        : "Chief of Staff: dispatched a worker thread for this task.",
    );
    this.bb.log.info(`spawned thread ${threadId} for task ${task.id}`);
  }

  // ---- question triage ----

  /**
   * The chief_of_staff_ask tool. Answered immediately when a policy matches;
   * otherwise parks a decision for the user and settles when they answer.
   */
  async ask(threadId: string, input: AskInput, signal: AbortSignal): Promise<string> {
    const task = this.store.taskByThreadId(threadId);
    if (task === null) {
      return "This thread is not a Chief of Staff worker, so nobody is watching for an answer. Decide yourself.";
    }
    const question = input.question.trim();
    const meta = this.store.getTaskMeta(task.taskId);
    const deployRequested = meta?.deployRequested ?? false;
    const triage = classifyQuestion(`${question}\n${input.context ?? ""}`, deployRequested, input.kind);

    if (triage === "deploy-allowed") {
      const detail = triageQuestion(`${question}\n${input.context ?? ""}`, deployRequested, input.kind);
      const answer = detail.reason.includes("standing policy")
        ? "Push after a green merge is standing policy: once everything is merged to local main and tests pass, `git push origin main` (never force) and report what you pushed. Do not deploy unless the task asked for a deploy/release. Anything else irreversible still needs Denis."
        : "This task explicitly asks for the deploy/release, so it is allowed: after a green merge to local main and all tests pass, `git push origin main` (never force; standing policy), then use the documented deploy procedure for the affected area only, and report what you did. Anything else irreversible still needs Denis.";
      this.store.insertDecision({
        itemId: String(task.taskId),
        threadId,
        question,
        context: input.context ?? null,
        options: input.options ?? [],
        status: "answered",
        answer,
        autoAnswered: true,
        answeredAt: Date.now(),
      });
      this.briefSoon();
      this.publish();
      return `ANSWER (chief of staff: deploy requested by the task): ${answer}`;
    }

    const kind: DecisionKind = triage === "irreversible" ? "irreversible" : "routine";
    if (kind === "routine") {
      const policy = matchPolicy(question, this.store.listPolicies());
      if (policy !== null) {
        this.store.insertDecision({
          itemId: String(task.taskId),
          threadId,
          question,
          context: input.context ?? null,
          options: input.options ?? [],
          status: "answered",
          answer: policy.answer,
          autoAnswered: true,
          answeredAt: Date.now(),
        });
        this.briefSoon();
        this.publish();
        return `ANSWER (chief of staff policy on "${policy.keywords.join(", ")}"): ${policy.answer}`;
      }
    }

    const decision = this.store.insertDecision({
      itemId: String(task.taskId),
      threadId,
      question,
      context: input.context ?? null,
      options: input.options ?? [],
    });
    this.store.setDecisionKind(decision.id, kind);
    this.publish();
    this.bb.log.info(`${kind} decision ${decision.id} pending on task ${task.taskId}`);
    // Irreversible decisions never time out into "best judgment".
    const timeoutMs = kind === "irreversible" ? null : (await this.readSettings()).decisionTimeoutHours * 60 * 60 * 1000;

    return await new Promise<string>((resolve) => {
      let settled = false;
      const settle = (outcome: AskOutcome) => {
        if (settled) return;
        settled = true;
        this.resolvers.delete(decision.id);
        if (timer !== null) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (outcome.kind === "answered") {
          resolve(describeAnswer("answered", outcome.answer, kind));
        } else if (outcome.kind === "dismissed") {
          resolve(describeAnswer("dismissed", "", kind));
        } else if (outcome.kind === "timeout") {
          this.store.updateDecision(decision.id, { status: "dismissed", answer: null, answeredAt: Date.now() });
          resolve(describeAnswer("timeout", "", kind));
        } else {
          // Withdrawn (thread stopped/archived/deleted, or plugin disposal):
          // nobody can answer it through the tool any more, so it must not
          // linger in the panel as pending.
          this.store.updateDecision(decision.id, { status: "dismissed", answer: null, answeredAt: Date.now() });
          resolve(describeAnswer("withdrawn", "", kind));
        }
      };
      const timer = timeoutMs === null ? null : setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      const onAbort = () => settle({ kind: "withdrawn" });
      signal.addEventListener("abort", onAbort, { once: true });
      this.resolvers.set(decision.id, settle);
    });
  }

  /**
   * Close every pending decision for a task whose work is over (reported
   * done, closed in Vikunja, or its worker thread is gone). Live ask-tool
   * calls settle with "dismissed"; the panel never keeps an orphan question.
   */
  private dismissStaleDecisionsForTask(taskId: number): void {
    for (const decision of this.store.listDecisions()) {
      if (decision.status !== "pending" || decision.itemId !== String(taskId)) continue;
      this.store.updateDecision(decision.id, { status: "dismissed", answeredAt: Date.now() });
      const resolver = this.resolvers.get(decision.id);
      if (resolver !== undefined) {
        this.resolvers.delete(decision.id);
        resolver({ kind: "dismissed" });
      }
    }
  }

  /** Best-effort notice to a worker thread; a dead thread must never fail
   * the user's answer/dismiss action, which is already recorded. */
  private async notifyThreadBestEffort(threadId: string, text: string): Promise<void> {
    try {
      await this.sendToThread(threadId, text);
    } catch (cause) {
      this.bb.log.warn(
        `notify thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async answerDecision(id: string, answer: string, rememberKeywords?: string): Promise<DecisionRow | null> {
    const decision = this.store.getDecision(id);
    if (decision === null || decision.status !== "pending") return decision;
    const settled = this.store.updateDecision(id, {
      status: "answered",
      answer,
      answeredAt: Date.now(),
    })!;
    if (rememberKeywords !== undefined && rememberKeywords.trim() !== "") {
      this.store.addPolicy(parseKeywords(rememberKeywords), answer);
    }
    const resolver = this.resolvers.get(id);
    if (resolver !== undefined) {
      this.resolvers.delete(id);
      resolver({ kind: "answered", answer });
    } else if (decision.threadId !== null) {
      // The waiting tool call died with a plugin reload; still reach the worker.
      await this.notifyThreadBestEffort(
        decision.threadId,
        `Chief of staff, answering your ${this.store.decisionKind(id) === "irreversible" ? "irreversible-action " : ""}question "${decision.question}": ${answer}`,
      );
    }
    await this.refreshBriefing();
    this.publish();
    return settled;
  }

  async dismissDecision(id: string): Promise<DecisionRow | null> {
    const decision = this.store.getDecision(id);
    if (decision === null || decision.status !== "pending") return decision;
    const settled = this.store.updateDecision(id, { status: "dismissed", answeredAt: Date.now() })!;
    const resolver = this.resolvers.get(id);
    if (resolver !== undefined) {
      this.resolvers.delete(id);
      resolver({ kind: "dismissed" });
    } else if (decision.threadId !== null) {
      await this.notifyThreadBestEffort(
        decision.threadId,
        this.store.decisionKind(id) === "irreversible"
          ? `Chief of staff: Denis did not approve the irreversible action in "${decision.question}". Do NOT perform it; continue with reversible work and report blocked if nothing else can be done.`
          : `Chief of staff: the user dismissed your question "${decision.question}" without an answer. Proceed using your best judgment and note the choice in your final report.`,
      );
    }
    await this.refreshBriefing();
    this.publish();
    return settled;
  }

  // ---- worker reports ----

  report(threadId: string, stage: ReportStage, note: string | null, workflow: WorkflowReport = {}): string {
    const task = this.store.taskByThreadId(threadId);
    if (task === null) {
      return "This thread is not a Chief of Staff worker; the report was ignored.";
    }
    const now = Date.now();
    const trimmed = note?.trim() ?? null;
    let meta = this.store.getTaskMeta(task.taskId);
    if (meta !== null && (workflow.runId !== undefined || workflow.status !== undefined)) {
      meta = this.store.setTaskMeta(task.taskId, {
        ...(workflow.runId === undefined ? {} : { workflowRunId: workflow.runId }),
        ...(workflow.status === undefined ? {} : { workflowStatus: workflow.status }),
      });
    }
    if (stage === "done" && meta?.mode === "feature" && !featureDoneAllowed(meta.workflowStatus, meta.deployRequested)) {
      const needed = meta.deployRequested ? '"delivered"' : '"merged-to-main"';
      this.store.updateTask(task.taskId, {
        progressNote: `done rejected: workflow status ${meta.workflowStatus ?? "unknown"}`,
        progressAt: now,
      });
      this.briefSoon();
      this.publish();
      return `NOT ACCEPTED: task #${task.taskId} is a feature; it closes only when the ${meta.workflowStatus === null ? "workflow" : "workflow (currently " + JSON.stringify(meta.workflowStatus) + ")"} returns status ${needed}. Pass workflowStatus and workflowRunId with the report, or report "blocked" with the workflow's report.`;
    }
    if (stage !== "done") {
      const phase = workflow.phase ?? (meta?.mode === "feature" ? phaseFromNote(trimmed) : null);
      const column = columnForPhase(phase);
      if (column !== null && column !== "done") {
        void this.moveTaskToColumn({ id: task.taskId, projectId: task.projectId }, column, `reported phase ${phase}`);
      }
    }
    switch (stage) {
      case "started":
        this.store.updateTask(task.taskId, { progressNote: trimmed ?? "started", progressAt: now, stalled: 0, nudgeCount: 0 });
        break;
      case "progress":
        this.store.updateTask(task.taskId, { progressNote: trimmed ?? "in progress", progressAt: now, stalled: 0, nudgeCount: 0 });
        break;
      case "blocked":
        this.store.updateTask(task.taskId, { progressNote: `blocked: ${trimmed ?? "no detail"}`, progressAt: now });
        break;
      case "done": {
        // Closed in Vikunja while a Merge/Deliver was in flight: the task is already
        // done/deleted/unassigned there, so do not touch it; keep the pending marker
        // so the next sweep stops/archives the worker and leaves the close comment.
        const closingFromVikunja = task.error?.startsWith(VIKUNJA_CLOSE_PENDING) ?? false;
        this.store.updateTask(task.taskId, {
          state: "closed",
          closedAt: now,
          progressNote: trimmed ?? "reported done",
          progressAt: now,
          stalled: 0,
          error: closingFromVikunja ? task.error : null,
        });
        this.dismissStaleDecisionsForTask(task.taskId);
        if (!closingFromVikunja) void this.completeInVikunja(task.taskId, task.projectId, trimmed ?? "reported done");
        break;
      }
      case "failed":
        this.store.updateTask(task.taskId, {
          error: trimmed ?? "worker reported failure",
          progressAt: now,
          stalled: 0,
        });
        void this.commentOnTaskId(task.taskId, `Chief of Staff: worker reported failure — ${trimmed ?? "no detail"}`);
        break;
    }
    this.briefSoon();
    this.publish();
    return `Recorded ${stage} for task #${task.taskId}.`;
  }

  /** Moves the card to Done (by bucket name, else the view's done bucket) and marks the task done. */
  private async completeInVikunja(taskId: number, projectId: number, note: string): Promise<void> {
    try {
      await this.vikunja("call", { name: "tasks_update", arguments: { task: taskId, done: true } });
      await this.moveTaskToColumn({ id: taskId, projectId }, "done", "worker reported done");
      await this.commentOnTaskId(taskId, `Chief of Staff: worker reported done — ${note}`);
    } catch (cause) {
      this.bb.log.warn(
        `complete task ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private async commentOnTaskId(taskId: number, comment: string): Promise<void> {
    try {
      await this.vikunja("call", {
        name: "task_comments_create",
        arguments: { task: taskId, comment, format: "markdown" },
      });
    } catch (cause) {
      this.bb.log.warn(
        `comment on task ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  // ---- task lifecycle (panel/CLI) ----

  private async stopThreadQuietly(threadId: string): Promise<void> {
    try {
      await this.bb.sdk.threads.stop({ threadId });
    } catch (cause) {
      this.bb.log.warn(`stop thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private async archiveThreadQuietly(threadId: string): Promise<void> {
    try {
      await this.bb.sdk.threads.archive({ threadId });
    } catch (cause) {
      this.bb.log.warn(`archive thread ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private async workflowsRpc<T>(method: string, input: unknown): Promise<T> {
    return this.bb.sdk.plugins.callRpc<T>({
      pluginId: WORKFLOWS_PLUGIN_ID,
      method,
      input: input as never,
      outputSchema: z.unknown() as never,
    }) as Promise<T>;
  }

  /** Queued/running workflow runs started from a worker thread; null when the workflows plugin cannot be asked. */
  private async activeRunsForThread(threadId: string): Promise<ActiveRunView[] | null> {
    try {
      const result = await this.workflowsRpc<{ runs?: unknown }>("workflowActiveRuns", { threadId });
      const runs = Array.isArray(result?.runs) ? result.runs : [];
      return runs
        .filter((run): run is { id: string; status?: unknown; currentPhase?: unknown } =>
          typeof run === "object" && run !== null && typeof (run as { id?: unknown }).id === "string")
        .map((run) => ({
          id: run.id,
          status: typeof run.status === "string" ? run.status : "unknown",
          currentPhase: typeof run.currentPhase === "string" ? run.currentPhase : null,
        }))
        .filter((run) => run.status === "queued" || run.status === "running");
    } catch (cause) {
      this.bb.log.warn(`active runs for ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  /**
   * Why a tracked task is no longer an open CTO-bot task, confirmed with a direct
   * lookup (the bulk list can miss a task transiently). null = still open, or the
   * lookup failed: never close on a guess.
   */
  private async confirmLeftVikunja(taskId: number, assignee: string): Promise<LeftVikunja | null> {
    try {
      const envelope = await this.vikunja<unknown>("call", {
        name: "tasks_list",
        arguments: { page: 1, per_page: 50, filter: `id = ${taskId}` },
      });
      const parsed = parseVikunjaTasksPage(envelope);
      if (parsed === null) return null;
      const task = parsed.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) return parsed.tasks.length === 0 ? "deleted" : null;
      if (task.done) return "done";
      if (filterByAssignee([task], assignee).length === 0) return "unassigned";
      return null;
    } catch (cause) {
      this.bb.log.warn(`confirm task ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  /**
   * Closes a tracked task that is done, deleted or unassigned in Vikunja, whatever
   * its plugin state (active, paused, waiting on a decision). Cancels the worker's
   * queued/running workflow runs (a cancelled run's feature-delivery lock and queue
   * entry count as stale, so the next run takes the lock; the closed row frees the
   * maxFeatureRuns/maxConcurrent slot), stops and archives the worker thread, and
   * leaves one Vikunja comment. A run in Merge/Deliver is never cancelled: the row
   * keeps a pending marker and a later sweep closes it once the run moved on.
   * Idempotent: closed rows without the marker are never revisited.
   */
  private async closeTaskLeftVikunja(row: TaskRow, why: LeftVikunja): Promise<void> {
    const threadId = row.threadId;
    const thread = threadId === null ? null : await this.threadAlive(threadId);
    const live = threadId !== null && thread !== null && thread.archivedAt === null;
    const stoppedRuns: string[] = [];
    if (live) {
      const runs = await this.activeRunsForThread(threadId);
      if (runs === null) {
        // Cannot see the runs: do not archive (that would stop them blind); retry next sweep.
        if (this.store.getTaskMeta(row.taskId)?.mode === "feature") return;
      } else {
        const critical = runs.find((run) => UNINTERRUPTIBLE_PHASES.has((run.currentPhase ?? "").toLowerCase()));
        if (critical !== undefined) {
          const note = `${VIKUNJA_CLOSE_PENDING} ${critical.currentPhase} of ${critical.id} to finish`;
          if (row.error !== note) {
            this.store.updateTask(row.taskId, { error: note });
            this.bb.log.info(`task ${row.taskId} ${why} in Vikunja; waiting for ${critical.currentPhase} of ${critical.id} before closing`);
          }
          return;
        }
        for (const run of runs) {
          try {
            await this.workflowsRpc("workflowStopRun", { threadId, runId: run.id });
            stoppedRuns.push(run.id);
          } catch (cause) {
            this.bb.log.warn(`stop run ${run.id} for task ${row.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
            return; // retry next sweep; never leave a run behind a closed row
          }
        }
      }
      // The worker already reported done after the Merge: let its last turn finish.
      if (row.state === "closed" && thread.status !== "idle") return;
    }
    const now = Date.now();
    this.store.updateTask(row.taskId, {
      state: "closed",
      closedAt: row.closedAt ?? now,
      stalled: 0,
      error: null,
      progressNote: `closed in Vikunja (${why})`,
      progressAt: now,
    });
    this.dismissStaleDecisionsForTask(row.taskId);
    if (live) {
      await this.stopThreadQuietly(threadId);
      await this.archiveThreadQuietly(threadId);
    }
    this.bb.log.info(
      `task ${row.taskId} ${why} in Vikunja: closed${live ? `, stopped worker ${threadId}` : ""}${stoppedRuns.length > 0 ? `, cancelled ${stoppedRuns.join(", ")}` : ""}`,
    );
    if (why !== "deleted") {
      const stopped = [live ? "worker" : null, stoppedRuns.length > 0 ? "run" : null].filter(Boolean).join("/");
      await this.commentOnTaskId(
        row.taskId,
        `Chief of Staff: closed in Vikunja (${why}); ${stopped === "" ? "nothing was running" : `stopped ${stopped}`}${stoppedRuns.length > 0 ? ` (${stoppedRuns.join(", ")})` : ""}.`,
      );
    }
  }

  async pauseTask(taskId: number): Promise<TaskRow | null> {
    const task = this.store.getTask(taskId);
    if (task === null) return null;
    if (task.state !== "active") throw new Error(`Task #${taskId} is ${task.state}; only active tasks can pause`);
    if (task.threadId !== null) await this.stopThreadQuietly(task.threadId);
    const updated = this.store.updateTask(taskId, { state: "paused", stalled: 0, error: null })!;
    await this.refreshBriefing();
    this.publish();
    return updated;
  }

  /** A feature driver held back by the scheduler continues once its resources are free. */
  private async resumeIfEligible(taskId: number, threadId: string, settings: CosSettings): Promise<void> {
    const decision = this.scheduleHeld(taskId, settings);
    if (!decision.eligible) {
      if (this.store.getSchedule(taskId).blockReason !== decision.reason) {
        this.store.setSchedule(taskId, { blockReason: decision.reason });
        this.store.updateTask(taskId, { error: SCHEDULER_HOLD + decision.reason! });
      }
      return;
    }
    const alive = await this.threadAlive(threadId);
    if (alive === null || alive.archivedAt !== null) {
      this.store.updateTask(taskId, { threadId: null, state: "paused", error: "worker thread is gone" });
      return;
    }
    await this.sendToThread(
      threadId,
      "The resources this task needs are free now (the Chief of Staff held it back while a conflicting run used the device). Continue now: check your workflow run with `bb workflows status`; if it is not running, launch ONE fresh run, and report 'progress' with its run id.",
    );
    this.store.setSchedule(taskId, { blockReason: null });
    this.store.updateTask(taskId, {
      state: "active",
      progressNote: "resumed by scheduler (resources free)",
      progressAt: Date.now(),
      stalled: 0,
      nudgeCount: 0,
      error: null,
    });
  }

  async resumeTask(taskId: number): Promise<TaskRow | null> {
    const task = this.store.getTask(taskId);
    if (task === null) return null;
    if (task.state !== "paused") throw new Error(`Task #${taskId} is ${task.state}; only paused tasks can resume`);
    if (task.threadId !== null && (await this.threadAlive(task.threadId)) !== null) {
      if (this.store.getTaskMeta(taskId)?.mode === "feature") {
        // Never resume a feature driver beside a run holding its (or a conflicting) resource.
        await this.recordLeaseResources();
        const decision = this.scheduleHeld(taskId, await this.readSettings());
        if (!decision.eligible) {
          const updated = this.store.updateTask(taskId, { error: SCHEDULER_HOLD + decision.reason! })!;
          this.store.setSchedule(taskId, { blockReason: decision.reason });
          await this.refreshBriefing();
          this.publish();
          return updated;
        }
        this.store.setSchedule(taskId, { blockReason: null });
      }
      await this.sendToThread(
        task.threadId,
        "The user resumed this task. Continue working on it now, starting with a chief_of_staff_report stage 'progress' note on where you left off.",
      );
      const updated = this.store.updateTask(taskId, {
        state: "active",
        progressNote: "resumed",
        progressAt: Date.now(),
        stalled: 0,
        nudgeCount: 0,
        error: null,
      })!;
      await this.refreshBriefing();
      this.publish();
      return updated;
    }
    // No usable thread: clear it and let the next sweep reintroduce the task.
    const updated = this.store.updateTask(taskId, { threadId: null })!;
    await this.sweep();
    return this.store.getTask(taskId) ?? updated;
  }

  // ---- events and monitoring ----

  wake(): void {
    this.wakeResolve?.();
  }

  async handleThreadFailed(threadId: string, error: string | null): Promise<void> {
    const task = this.store.taskByThreadId(threadId);
    if (task === null || task.state !== "active") return;
    if (task.retries < AUTO_RETRIES) {
      try {
        await this.bb.sdk.threads.retry({ threadId, reason: "Chief of Staff auto-retry" });
        this.store.updateTask(task.taskId, { retries: task.retries + 1, progressAt: Date.now() });
        this.bb.log.info(`auto-retried failed worker for task ${task.taskId}`);
      } catch (cause) {
        this.bb.log.warn(`retry task ${task.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.store.updateTask(task.taskId, { error: error ?? "worker thread failed" });
      }
    } else {
      this.store.updateTask(task.taskId, { error: error ?? "worker thread failed after retry" });
    }
    await this.refreshBriefing();
    this.publish();
  }

  handleThreadGone(threadId: string, why: "archived" | "deleted"): void {
    const task = this.store.taskByThreadId(threadId);
    if (task === null) return;
    if (task.state === "active") {
      this.store.updateTask(task.taskId, { threadId: null, error: `worker thread ${why}` });
    } else if (task.state === "paused") {
      this.store.updateTask(task.taskId, { threadId: null });
    }
    // Its questions can no longer be answered through the tool.
    this.dismissStaleDecisionsForTask(task.taskId);
    this.briefSoon();
    this.publish();
  }

  /** One pass of the monitor: reconcile Vikunja tasks with worker threads. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const settings = await this.readSettings();
      const configured = await this.vikunjaConfigured();
      if (!configured) {
        await this.refreshBriefing(false);
        return;
      }

      let tasks: VikunjaTask[];
      try {
        tasks = await this.fetchManagedTasks(settings.assignee);
      } catch (cause) {
        this.bb.log.warn(
          `fetch tasks: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        await this.refreshBriefing(true);
        return;
      }
      const open = new Map(tasks.map((task) => [task.id, task]));
      const now = Date.now();

      // Rows whose task left the open set (done, deleted, or unassigned in Vikunja),
      // in any plugin state; each one is confirmed individually before closing. Runs
      // first so a freed feature slot is reused by this same sweep.
      for (const row of this.store.listTasks()) {
        if (open.has(row.taskId)) continue;
        const pendingClose = row.error?.startsWith(VIKUNJA_CLOSE_PENDING) ?? false;
        if (row.state === "closed" && !pendingClose) continue;
        const why = await this.confirmLeftVikunja(row.taskId, settings.assignee);
        if (why === null) continue;
        await this.closeTaskLeftVikunja(row, why);
      }

      // Running feature tasks dispatched before dependency layers existed get
      // theirs recorded first, so this sweep's scheduling sees their resources.
      for (const task of tasks) {
        const row = this.store.getTask(task.id);
        const meta = this.store.getTaskMeta(task.id);
        if (row?.threadId != null && meta?.mode === "feature" && this.store.getSchedule(task.id).deps === null) {
          this.depsFor(task, meta);
        }
      }
      await this.recordLeaseResources();

      for (const task of tasks) {
        const row = this.store.getTask(task.id);
        if (row === null || row.threadId === null) {
          await this.introduceTask(task, settings);
          continue;
        }
        // Keep the row's title fresh even when nothing else changes.
        if (row.title !== task.title || row.projectId !== task.projectId) {
          this.store.updateTask(task.id, { title: task.title, projectId: task.projectId });
        }
        if (row.error?.startsWith(VIKUNJA_CLOSE_PENDING) && row.state !== "closed") {
          // Reopened/reassigned while the close waited on a Merge: keep working.
          this.store.updateTask(task.id, { error: null });
        }
        if (row.state === "paused") {
          this.store.updateTask(task.id, { lastTaskUpdated: task.updated });
          if (row.error?.startsWith(SCHEDULER_HOLD)) await this.resumeIfEligible(task.id, row.threadId, settings);
          continue;
        }
        if (row.state === "closed") {
          // The task was reopened in Vikunja.
          this.store.updateTask(task.id, { state: "active", closedAt: null, error: null });
        }

        const alive = await this.threadAlive(row.threadId);
        if (alive === null || alive.archivedAt !== null) {
          this.store.updateTask(task.id, { threadId: null, error: "worker thread is gone" });
          await this.introduceTask(task, settings);
          continue;
        }

        if (task.updated !== row.lastTaskUpdated) {
          this.store.updateTask(task.id, { lastTaskUpdated: task.updated });
          if (alive.status === "idle") {
            try {
              await this.sendToThread(
                row.threadId,
                `Your Vikunja task was updated: #${task.id} is now "${task.title}". Re-read the task details and continue with the latest version.`,
              );
            } catch (cause) {
              this.bb.log.warn(
                `task-update notice ${task.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
        }

        // Feature cards follow the workflow phase (Doing ↔ Testing).
        const rowMeta = this.store.getTaskMeta(task.id);
        if (rowMeta?.mode === "feature") await this.syncWorkflowPhase(task.id, task.projectId, row.threadId);

        // Keep moving: nudge idle, quiet workers that are not waiting on the user.
        if (this.store.hasPendingDecisionForTask(task.id)) continue;
        // An idle driver whose workflow run is queued/running is waiting for the
        // run's completion notification, not stuck: never nudge it.
        const liveStatus = this.store.getTaskMeta(task.id)?.runStatus ?? null;
        if (rowMeta?.mode === "feature" && (liveStatus === "queued" || liveStatus === "running")) {
          if (row.stalled === 1) this.store.updateTask(task.id, { stalled: 0 });
          continue;
        }
        const thread = await this.threadAlive(row.threadId);
        if (thread === null || thread.status !== "idle") {
          if (row.stalled === 1) this.store.updateTask(task.id, { stalled: 0 });
          continue;
        }
        const lastActivity = row.progressAt ?? row.launchedAt ?? row.updatedAt;
        if (now - lastActivity < settings.stallMinutes * 60_000) continue;
        if (row.nudgeCount >= settings.maxNudges) {
          if (row.stalled === 0) this.store.updateTask(task.id, { stalled: 1 });
          continue;
        }
        try {
          await this.sendToThread(
            row.threadId,
            "Status check from your chief of staff: report where you are with chief_of_staff_report (stage 'progress' and a short note), or stage 'done' if the task is finished. If you are blocked on the user, call chief_of_staff_ask now.",
          );
          this.store.updateTask(task.id, { nudgeCount: row.nudgeCount + 1, progressAt: now });
          this.bb.log.info(`nudged idle worker for task ${task.id} (nudge ${row.nudgeCount + 1})`);
        } catch (cause) {
          this.bb.log.warn(
            `nudge task ${task.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }

      await this.refreshBriefing(true);
      this.publish();
    } finally {
      this.sweeping = false;
    }
  }

  async runService(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.sweep();
      } catch (cause) {
        this.bb.log.warn(`sweep: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const seconds = (await this.readSettings()).pollSeconds;
      await this.sleep(seconds * 1000, signal);
    }
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    if (this.wakeDeferred === null) {
      this.wakeDeferred = new Promise((resolve) => {
        this.wakeResolve = resolve;
      });
    }
    await Promise.race([
      timeout,
      this.wakeDeferred,
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    ]);
    clearTimeout(timer);
    this.wakeDeferred = null;
    this.wakeResolve = null;
  }

  // ---- briefings and overview ----

  /** Fire-and-forget briefing refresh; a late refresh after disposal (closed
   * database) must never surface as an unhandled rejection. */
  private briefSoon(): void {
    this.refreshBriefing().catch((cause: unknown) => {
      this.bb.log.warn(`briefing: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  async refreshBriefing(configured?: boolean): Promise<BriefingRow> {
    const ready = configured ?? (await this.vikunjaConfigured());
    if (!this.sweeping) await this.refreshLivePhases(); // the sweep already refreshed them
    const latest = this.store.latestBriefing();
    const tasks = this.store.listTasks();
    const pending = this.store.listDecisions().filter((decision) => decision.status === "pending");
    const byId = new Map(tasks.map((task) => [String(task.taskId), task]));
    const now = Date.now();
    const briefing = buildBriefing({
      now,
      lastBriefingAt: latest === null ? null : latest.createdAt,
      configured: ready,
      tasks: tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        progressNote: task.progressNote,
        progressAt: task.progressAt,
        stalled: task.stalled === 1,
        nudgeCount: task.nudgeCount,
        threadStatus: null,
        error: task.error,
        closedAt: task.closedAt,
        ...this.liveRunBrief(task.taskId),
      })),
      pendingDecisions: pending.flatMap((decision) => {
        const task = byId.get(decision.itemId);
        if (task === undefined) return [];
        return [{ taskId: task.taskId, taskTitle: task.title, question: decision.question }];
      }),
    });
    if (latest !== null && latest.signature === briefing.signature) return latest;
    return this.store.saveBriefing({ createdAt: now, text: briefing.text, signature: briefing.signature });
  }

  async overview(): Promise<Overview> {
    await this.refreshLivePhases();
    const settings = await this.readSettings();
    const configured = await this.vikunjaConfigured();
    const tasks = this.store.listTasks();
    const decisions = this.store.listDecisions();
    const byId = new Map(tasks.map((task) => [String(task.taskId), task]));

    const views: TaskView[] = [];
    for (const task of tasks) {
      let threadStatus: string | null = null;
      if (task.threadId !== null && (task.state === "active" || task.state === "paused")) {
        const alive = await this.threadAlive(task.threadId);
        threadStatus = alive === null ? "gone" : alive.status;
      }
      views.push({
        taskId: task.taskId,
        title: task.title,
        projectId: task.projectId,
        state: task.state,
        threadId: task.threadId,
        progressNote: task.progressNote,
        progressAt: task.progressAt,
        stalled: task.stalled === 1,
        nudgeCount: task.nudgeCount,
        error: task.error,
        threadStatus,
        ...this.metaView(task.taskId),
      });
    }

    const briefing = this.store.latestBriefing();
    return {
      configured,
      assignee: settings.assignee,
      settings: {
        maxConcurrent: settings.maxConcurrent,
        stallMinutes: settings.stallMinutes,
        maxNudges: settings.maxNudges,
      },
      counts: {
        active: tasks.filter((task) => task.state === "active").length,
        paused: tasks.filter((task) => task.state === "paused").length,
        closed: tasks.filter((task) => task.state === "closed").length,
        pendingDecisions: decisions.filter((decision) => decision.status === "pending").length,
      },
      briefing: briefing === null ? null : { id: briefing.id, createdAt: briefing.createdAt, text: briefing.text },
      tasks: views,
      decisions: decisions.map((decision) => {
        const task = byId.get(decision.itemId);
        return {
          id: decision.id,
          taskId: task?.taskId ?? null,
          taskTitle: task?.title ?? null,
          question: decision.question,
          context: decision.context,
          options: decision.options,
          status: decision.status,
          answer: decision.answer,
          autoAnswered: decision.autoAnswered === 1,
          askedAt: decision.askedAt,
          answeredAt: decision.answeredAt,
          kind: this.store.decisionKind(decision.id),
        };
      }),
      policies: this.store.listPolicies().map((policy) => ({
        id: policy.id,
        keywords: policy.keywords,
        answer: policy.answer,
        source: policy.source,
      })),
    };
  }

  metaView(
    taskId: number,
  ): Pick<TaskView, "mode" | "deployRequested" | "workflowStatus" | "workflowPhase" | "runStatus" | "dependsOn" | "resources" | "softAfter" | "blockReason"> {
    const meta = this.store.getTaskMeta(taskId);
    const schedule = this.store.getSchedule(taskId);
    const row = this.store.getTask(taskId);
    return {
      mode: meta?.mode ?? "task",
      deployRequested: meta?.deployRequested ?? false,
      workflowStatus: meta?.workflowStatus ?? null,
      workflowPhase: meta?.workflowPhase ?? null,
      runStatus: meta?.runStatus ?? null,
      dependsOn: schedule.deps?.dependsOn ?? [],
      resources: schedule.deps?.resources ?? [],
      softAfter: schedule.deps?.softAfter ?? [],
      blockReason: row?.state === "paused" ? schedule.blockReason : null,
    };
  }

  /** Dependency layers for the CLI line of a feature task ("" for plain tasks). */
  depsLabel(taskId: number): string {
    if (this.store.getTaskMeta(taskId)?.mode !== "feature") return "";
    const deps = this.store.getSchedule(taskId).deps;
    return deps === null ? "" : ` {${describeDeps(deps)}}`;
  }

  private liveRunBrief(taskId: number): { workflowPhase: string | null; runStatus: string | null } {
    const meta = this.store.getTaskMeta(taskId);
    if (meta?.mode !== "feature") return { workflowPhase: null, runStatus: null };
    return { workflowPhase: meta.workflowPhase, runStatus: meta.runStatus };
  }

  /** One-line status of a task's workflow for the CLI: live run first, reported status as fallback. */
  workflowLabel(taskId: number): string {
    const meta = this.store.getTaskMeta(taskId);
    if (meta?.mode !== "feature") return "";
    const live = [meta.runStatus, meta.workflowPhase === null ? null : `phase ${meta.workflowPhase}`].filter(Boolean).join(", ");
    if (live !== "") return `, feature ${live}${meta.workflowStatus !== null && meta.runStatus !== "running" && meta.runStatus !== "queued" ? ` (${meta.workflowStatus})` : ""}`;
    return `, feature${meta.workflowStatus === null ? "" : ` ${meta.workflowStatus}`}`;
  }

  // ---- plumbing ----

  /** Tell every open panel (and the snoozing service) that something changed. */
  publish(): void {
    this.bb.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });
    this.wake();
  }

  dispose(): void {
    for (const resolve of this.resolvers.values()) resolve({ kind: "withdrawn" });
    this.resolvers.clear();
    this.wake();
  }
}
