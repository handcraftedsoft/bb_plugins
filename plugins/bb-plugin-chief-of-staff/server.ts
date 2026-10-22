// bb-plugin-chief-of-staff — a BB plugin backend entry.
//
// The Chief of Staff runs the Vikunja backlog for one assignee (CTO-bot):
// every open task assigned to that user gets a worker thread in the
// configured BB project — reusing a linked thread when one exists — while the
// plugin answers routine worker questions from the policy table, escalates
// the rest as decisions, writes progress back to the kanban, and briefs the
// user. Registration only happens here; behavior lives in runtime.ts and the
// pure pieces in logic.ts / store.ts.
import { cliCommand, defineCli, defineRpcContract, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { ChiefOfStaff } from "./runtime";
import { ChiefStore, SCHEMA } from "./store";
import { parseKeywords, type CosSettings, type TaskRow } from "./logic";

const taskViewSchema = z.object({
  taskId: z.number().int(),
  title: z.string(),
  projectId: z.number().int(),
  state: z.enum(["active", "paused", "closed"]),
  threadId: z.string().nullable(),
  progressNote: z.string().nullable(),
  progressAt: z.number().nullable(),
  stalled: z.boolean(),
  nudgeCount: z.number().int(),
  error: z.string().nullable(),
  threadStatus: z.string().nullable(),
});

const decisionViewSchema = z.object({
  id: z.string(),
  taskId: z.number().int().nullable(),
  taskTitle: z.string().nullable(),
  question: z.string(),
  context: z.string().nullable(),
  options: z.array(z.string()),
  status: z.enum(["pending", "answered", "dismissed"]),
  answer: z.string().nullable(),
  autoAnswered: z.boolean(),
  askedAt: z.number(),
  answeredAt: z.number().nullable(),
});

const policyViewSchema = z.object({
  id: z.string(),
  keywords: z.array(z.string()),
  answer: z.string(),
  source: z.enum(["builtin", "user"]),
});

const briefingViewSchema = z.object({
  id: z.number().int(),
  createdAt: z.number(),
  text: z.string(),
});

const overviewSchema = z.object({
  configured: z.boolean(),
  assignee: z.string(),
  settings: z.object({
    maxConcurrent: z.number().int(),
    stallMinutes: z.number().int(),
    maxNudges: z.number().int(),
  }),
  counts: z.object({
    active: z.number().int(),
    paused: z.number().int(),
    closed: z.number().int(),
    pendingDecisions: z.number().int(),
  }),
  briefing: briefingViewSchema.nullable(),
  tasks: z.array(taskViewSchema),
  decisions: z.array(decisionViewSchema),
  policies: z.array(policyViewSchema),
});

// Both schemas run at the wire boundary. Handler input/output are inferred
// from the shared contract; app.tsx imports only its type.
export const rpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: overviewSchema,
  },
  sync_now: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }),
  },
  task_pause: {
    input: z.object({ taskId: z.number().int().positive() }),
    output: z.object({ task: taskViewSchema }),
  },
  task_resume: {
    input: z.object({ taskId: z.number().int().positive() }),
    output: z.object({ task: taskViewSchema }),
  },
  decision_answer: {
    input: z.object({
      id: z.string(),
      answer: z.string().trim().min(1).max(4000),
      rememberPolicyKeywords: z.string().trim().max(200).optional(),
    }),
    output: z.object({ decision: decisionViewSchema.nullable() }),
  },
  decision_dismiss: {
    input: z.object({ id: z.string() }),
    output: z.object({ decision: decisionViewSchema.nullable() }),
  },
  policy_add: {
    input: z.object({
      keywords: z.string().trim().min(1).max(200),
      answer: z.string().trim().min(1).max(2000),
    }),
    output: z.object({ policy: policyViewSchema }),
  },
  policy_remove: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  brief_now: {
    input: z.null(),
    output: z.object({ briefing: briefingViewSchema }),
  },
});

export type Overview = z.infer<typeof overviewSchema>;
export type TaskView = z.infer<typeof taskViewSchema>;
export type DecisionView = z.infer<typeof decisionViewSchema>;
export type PolicyView = z.infer<typeof policyViewSchema>;
export type BriefingView = z.infer<typeof briefingViewSchema>;

