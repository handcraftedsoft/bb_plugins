// The Chief of Staff runtime: watches Vikunja for tasks assigned to the
// managed user (CTO-bot), reuses or spawns one BB worker thread per task in
// the configured project, keeps workers moving, triages their questions, and
// composes briefings. Vikunja access goes through the vikunja plugin's RPC
// (call / links / link / buckets / move / status) via bb.sdk.plugins.callRpc.
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  buildBriefing,
  buildWorkerPrompt,
  CHANGED_CHANNEL,
  classifyQuestion,
  classifyTask,
  describeAnswer,
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
const DOING_BUCKET = /^(doing|in progress|wip)$/i;

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
}

type AskOutcome = { kind: "answered"; answer: string } | { kind: "dismissed" } | { kind: "withdrawn" | "timeout" };

export class ChiefOfStaff {
  private readonly resolvers = new Map<string, (outcome: AskOutcome) => void>();
  private wakeDeferred: Promise<void> | null = null;
  private wakeResolve: (() => void) | null = null;
  private sweeping = false;

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
  private metaFor(task: VikunjaTask, settings: CosSettings): TaskMeta {
    const existing = this.store.getTaskMeta(task.id);
    if (existing !== null) return existing;
    return this.store.setTaskMeta(task.id, classifyTask(task, settings.featureLabel));
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

  /** Best-effort move of the task to its kanban view's "Doing" bucket. */
  private async moveTaskToDoing(task: VikunjaTask): Promise<void> {
    if (task.viewId === null || task.bucketId === null) return;
    if (task.bucketTitle !== null && DOING_BUCKET.test(task.bucketTitle)) return;
    try {
      const buckets = await this.vikunja<Array<{ id?: unknown; title?: unknown }>>("buckets", {
        project: task.projectId,
        view: task.viewId,
      });
      const target = Array.isArray(buckets)
        ? buckets.find((bucket) => typeof bucket.title === "string" && DOING_BUCKET.test(bucket.title))
        : undefined;
      if (target === undefined || typeof target.id !== "number") return;
      await this.vikunja("move", { project: task.projectId, view: task.viewId, bucket: target.id, task: task.id });
    } catch (cause) {
      this.bb.log.warn(
        `move task ${task.id} to Doing: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
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
    const meta = this.metaFor(task, settings);
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
    for (const candidate of [...links].reverse()) {
      const alive = await this.threadAlive(candidate);
      if (alive === null || alive.archivedAt !== null) continue;
      await this.adoptTask(task, candidate, now, settings);
      await this.moveTaskToDoing(task);
      return;
    }
    // No reusable thread: spawn a fresh worker, within the concurrency budget.
    const meta = this.metaFor(task, settings);
    if (meta.mode === "feature") {
      const running = this.store.countActiveFeatureTasks();
      if (running >= settings.maxFeatureRuns) {
        this.store.upsertTask(
          { taskId: task.id, title: task.title, projectId: task.projectId, lastTaskUpdated: task.updated },
          now,
        );
        this.store.updateTask(
          task.id,
          { state: "paused", error: `waiting for a feature-delivery slot (${running}/${settings.maxFeatureRuns})` },
          now,
        );
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
        ? `Chief of Staff: dispatched a worker that runs this through the \`${settings.workflowName}\` workflow (feature \`${meta.feature}\`${meta.deployRequested ? ", delivery requested" : ""}).`
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
      const answer =
        "This task explicitly asks for the push/deploy, so it is allowed: do it only after everything is merged to local main and all tests pass, push without force, use the documented deploy procedure for the affected area, and report what you did. Anything else irreversible still needs Denis.";
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
      case "done":
        this.store.updateTask(task.taskId, {
          state: "closed",
          closedAt: now,
          progressNote: trimmed ?? "reported done",
          progressAt: now,
          stalled: 0,
          error: null,
        });
        this.dismissStaleDecisionsForTask(task.taskId);
        void this.completeInVikunja(task.taskId, trimmed ?? "reported done");
        break;
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

  /** Marks the Vikunja task done (its kanban moves it to the Done bucket). */
  private async completeInVikunja(taskId: number, note: string): Promise<void> {
    try {
      await this.vikunja("call", { name: "tasks_update", arguments: { task: taskId, done: true } });
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

  async resumeTask(taskId: number): Promise<TaskRow | null> {
    const task = this.store.getTask(taskId);
    if (task === null) return null;
    if (task.state !== "paused") throw new Error(`Task #${taskId} is ${task.state}; only paused tasks can resume`);
    if (task.threadId !== null && (await this.threadAlive(task.threadId)) !== null) {
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
        if (row.state === "paused") {
          this.store.updateTask(task.id, { lastTaskUpdated: task.updated });
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

        // Keep moving: nudge idle, quiet workers that are not waiting on the user.
        if (this.store.hasPendingDecisionForTask(task.id)) continue;
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

      // Rows whose task left the open set: completed, closed, or unassigned.
      for (const row of this.store.listTasks()) {
        if (row.state !== "active" || open.has(row.taskId)) continue;
        this.store.updateTask(row.taskId, { state: "closed", closedAt: now, stalled: 0 });
        this.dismissStaleDecisionsForTask(row.taskId);
        if (row.threadId !== null && (await this.threadAlive(row.threadId)) !== null) {
          try {
            await this.sendToThread(
              row.threadId,
              "Your Vikunja task was completed or unassigned in the meantime. Wrap up and stop; no further work is needed.",
            );
          } catch {
            // the wrap-up notice is best effort
          }
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

  metaView(taskId: number): Pick<TaskView, "mode" | "deployRequested" | "workflowStatus"> {
    const meta = this.store.getTaskMeta(taskId);
    return {
      mode: meta?.mode ?? "task",
      deployRequested: meta?.deployRequested ?? false,
      workflowStatus: meta?.workflowStatus ?? null,
    };
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