const DEFAULTS: CosSettings = {
  project: "proj_jjitzuscx6",
  assignee: "CTO-bot",
  maxConcurrent: 2,
  stallMinutes: 30,
  maxNudges: 2,
  pollSeconds: 60,
  decisionTimeoutHours: 24,
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Worker instructions for one managed thread; the title is quoted so
 * thread-controlled text reads as data, not directions. */
function workerInstructionsFor(title: string): string {
  return `You are working a Chief of Staff task: ${JSON.stringify(title)}. Use chief_of_staff_report to report progress and completion, and chief_of_staff_ask only when blocked on a question you cannot decide. If the ask tool errors or times out, proceed with your best judgment and note it in your final report.`;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    project: {
      type: "string",
      label: "BB project for new worker threads",
      default: DEFAULTS.project,
      experimental_schema: z.string().regex(/^proj_[a-z0-9]+$/, "Use a BB project id like proj_jjitzuscx6"),
    },
    assignee: {
      type: "string",
      label: "Vikunja assignee to manage",
      default: DEFAULTS.assignee,
      experimental_schema: z.string().trim().min(1).max(80),
    },
    maxConcurrent: {
      type: "number",
      label: "Max concurrent workers",
      default: DEFAULTS.maxConcurrent,
      experimental_schema: z.number().int().min(1).max(8),
    },
    stallMinutes: {
      type: "number",
      label: "Idle minutes before a nudge",
      default: DEFAULTS.stallMinutes,
      experimental_schema: z.number().int().min(5).max(240),
    },
    maxNudges: {
      type: "number",
      label: "Nudges before flagging stalled",
      default: DEFAULTS.maxNudges,
      experimental_schema: z.number().int().min(1).max(5),
    },
    pollSeconds: {
      type: "number",
      label: "Vikunja poll interval (seconds)",
      default: DEFAULTS.pollSeconds,
      experimental_schema: z.number().int().min(15).max(600),
    },
    decisionTimeoutHours: {
      type: "number",
      label: "Hours to wait for a decision",
      default: DEFAULTS.decisionTimeoutHours,
      experimental_schema: z.number().int().min(1).max(168),
    },
  });

  async function readSettings(): Promise<CosSettings> {
    const values = await settings.get();
    return {
      project:
        typeof values.project === "string" && values.project !== "" ? values.project : DEFAULTS.project,
      assignee:
        typeof values.assignee === "string" && values.assignee.trim() !== ""
          ? values.assignee.trim()
          : DEFAULTS.assignee,
      maxConcurrent: clampInt(values.maxConcurrent, DEFAULTS.maxConcurrent, 1, 8),
      stallMinutes: clampInt(values.stallMinutes, DEFAULTS.stallMinutes, 5, 240),
      maxNudges: clampInt(values.maxNudges, DEFAULTS.maxNudges, 1, 5),
      pollSeconds: clampInt(values.pollSeconds, DEFAULTS.pollSeconds, 15, 600),
      decisionTimeoutHours: clampInt(values.decisionTimeoutHours, DEFAULTS.decisionTimeoutHours, 1, 168),
    };
  }

  const db = bb.storage.database();
  bb.storage.migrate(db, SCHEMA);
  const store = new ChiefStore(db);
  const chief = new ChiefOfStaff(bb, store, readSettings);

  /** Board writes from the panel/CLI land here so briefings and panels update. */
  async function boardChanged(): Promise<void> {
    await chief.refreshBriefing();
    chief.publish();
  }

  function requireTask(ref: string): TaskRow {
    const taskId = Number(ref.replace(/^#/u, ""));
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new PluginCliError(`not a Vikunja task id: ${JSON.stringify(ref)}`, {
        code: "bad_task",
        hint: 'Use the numeric task id, e.g. 6 (from Vikunja or "bb chief tasks").',
      });
    }
    const task = store.getTask(taskId);
    if (task === null) {
      throw new PluginCliError(`task #${taskId} is not managed yet`, {
        code: "task_not_found",
        hint: 'Run "bb chief sync" first so the chief of staff picks the task up.',
      });
    }
    return task;
  }

  // ---- agent tools (gated to worker threads by pluginMetadata) ----

  bb.agents.registerTool({
    name: "chief_of_staff_ask",
    description:
      "Ask your chief of staff a question. Returns immediately when standing policy covers it; otherwise it waits for the user's decision and may take hours. Only call when blocked on a question you cannot decide yourself.",
    instructions:
      "chief_of_staff_ask reaches the user through the Chief of Staff plugin. Try to decide routine matters yourself; ask only when genuinely blocked. If it errors or times out, proceed with your best judgment and note the decision in your final report.",
    presentation: {
      label: {
        pending: "Asking the chief of staff",
        completed: "Asked the chief of staff",
      },
    },
    parameters: z.object({
      question: z.string().min(3).max(2000),
      context: z.string().max(2000).optional(),
      options: z.array(z.string().max(200)).max(6).optional(),
    }),
    async execute({ question, context, options }, ctx) {
      return chief.ask(ctx.threadId, { question, context, options }, ctx.signal);
    },
  });

  bb.agents.registerTool({
    name: "chief_of_staff_report",
    description:
      "Report progress on your task: 'started' when you begin, 'progress' after each meaningful step, 'done' when complete (this closes the Vikunja task), 'failed' if you cannot finish, 'blocked' when you cannot proceed.",
    presentation: {
      label: {
        pending: "Reporting to the chief of staff",
        completed: "Reported to the chief of staff",
      },
    },
    parameters: z.object({
      stage: z.enum(["started", "progress", "done", "failed", "blocked"]),
      note: z.string().max(1000).optional(),
    }),
    execute({ stage, note }, ctx) {
      return chief.report(ctx.threadId, stage, note ?? null);
    },
  });

  bb.agents.configure((context) => {
    const itemId = context.pluginMetadata.itemId;
    if (typeof itemId !== "string" || itemId === "") {
      return { tools: [], skills: [] };
    }
    const title = context.thread.title;
    return {
      tools: ["chief_of_staff_ask", "chief_of_staff_report"],
      skills: [],
      ...(title === null ? {} : { instructions: workerInstructionsFor(title) }),
    };
  });

  // ---- thread lifecycle events keep the board current between sweeps ----

  bb.events.on("thread.idle", ({ thread }) => {
    if (store.taskByThreadId(thread.id) === null) return;
    chief.wake(); // a worker finished a turn; check whether it needs a nudge now
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    void chief.handleThreadFailed(thread.id, error);
  });
  bb.events.on("thread.archived", ({ thread }) => chief.handleThreadGone(thread.id, "archived"));
  bb.events.on("thread.deleted", ({ thread }) => chief.handleThreadGone(thread.id, "deleted"));

  // ---- RPC (the panel's data plane) ----

  bb.rpc.register(rpcContract, {
    overview: async () => chief.overview(),
    sync_now: async () => {
      await chief.sweep();
      return { ok: true };
    },
    task_pause: async ({ taskId }) => {
      const task = await chief.pauseTask(taskId);
      if (task === null) throw new Error(`No managed task #${taskId}`);
      return { task: toTaskView(task, null) };
    },
    task_resume: async ({ taskId }) => {
      const task = await chief.resumeTask(taskId);
      if (task === null) throw new Error(`No managed task #${taskId}`);
      return { task: toTaskView(task, null) };
    },
    decision_answer: async ({ id, answer, rememberPolicyKeywords }) => {
      const decision = await chief.answerDecision(id, answer, rememberPolicyKeywords);
      return { decision: decisionView(decision) };
    },
    decision_dismiss: async ({ id }) => {
      const decision = await chief.dismissDecision(id);
      return { decision: decisionView(decision) };
    },
    policy_add: async ({ keywords, answer }) => {
      const policy = store.addPolicy(parseKeywords(keywords), answer);
      await boardChanged();
      return { policy };
    },
    policy_remove: async ({ id }) => {
      const removed = store.removePolicy(id);
      await boardChanged();
      return { removed };
    },
    brief_now: async () => ({ briefing: await chief.refreshBriefing() }),
  });

  function toTaskView(task: TaskRow, threadStatus: string | null): TaskView {
    return {
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
    };
  }

  function decisionView(decision: ReturnType<ChiefStore["getDecision"]>): DecisionView | null {
    if (decision === null) return null;
    const task = store.getTask(Number(decision.itemId));
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
    };
  }

  // ---- CLI ----

  bb.cli.register(
    defineCli({
      name: "chief",
      summary: "Drive the Chief of Staff: Vikunja tasks for CTO-bot, decisions, policies, briefings",
      commands: {
        sync: cliCommand({
          summary: "Poll Vikunja now and reconcile worker threads",
          async run() {
            await chief.sweep();
            return { exitCode: 0, stdout: "Sync complete." };
          },
        }),
        tasks: cliCommand({
          summary: "List managed Vikunja tasks and their workers",
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const rows = store.listTasks();
            if (rows.length === 0) {
              return {
                exitCode: 0,
                stdout: `No managed tasks yet. Assign a Vikunja task to the managed user and run "bb chief sync".`,
              };
            }
            return reply(
              input.options.json,
              { tasks: rows },
              rows
                .map(
                  (task) =>
                    `#${task.taskId} (${task.state}) ${task.title}${task.progressNote === null ? "" : ` — ${task.progressNote}`}${task.error === null ? "" : ` [${task.error}]`}`,
                )
                .join("\n"),
            );
          },
        }),
        pause: taskCommand("pause", "Pause a task's worker (stops the thread)"),
        resume: taskCommand("resume", "Resume a paused task"),
        decisions: cliCommand({
          summary: "List decisions, pending first",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const decisions = store.listDecisions();
            return reply(
              input.options.json,
              { decisions },
              decisions.length === 0
                ? "No decisions yet."
                : decisions
                    .map(
                      (decision) =>
                        `${decision.status === "pending" ? "PENDING" : decision.status} ${decision.id} — ${decision.question}${decision.answer === null ? "" : ` → ${decision.answer}`}`,
                    )
                    .join("\n"),
            );
          },
        }),
        answer: cliCommand({
          summary: "Answer a pending decision",
          positionals: [
            { name: "decision-id", description: "Decision id from `bb chief decisions`", required: true },
            { name: "answer", description: "Your answer, quoted if it has spaces", required: true, variadic: true },
          ],
          options: {
            remember: { type: "string", description: "Also save this answer as policy for these keywords" },
          },
          async run(input) {
            const decision = await chief.answerDecision(
              input.positionals["decision-id"],
              input.positionals.answer.join(" "),
              input.options.remember,
            );
            if (decision === null) {
              throw new PluginCliError("no such decision", { code: "decision_not_found" });
            }
            return { exitCode: 0, stdout: decision.status === "answered" ? "Answered." : `Decision is ${decision.status}.` };
          },
        }),
        dismiss: cliCommand({
          summary: "Dismiss a pending decision",
          positionals: [{ name: "decision-id", description: "Decision id", required: true }],
          async run(input) {
            const decision = await chief.dismissDecision(input.positionals["decision-id"]);
            if (decision === null) {
              throw new PluginCliError("no such decision", { code: "decision_not_found" });
            }
            return { exitCode: 0, stdout: "Dismissed. The worker will proceed with its best judgment." };
          },
        }),
        policy: cliCommand({
          summary: "Manage auto-answer policies",
          positionals: [
            { name: "verb", description: "list | add | remove", required: true },
            { name: "rest", description: "verb arguments", variadic: true },
          ],
          async run(input) {
            const [verb, ...rest] = [input.positionals.verb, ...input.positionals.rest];
            if (verb === "list") {
              return {
                exitCode: 0,
                stdout:
                  store
                    .listPolicies()
                    .map((policy) => `${policy.id} (${policy.source}) [${policy.keywords.join(", ")}] ${policy.answer}`)
                    .join("\n") || "No policies.",
              };
            }
            if (verb === "add") {
              const keywords = rest[0];
              const answer = rest.slice(1).join(" ");
              if (keywords === undefined || answer === "") {
                throw new PluginCliError("usage: bb chief policy add <keywords> <answer...>", { code: "bad_usage" });
              }
              const policy = store.addPolicy(parseKeywords(keywords), answer);
              await boardChanged();
              return { exitCode: 0, stdout: `Added policy [${policy.keywords.join(", ")}]` };
            }
            if (verb === "remove") {
              const id = rest[0];
              if (id === undefined) throw new PluginCliError("usage: bb chief policy remove <id>", { code: "bad_usage" });
              return { exitCode: 0, stdout: store.removePolicy(id) ? "Removed." : "No such policy." };
            }
            throw new PluginCliError(`unknown policy verb ${JSON.stringify(verb)}`, { code: "bad_usage" });
          },
        }),
        brief: cliCommand({
          summary: "Print the current briefing",
          options: {
            refresh: { type: "boolean", description: "Recompute the briefing first" },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const briefing = input.options.refresh ? await chief.refreshBriefing() : store.latestBriefing();
            if (briefing === null) return { exitCode: 0, stdout: "No briefing yet. Run with --refresh." };
            return reply(input.options.json, { briefing }, briefing.text);
          },
        }),
      },
    }),
  );

  function reply(json: boolean | undefined, value: unknown, text: string) {
    return { exitCode: 0 as const, stdout: json === true ? JSON.stringify(value) : text };
  }

  function taskCommand(action: "pause" | "resume", summary: string) {
    return cliCommand({
      summary,
      positionals: [{ name: "task", description: "Vikunja task id, e.g. 6", required: true }],
      options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
      async run(input) {
        const task = requireTask(input.positionals.task);
        const result = action === "pause" ? await chief.pauseTask(task.taskId) : await chief.resumeTask(task.taskId);
        if (result === null) throw new PluginCliError(`task #${task.taskId} vanished`, { code: "task_not_found" });
        return reply(
          input.options.json,
          { task: toTaskView(result, null) },
          `Task #${result.taskId} is now ${result.state}.`,
        );
      },
    });
  }

  // ---- the monitor ----

  bb.background.service("monitor", {
    async start(signal) {
      await chief.runService(signal);
    },
  });

  bb.onDispose(() => {
    chief.dispose();
    bb.log.info("disposed");
  });
}
