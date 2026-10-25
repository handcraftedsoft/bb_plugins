import { afterEach, expect, test, vi } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { runtimeHooks } from "./runtime";

/** Existing git branch/worktree names the slug collision check sees. */
let gitNamesInRepo: string[] = [];
runtimeHooks.gitNames = async () => gitNamesInRepo;
let mergedFeatures: string[] = [];
runtimeHooks.featureMerged = async (_repo, slug) => mergedFeatures.includes(slug);
/** Resources held by a workflow run's live lease (feature-delivery lock helper). */
let leaseByRun: Record<string, string[]> = {};
runtimeHooks.leaseResources = async (runId) => leaseByRun[runId] ?? null;

interface FakeTask {
  id: number;
  title: string;
  description?: string;
  done?: boolean;
  assignees?: string[];
  bucketTitle?: string;
  bucketId?: number;
  viewId?: number;
  updated?: string;
  project_id?: number;
  labels?: string[];
}

function envelope(tasks: FakeTask[]) {
  return {
    items: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description ?? "",
      done: task.done ?? false,
      project_id: task.project_id ?? 6,
      updated: task.updated ?? "2026-10-21T10:00:00Z",
      assignees: (task.assignees ?? []).map((username) => ({ id: 5, username })),
      labels: (task.labels ?? []).map((title, index) => ({ id: index + 1, title })),
      buckets:
        task.bucketId === undefined
          ? []
          : [{ id: task.bucketId, title: task.bucketTitle ?? "To-Do", project_view_id: task.viewId ?? 24 }],
    })),
    page: 1,
    per_page: 50,
    total: tasks.length,
    total_pages: 1,
  };
}

interface FakeBoardView {
  id: number;
  doneBucketId?: number;
  buckets: Array<{ id: number; title: string; position?: number }>;
}

interface FakeVikunja {
  tasks: FakeTask[];
  links?: Record<number, string[]>;
  /** Kanban views per Vikunja project (default: project 6, view 24, To-Do/Doing/Done). */
  boards?: Record<number, FakeBoardView[]>;
  /** Driver thread timeline payload per thread (workflow phase sync). */
  timelines?: Record<string, unknown>;
  /** Workflow runs per origin (driver) thread, served by the fake workflows plugin. */
  runs?: Record<string, FakeRun[]>;
  /** Makes the single-task Vikunja lookup (`id = N`) fail. */
  lookupError?: boolean;
}

interface FakeRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  currentPhase: string | null;
}

const DEFAULT_BOARDS: Record<number, FakeBoardView[]> = {
  6: [
    {
      id: 24,
      doneBucketId: 18,
      buckets: [
        { id: 16, title: "To-Do", position: 100 },
        { id: 17, title: "Doing", position: 200 },
        { id: 18, title: "Done", position: 300 },
      ],
    },
  ],
};

/** Vikunja v2 list endpoints return a paginated envelope, not a bare array. */
function page<T>(items: T[]) {
  return { $schema: "/api/v2/schemas/Page.json", items, page: 1, per_page: 50, total: items.length, total_pages: 1 };
}

async function makeHarness(fake: FakeVikunja, settings: Record<string, unknown> = {}) {
  let spawnCount = 0;
  const calls: Array<{ method: string; input: unknown }> = [];
  const workflowCalls: Array<{ method: string; input: unknown }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "chief-of-staff",
    settings: { project: "proj_jjitzuscx6", assignee: "CTO-bot", ...settings },
    sdk: {
      plugins: {
        callRpc: async (args: { pluginId?: string; method: string; input: unknown }) => {
          const input = args.input as Record<string, unknown> | null;
          if (args.pluginId === "workflows") {
            workflowCalls.push({ method: args.method, input: args.input });
            const runs = fake.runs?.[String(input?.threadId)] ?? [];
            if (args.method === "workflowActiveRuns") {
              return { runs: runs.filter((run) => run.status === "queued" || run.status === "running") };
            }
            if (args.method === "workflowRunView") {
              if (input?.runId === null) return { run: runs[runs.length - 1] ?? null };
              const run = runs.find((entry) => entry.id === input?.runId);
              if (run === undefined) throw new Error("This workflow run is not available in this thread");
              return { run };
            }
            if (args.method === "workflowStopRun") {
              const run = runs.find((entry) => entry.id === input?.runId);
              if (run === undefined) throw new Error("This workflow run is not available in this thread");
              run.status = "cancelled";
              return { stopped: true, run };
            }
            throw new Error(`unexpected workflows rpc: ${args.method}`);
          }
          calls.push({ method: args.method, input: args.input });
          if (args.method === "status") return { configured: true, origin: "https://tasks.example" };
          if (args.method === "links") return fake.links?.[Number(input?.task)] ?? [];
          if (args.method === "link") return [String(input?.thread)];
          const boards = fake.boards ?? DEFAULT_BOARDS;
          if (args.method === "buckets") {
            const view = (boards[Number(input?.project)] ?? []).find((entry) => entry.id === Number(input?.view));
            if (view === undefined) throw new Error(`no view ${String(input?.view)} in project ${String(input?.project)}`);
            return page(view.buckets.map((bucket) => ({ position: 0, ...bucket, project_view_id: view.id })));
          }
          if (args.method === "move") return {};
          if (args.method === "call") {
            const name = (input as { name?: string })?.name;
            if (name === "tasks_list") {
              const filter = String((input as { arguments?: { filter?: string } }).arguments?.filter ?? "");
              const byId = /^id = (\d+)$/.exec(filter);
              if (byId !== null) {
                if (fake.lookupError === true) throw new Error("Vikunja rejected the operation");
                return envelope(fake.tasks.filter((task) => task.id === Number(byId[1])));
              }
              return envelope(filter === "done = false" ? fake.tasks.filter((task) => task.done !== true) : fake.tasks);
            }
            if (name === "projects_read") {
              const id = Number((input as { arguments?: { id?: number } }).arguments?.id);
              return {
                id,
                views: [
                  { id: 900 + id, title: "List", view_kind: "list" },
                  ...(boards[id] ?? []).map((view) => ({ id: view.id, title: "Kanban", view_kind: "kanban", done_bucket_id: view.doneBucketId ?? 0 })),
                ],
              };
            }
            return {};
          }
          throw new Error(`unexpected vikunja rpc: ${args.method}`);
        },
      },
      threads: {
        spawn: async () => ({ id: `th_w${++spawnCount}` }),
        send: async () => ({}),
        get: async () => makeThreadResponse({ status: "idle" }),
        retry: async () => ({}),
        stop: async () => ({ ok: true }),
        archive: async () => ({}),
        updatePluginMetadata: async () => ({}),
        timeline: async (args: { threadId: string }) => {
          const payload = fake.timelines?.[args.threadId];
          if (payload === undefined) throw new Error("no timeline");
          return payload;
        },
      },
      projects: {
        get: async () => ({ id: "proj_jjitzuscx6", sources: [{ type: "local_path", path: "/repo", isDefault: true }] }),
      },
    },
  });
  await plugin(bb);
  return { harness, vikunjaCalls: calls, workflowCalls };
}

function syncNow(harness: Awaited<ReturnType<typeof makeHarness>>["harness"]) {
  return harness.behavior.runCli(["sync"]);
}

/** The ask tool registers its decision asynchronously; wait for it. */
async function waitPending(harness: Awaited<ReturnType<typeof makeHarness>>["harness"]) {
  await vi.waitFor(async () => {
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.pendingDecisions).toBe(1);
  });
}

test("sync spawns a worker in the configured project for a CTO-bot task", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 7, title: "Ship the export API", description: "CSV and JSON endpoints", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const spawns = harness.inspection.sdk.callsTo("threads.spawn");
    expect(spawns).toHaveLength(1);
    const args = spawns[0]![0] as Record<string, unknown>;
    expect(args.projectId).toBe("proj_jjitzuscx6");
    expect(args.title).toBe("#7 Ship the export API");
    expect(args.prompt).toContain("Ship the export API");
    expect(args.prompt).toContain("CSV and JSON endpoints");
    expect(args.prompt).toContain("chief_of_staff_report");
    expect((args.pluginMetadata as Record<string, unknown>).itemId).toBe("7");
    // The task is linked, moved to Doing, and noted with a comment.
    expect(vikunjaCalls).toContainEqual({ method: "link", input: { task: 7, thread: "th_w1" } });
    expect(vikunjaCalls).toContainEqual({ method: "move", input: { project: 6, view: 24, bucket: 17, task: 7 } });
    expect(
      vikunjaCalls.some(
        (call) => call.method === "call" && (call.input as { name?: string })?.name === "task_comments_create",
      ),
    ).toBe(true);
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.active).toBe(1);
    expect(overview.tasks[0]!.threadId).toBe("th_w1");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("tasks assigned to other users are ignored", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 8, title: "Not ours", assignees: ["mark"] }],
  });
  try {
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a task with a live linked thread is reused, not respawned", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 9, title: "Already routed", assignees: ["CTO-bot"] }],
    links: { 9: ["thr_existing"] },
  });
  try {
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    const metadata = harness.inspection.sdk.callsTo("threads.updatePluginMetadata")[0]![0] as Record<string, unknown>;
    expect(metadata.threadId).toBe("thr_existing");
    expect(metadata.set).toEqual({ itemId: "9", mode: "task" });
    const sends = harness.inspection.sdk.callsTo("threads.send");
    expect(sends.some((call) => ((call[0] as { input?: Array<{ text?: string }> }).input?.[0]?.text ?? "").includes("Chief of Staff plugin now manages"))).toBe(true);
    expect(vikunjaCalls.some((call) => call.method === "link")).toBe(false);
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.threadId).toBe("thr_existing");
    expect(overview.tasks[0]!.progressNote).toBe("adopted existing thread");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a worker reporting done closes the Vikunja task", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 10, title: "Finish fast", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const ack = await harness.behavior.callAgentTool(
      "chief_of_staff_report",
      { stage: "done", note: "shipped" },
      { threadId: "th_w1" },
    );
    expect(ack).toContain("done");
    expect(
      vikunjaCalls.some(
        (call) =>
          call.method === "call" &&
          (call.input as { name?: string })?.name === "tasks_update" &&
          ((call.input as { arguments?: { task?: number; done?: boolean } }).arguments?.done ?? false) === true,
      ),
    ).toBe(true);
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("closed");
    expect(overview.counts.closed).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("worker tools are gated to chief-of-staff worker threads", async () => {
  const { harness } = await makeHarness({ tasks: [] });
  try {
    const managed = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        pluginMetadata: { itemId: "7" },
        thread: { id: "t1", title: "Worker", parentThreadId: null, sourceThreadId: null },
      }),
    );
    expect(managed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["chief_of_staff_ask", "chief_of_staff_report"]),
    );
    expect(managed.instructions).toContain("Chief of Staff");
    const outsider = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: {} }),
    );
    expect(outsider.tools).toEqual([]);
    expect(outsider.instructions).toBeNull();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("policy questions are answered instantly without waiting for the user", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 11, title: "Ask about branches", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const answer = await harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Which branch should I use for this work?" },
      { threadId: "th_w1" },
    );
    expect(answer).toContain("policy");
    expect(answer).toContain("branch");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.pendingDecisions).toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("non-policy questions park a decision and the user's answer reaches the worker", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 12, title: "Pick a payments vendor", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Should we use Vendor A or Vendor B?", options: ["Vendor A", "Vendor B"] },
      { threadId: "th_w1" },
    );
    let overview = await harness.behavior.callRpc("overview", null);
    const decision = overview.decisions.find((entry) => entry.status === "pending");
    expect(decision).toBeDefined();
    expect(decision!.taskId).toBe(12);

    await harness.behavior.callRpc("decision_answer", { id: decision!.id, answer: "Vendor A" });
    expect(await pending).toBe("Decision from the user: Vendor A");
    overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.pendingDecisions).toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("an idle quiet worker is nudged, then flagged stalled instead of nudged forever", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 13, title: "Slow task", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  vi.useFakeTimers();
  try {
    await syncNow(harness);
    const advanceAndSweep = async (minutes: number) => {
      vi.setSystemTime(Date.now() + minutes * 60_000);
      await syncNow(harness);
    };
    await advanceAndSweep(31);
    await advanceAndSweep(31);
    await advanceAndSweep(31);
    vi.useRealTimers();

    const nudges = harness.inspection
      .sdk.callsTo("threads.send")
      .filter((call) => {
        const args = call[0] as { input?: Array<{ text?: string }> };
        return (args.input?.[0]?.text ?? "").includes("Status check");
      });
    expect(nudges).toHaveLength(2);

    const overview = await harness.behavior.callRpc("overview", null);
    const row = overview.tasks.find((entry) => entry.taskId === 13);
    expect(row?.stalled).toBe(true);
    expect(row?.nudgeCount).toBe(2);
    expect(overview.briefing?.text).toContain("Stalled");
  } finally {
    vi.useRealTimers();
    await harness.lifecycle.dispose();
  }
});

test("archiving a worker dismisses its pending question instead of orphaning it", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 16, title: "Question then archive", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Individual or Organization enrollment?" },
      { threadId: "th_w1" },
    );
    await waitPending(harness);
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "th_w1" }),
    });
    expect(await pending).toContain("dismissed this question without an answer");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.pendingDecisions).toBe(0);
    expect(overview.decisions.find((entry) => entry.status === "pending")).toBeUndefined();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("dismissing a decision whose worker thread is gone does not error", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 17, title: "Dead thread dismiss", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Should we keep the legacy flag on?" },
      { threadId: "th_w1" },
    );
    await waitPending(harness);
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "th_w1" }),
    });
    await pending;
    // The question was auto-dismissed with the thread; an explicit dismiss is a no-op, not an error.
    const overview = await harness.behavior.callRpc("overview", null);
    const decision = overview.decisions[0]!;
    const again = await harness.behavior.callRpc("decision_dismiss", { id: decision.id });
    expect(again.decision?.status).toBe("dismissed");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a worker reporting done dismisses its task's pending question", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 18, title: "Done with open question", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Which color scheme do you prefer?" },
      { threadId: "th_w1" },
    );
    await waitPending(harness);
    await harness.behavior.callAgentTool(
      "chief_of_staff_report",
      { stage: "done", note: "finished anyway" },
      { threadId: "th_w1" },
    );
    expect(await pending).toContain("dismissed this question without an answer");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.pendingDecisions).toBe(0);
    expect(overview.tasks[0]!.state).toBe("closed");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a failed worker is retried once, then the task carries the error", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 14, title: "Flaky task", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const failed = { thread: makeThreadResponse({ id: "th_w1" }), error: "provider exploded" };
    await harness.behavior.emitThreadEvent("thread.failed", failed);
    expect(harness.inspection.sdk.callsTo("threads.retry")).toHaveLength(1);
    await harness.behavior.emitThreadEvent("thread.failed", failed);
    expect(harness.inspection.sdk.callsTo("threads.retry")).toHaveLength(1);
    const overview = await harness.behavior.callRpc("overview", null);
    const row = overview.tasks.find((entry) => entry.taskId === 14);
    expect(row?.error).toContain("provider exploded");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the briefing names pending decisions and in-flight tasks", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 15, title: "Brief me", assignees: ["CTO-bot"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Do we keep the legacy API surface?" },
      { threadId: "th_w1" },
    );
    const result = await harness.behavior.runCli(["brief", "--refresh"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("NEEDS YOUR DECISION");
    expect(result.stdout).toContain("Do we keep the legacy API surface?");
    expect(result.stdout).toContain("Brief me");
    const overview = await harness.behavior.callRpc("overview", null);
    const decision = overview.decisions.find((entry) => entry.status === "pending");
    await harness.behavior.callRpc("decision_answer", { id: decision!.id, answer: "Keep it" });
    expect(await pending).toBe("Decision from the user: Keep it");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a feature-labelled task spawns a workflow driver on the cheap model with frozen args", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 21, title: "QR import", description: "Import WG configs from QR", assignees: ["CTO-bot"], labels: ["Feature"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const args = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(args.providerId).toBe("zcode");
    expect(args.model).toBe("account:zai-individual-coding-plan/GLM-5.3-Flash");
    expect((args.pluginMetadata as Record<string, unknown>).mode).toBe("feature");
    const prompt = String(args.prompt);
    expect(prompt).toContain("bb workflows run --name feature-delivery");
    expect(prompt).toContain('"feature":"qr-import"');
    expect(prompt).toContain('"deployRequested":false');
    expect(prompt).toContain("does NOT ask for a push");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.mode).toBe("feature");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("plain tasks spawn an implementer on GLM-5.3 and a 'feature:' line also routes to the workflow", async () => {
  const { harness } = await makeHarness({
    tasks: [
      { id: 22, title: "Fix typo in README", assignees: ["CTO-bot"], bucketId: 16 },
      { id: 23, title: "Something", description: "feature: landing-hero\nNew hero", assignees: ["CTO-bot"], bucketId: 16 },
    ],
  });
  try {
    await syncNow(harness);
    const spawns = harness.inspection.sdk.callsTo("threads.spawn").map((call) => call[0] as Record<string, unknown>);
    expect(spawns[0]!.model).toBe("account:zai-individual-coding-plan/GLM-5.3");
    expect(String(spawns[0]!.prompt)).toContain("merge your branch into local main");
    expect(String(spawns[1]!.prompt)).toContain('"feature":"landing-hero"');
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("only maxFeatureRuns feature tasks drive a workflow at once", async () => {
  const { harness } = await makeHarness({
    tasks: [
      { id: 24, title: "Feature one", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 25, title: "Feature two", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
    ],
  }, { maxFeatureRuns: 1 });
  try {
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    const overview = await harness.behavior.callRpc("overview", null);
    const waiting = overview.tasks.find((entry) => entry.taskId === 25);
    expect(waiting?.state).toBe("paused");
    expect(waiting?.error).toContain("feature-delivery slot");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a feature closes only once the workflow merged to main", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 26, title: "Gate me", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const early = await harness.behavior.callAgentTool("chief_of_staff_report", { stage: "done", note: "spec written" }, { threadId: "th_w1" });
    expect(early).toContain("NOT ACCEPTED");
    let overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("active");
    const partial = await harness.behavior.callAgentTool(
      "chief_of_staff_report",
      { stage: "done", workflowRunId: "run_1", workflowStatus: "partial" },
      { threadId: "th_w1" },
    );
    expect(partial).toContain("NOT ACCEPTED");
    const ok = await harness.behavior.callAgentTool(
      "chief_of_staff_report",
      { stage: "done", workflowRunId: "run_1", workflowStatus: "merged-to-main" },
      { threadId: "th_w1" },
    );
    expect(ok).toContain("Recorded done");
    overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("closed");
    expect(overview.tasks[0]!.workflowStatus).toBe("merged-to-main");
    expect(vikunjaCalls.some((call) => (call.input as { name?: string })?.name === "tasks_update")).toBe(true);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a feature that asked for a deploy needs workflow status delivered", async () => {
  const { harness } = await makeHarness({
    tasks: [{ id: 27, title: "Hero and redeploy prod after completion", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 }],
  });
  try {
    await syncNow(harness);
    const args = harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>;
    expect(String(args.prompt)).toContain('"deployRequested":true');
    const merged = await harness.behavior.callAgentTool(
      "chief_of_staff_report",
      { stage: "done", workflowStatus: "merged-to-main" },
      { threadId: "th_w1" },
    );
    expect(merged).toContain("NOT ACCEPTED");
    const delivered = await harness.behavior.callAgentTool(
      "chief_of_staff_report",
      { stage: "done", workflowStatus: "delivered" },
      { threadId: "th_w1" },
    );
    expect(delivered).toContain("Recorded done");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("irreversible questions bypass policy, never time out, and a dismissal means no", async () => {
  const { harness } = await makeHarness(
    { tasks: [{ id: 28, title: "Clean the DB", assignees: ["CTO-bot"], bucketId: 16 }] },
    { decisionTimeoutHours: 1 },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await syncNow(harness);
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Should I delete the old test branch data from the production database?" },
      { threadId: "th_w1" },
    );
    await vi.waitFor(async () => {
      const overview = await harness.behavior.callRpc("overview", null);
      expect(overview.counts.pendingDecisions).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    const overview = await harness.behavior.callRpc("overview", null);
    const decision = overview.decisions.find((entry) => entry.status === "pending");
    expect(decision?.kind).toBe("irreversible");
    await harness.behavior.callRpc("decision_dismiss", { id: decision!.id });
    expect(await pending).toContain("Do NOT perform it");
  } finally {
    vi.useRealTimers();
    await harness.lifecycle.dispose();
  }
});

test("push/deploy questions are allowed only when the task asked for them", async () => {
  const { harness } = await makeHarness({
    tasks: [
      { id: 29, title: "Update landing copy and deploy to production", assignees: ["CTO-bot"], bucketId: 16 },
      { id: 30, title: "Update landing copy", assignees: ["CTO-bot"], bucketId: 16 },
    ],
  });
  try {
    await syncNow(harness);
    const allowed = await harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Tests are green and main is merged. Should I push and deploy now?" },
      { threadId: "th_w1" },
    );
    expect(allowed).toContain("deploy requested by the task");
    const pending = harness.behavior.callAgentTool(
      "chief_of_staff_ask",
      { question: "Tests are green and main is merged. Should I push and deploy now?" },
      { threadId: "th_w2" },
    );
    await vi.waitFor(async () => {
      const overview = await harness.behavior.callRpc("overview", null);
      expect(overview.counts.pendingDecisions).toBe(1);
    });
    const overview = await harness.behavior.callRpc("overview", null);
    const decision = overview.decisions.find((entry) => entry.status === "pending");
    expect(decision?.kind).toBe("irreversible");
    await harness.behavior.callRpc("decision_answer", { id: decision!.id, answer: "Yes, push and deploy" });
    expect(await pending).toContain("Yes, push and deploy");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("built-in policies no longer forbid merging to main and tell plain tasks how to merge", async () => {
  const { harness } = await makeHarness({ tasks: [] });
  try {
    const overview = await harness.behavior.callRpc("overview", null);
    const answers = overview.policies.filter((policy) => policy.source === "builtin").map((policy) => policy.answer);
    expect(answers.some((answer) => answer.includes("Never commit directly to the default branch"))).toBe(false);
    expect(answers.some((answer) => answer.includes("LOCAL main is reversible"))).toBe(true);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the package imports only public SDK surfaces and allowed vendored UI deps", () => {
  // vitest rewrites import.meta.url to a dev-server URL; the suite runs from the package root.
  const scan = experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [
      /^react$/,
      /^react-dom$/,
      /^@radix-ui\//,
      /^@testing-library\//,
      /^clsx$/,
      /^class-variance-authority$/,
      /^tailwind-merge$/,
      /^sonner$/,
      /^vaul$/,
      /^@pierre\//,
      /^@\//,
      /^better-sqlite3$/,
      /^vitest(\/config)?$/,
    ],
  });
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});

afterEach(() => {
  vi.useRealTimers();
  gitNamesInRepo = [];
});

// ---------------------------------------------------------------------------
// Kanban column flow (Doing → Testing → Doing on repair → Done), deploy intent
// and feature slugs, against a fake Vikunja that returns v2 envelopes.

const PROJECT5_BOARD: Record<number, FakeBoardView[]> = {
  5: [
    {
      id: 20,
      doneBucketId: 15,
      buckets: [
        { id: 13, title: "To-Do", position: 100 },
        { id: 14, title: "Doing", position: 200 },
        { id: 22, title: "Testing", position: 250 },
        { id: 15, title: "Done", position: 300 },
      ],
    },
  ],
};

function moves(calls: Array<{ method: string; input: unknown }>) {
  return calls.filter((call) => call.method === "move").map((call) => call.input as Record<string, number>);
}

function report(harness: Awaited<ReturnType<typeof makeHarness>>["harness"], input: Record<string, unknown>, threadId = "th_w1") {
  return harness.behavior.callAgentTool("chief_of_staff_report", input, { threadId });
}

test("dispatch finds the Doing bucket by name from the v2 buckets envelope, even without the task's bucket info", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 40, title: "No bucket info", assignees: ["CTO-bot"], project_id: 5 }],
    boards: PROJECT5_BOARD,
  });
  try {
    await syncNow(harness);
    expect(moves(vikunjaCalls)).toEqual([{ project: 5, view: 20, bucket: 14, task: 40 }]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a feature card follows the workflow: Doing, Testing on Verify, Doing on repair, Done when merged", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 41, title: "Flow me", assignees: ["CTO-bot"], labels: ["feature"], project_id: 5, bucketId: 13, viewId: 20 }],
    boards: PROJECT5_BOARD,
  });
  try {
    await syncNow(harness);
    expect(moves(vikunjaCalls).at(-1)).toEqual({ project: 5, view: 20, bucket: 14, task: 41 });
    await report(harness, { stage: "progress", note: "spec approved", phase: "Build" });
    await vi.waitFor(() => expect(moves(vikunjaCalls)).toHaveLength(1)); // already in Doing: no re-move
    await report(harness, { stage: "progress", note: "lanes built", phase: "Verify" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).at(-1)).toEqual({ project: 5, view: 20, bucket: 22, task: 41 }));
    await report(harness, { stage: "progress", note: "verify failed, repairing", phase: "repair" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).at(-1)).toEqual({ project: 5, view: 20, bucket: 14, task: 41 }));
    await report(harness, { stage: "progress", note: "phase: Merge, checks running" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).at(-1)).toEqual({ project: 5, view: 20, bucket: 22, task: 41 }));
    await report(harness, { stage: "done", workflowRunId: "run_9", workflowStatus: "merged-to-main" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).at(-1)).toEqual({ project: 5, view: 20, bucket: 15, task: 41 }));
    expect(moves(vikunjaCalls).map((move) => move.bucket)).toEqual([14, 22, 14, 22, 15]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("bucket names match case-insensitively and a board without Testing falls back to Doing", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 42, title: "Shouty board", assignees: ["CTO-bot"], labels: ["feature"], project_id: 8 }],
    boards: {
      8: [
        {
          id: 31,
          buckets: [
            { id: 70, title: "BACKLOG", position: 1 },
            { id: 71, title: "in progress", position: 2 },
            { id: 72, title: "DONE", position: 3 },
          ],
        },
      ],
    },
  });
  try {
    await syncNow(harness);
    expect(moves(vikunjaCalls)).toEqual([{ project: 8, view: 31, bucket: 71, task: 42 }]);
    await report(harness, { stage: "progress", phase: "Verify" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(moves(vikunjaCalls)).toHaveLength(1); // Testing → Doing fallback; already there
    await report(harness, { stage: "done", workflowStatus: "merged-to-main" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).at(-1)).toEqual({ project: 8, view: 31, bucket: 72, task: 42 }));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a plain task goes to Testing only on a clean 'verifying' signal", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 43, title: "Plain fix", assignees: ["CTO-bot"], project_id: 5 }],
    boards: PROJECT5_BOARD,
  });
  try {
    await syncNow(harness);
    await report(harness, { stage: "progress", note: "phase: verify (just a note, plain tasks ignore notes)" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(moves(vikunjaCalls).map((move) => move.bucket)).toEqual([14]);
    await report(harness, { stage: "progress", note: "running the test suite", phase: "verifying" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).map((move) => move.bucket)).toEqual([14, 22]));
    await report(harness, { stage: "progress", note: "tests failed, fixing", phase: "building" });
    await vi.waitFor(() => expect(moves(vikunjaCalls).map((move) => move.bucket)).toEqual([14, 22, 14]));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the sweep moves a feature card to Testing when the driver's timeline shows a Verify agent", async () => {
  const { harness, vikunjaCalls } = await makeHarness({
    tasks: [{ id: 44, title: "Timeline", assignees: ["CTO-bot"], labels: ["feature"], project_id: 5 }],
    boards: PROJECT5_BOARD,
    timelines: {
      th_w1: {
        rows: [
          {
            workKind: "workflow",
            workflow: {
              agents: [
                { label: "build:android", state: "done", phaseTitle: "Build", startedAt: "2026-10-22T03:00:00Z" },
                { label: "verify:android", state: "running", phaseTitle: "Verify", startedAt: "2026-10-22T03:10:00Z" },
              ],
            },
          },
        ],
      },
    },
  });
  try {
    await syncNow(harness);
    await syncNow(harness);
    await vi.waitFor(() => expect(moves(vikunjaCalls).map((move) => move.bucket)).toEqual([14, 22]));
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("'Deploy: no' and negated or bare deploy mentions never set deployRequested", async () => {
  const { harness } = await makeHarness({
    tasks: [
      {
        id: 45,
        title: "Android e2e testing loop (unit, device, real tunnel)",
        description: "Size: normal\nfeature: android-e2e-loop\nDeploy: no\n\nGoal: deploy the APK to the emulator. Do not deploy the VPS.",
        assignees: ["CTO-bot"],
        labels: ["feature"],
      },
    ],
  });
  try {
    await syncNow(harness);
    const prompt = String((harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>).prompt);
    expect(prompt).toContain('"feature":"android-e2e-loop"');
    expect(prompt).toContain('"deployRequested":false');
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("label-derived feature names are short slugs and get -<id> on a branch/worktree collision", async () => {
  gitNamesInRepo = ["main", "feature/android-e2e-testing-loop"];
  const { harness } = await makeHarness({
    tasks: [
      { id: 46, title: "Android e2e testing loop (unit, device, real tunnel)", assignees: ["CTO-bot"], labels: ["feature"] },
    ],
  });
  try {
    await syncNow(harness);
    const prompt = String((harness.inspection.sdk.callsTo("threads.spawn")[0]![0] as Record<string, unknown>).prompt);
    expect(prompt).toContain('"feature":"android-e2e-testing-loop-46"');
  } finally {
    await harness.lifecycle.dispose();
  }
});

// ---------------------------------------------------------------------------
// Tasks closed in Vikunja (done / deleted / unassigned) close in the plugin,
// and feature status follows the live workflow run.

function comments(calls: Array<{ method: string; input: unknown }>, task: number) {
  return calls
    .filter((call) => call.method === "call" && (call.input as { name?: string })?.name === "task_comments_create")
    .map((call) => (call.input as { arguments: { task: number; comment: string } }).arguments)
    .filter((args) => args.task === task)
    .map((args) => args.comment);
}

function stops(calls: Array<{ method: string; input: unknown }>) {
  return calls.filter((call) => call.method === "workflowStopRun").map((call) => (call.input as { runId: string }).runId);
}

test("a paused task marked done in Vikunja closes: worker stopped and archived, one comment, idempotent", async () => {
  const fake: FakeVikunja = { tasks: [{ id: 60, title: "Pause me", assignees: ["CTO-bot"], bucketId: 16 }] };
  const { harness, vikunjaCalls } = await makeHarness(fake);
  try {
    await syncNow(harness);
    await harness.behavior.runCli(["pause", "60"]);
    fake.tasks[0]!.done = true;
    const before = comments(vikunjaCalls, 60).length;
    await syncNow(harness);
    let overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("closed");
    expect(overview.tasks[0]!.progressNote).toBe("closed in Vikunja (done)");
    expect(harness.inspection.sdk.callsTo("threads.archive").map((call) => (call[0] as { threadId: string }).threadId)).toEqual(["th_w1"]);
    expect(comments(vikunjaCalls, 60).slice(before)).toEqual(["Chief of Staff: closed in Vikunja (done); stopped worker."]);
    // Repeated sweeps never stop, archive or comment again.
    await syncNow(harness);
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(comments(vikunjaCalls, 60).length - before).toBe(1);
    overview = await harness.behavior.callRpc("overview", null);
    expect(overview.counts.closed).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a deleted task closes without a comment; an unassigned one closes with one", async () => {
  const fake: FakeVikunja = {
    tasks: [
      { id: 61, title: "Delete me", assignees: ["CTO-bot"], bucketId: 16 },
      { id: 62, title: "Hand me off", assignees: ["CTO-bot"], bucketId: 16 },
    ],
  };
  const { harness, vikunjaCalls } = await makeHarness(fake);
  try {
    await syncNow(harness);
    const before61 = comments(vikunjaCalls, 61).length;
    const before62 = comments(vikunjaCalls, 62).length;
    fake.tasks = [{ id: 62, title: "Hand me off", assignees: ["mark"], bucketId: 16 }];
    await syncNow(harness);
    const overview = await harness.behavior.callRpc("overview", null);
    const byId = new Map(overview.tasks.map((task) => [task.taskId, task]));
    expect(byId.get(61)?.state).toBe("closed");
    expect(byId.get(61)?.progressNote).toBe("closed in Vikunja (deleted)");
    expect(byId.get(62)?.state).toBe("closed");
    expect(byId.get(62)?.progressNote).toBe("closed in Vikunja (unassigned)");
    expect(comments(vikunjaCalls, 61).length).toBe(before61);
    expect(comments(vikunjaCalls, 62).slice(before62)).toEqual(["Chief of Staff: closed in Vikunja (unassigned); stopped worker."]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a transient Vikunja lookup error never closes a task", async () => {
  const fake: FakeVikunja = { tasks: [{ id: 63, title: "Flaky", assignees: ["CTO-bot"], bucketId: 16 }], lookupError: true };
  const { harness } = await makeHarness(fake);
  try {
    await syncNow(harness);
    fake.tasks[0]!.done = true; // gone from the open list, but the confirm lookup fails
    await syncNow(harness);
    let overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("active");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    fake.lookupError = false;
    await syncNow(harness);
    overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("closed");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a feature done in Vikunja mid-Build cancels its run, frees the feature slot and closes", async () => {
  const fake: FakeVikunja = {
    tasks: [
      { id: 64, title: "Feature one", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 65, title: "Feature two", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
    ],
    runs: { th_w1: [{ id: "wfr_64", status: "running", currentPhase: "Build" }] },
  };
  const { harness, vikunjaCalls, workflowCalls } = await makeHarness(fake, { maxFeatureRuns: 1 });
  try {
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    fake.tasks[0]!.done = true;
    await syncNow(harness);
    expect(stops(workflowCalls)).toEqual(["wfr_64"]);
    expect(fake.runs!.th_w1![0]!.status).toBe("cancelled");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks.find((task) => task.taskId === 64)?.state).toBe("closed");
    expect(comments(vikunjaCalls, 64).at(-1)).toBe("Chief of Staff: closed in Vikunja (done); stopped worker/run (wfr_64).");
    // The freed slot lets the waiting feature dispatch.
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    await syncNow(harness);
    expect(stops(workflowCalls)).toEqual(["wfr_64"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("mid-Merge: the run is never cancelled; the task closes once the Merge finished", async () => {
  const fake: FakeVikunja = {
    tasks: [{ id: 66, title: "Merging", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 }],
    runs: { th_w1: [{ id: "wfr_66", status: "running", currentPhase: "Merge" }] },
  };
  const { harness, vikunjaCalls, workflowCalls } = await makeHarness(fake);
  try {
    await syncNow(harness);
    fake.tasks[0]!.done = true;
    await syncNow(harness);
    await syncNow(harness);
    expect(stops(workflowCalls)).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
    let overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("active");
    expect(overview.tasks[0]!.error).toBe("closed in Vikunja; waiting for the in-flight Merge of wfr_66 to finish");
    // The Merge lands; the driver reports done. No second Vikunja completion, marker kept.
    fake.runs!.th_w1![0]!.status = "succeeded";
    const updatesBefore = vikunjaCalls.filter((call) => (call.input as { name?: string })?.name === "tasks_update").length;
    const ack = await report(harness, { stage: "done", workflowRunId: "wfr_66", workflowStatus: "merged-to-main" });
    expect(ack).toContain("Recorded done");
    expect(vikunjaCalls.filter((call) => (call.input as { name?: string })?.name === "tasks_update").length).toBe(updatesBefore);
    overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("closed");
    // The next sweep finishes the close: thread archived, one comment, nothing cancelled.
    await syncNow(harness);
    await syncNow(harness);
    expect(stops(workflowCalls)).toEqual([]);
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(comments(vikunjaCalls, 66).filter((comment) => comment.includes("closed in Vikunja"))).toEqual([
      "Chief of Staff: closed in Vikunja (done); stopped worker.",
    ]);
    overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.error).toBeNull();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("mid-Merge without a done report: closes once the run left Merge", async () => {
  const fake: FakeVikunja = {
    tasks: [{ id: 67, title: "Merging 2", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 }],
    runs: { th_w1: [{ id: "wfr_67", status: "running", currentPhase: "Merge" }] },
  };
  const { harness, workflowCalls } = await makeHarness(fake);
  try {
    await syncNow(harness);
    fake.tasks[0]!.done = true;
    await syncNow(harness);
    expect((await harness.behavior.callRpc("overview", null)).tasks[0]!.state).toBe("active");
    fake.runs!.th_w1![0]!.status = "succeeded";
    await syncNow(harness);
    expect(stops(workflowCalls)).toEqual([]);
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.state).toBe("closed");
    expect(overview.tasks[0]!.error).toBeNull();
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("feature status reads the live run phase: CLI, brief and Testing on Verify", async () => {
  const fake: FakeVikunja = {
    tasks: [{ id: 68, title: "Live phase", assignees: ["CTO-bot"], labels: ["feature"], project_id: 5 }],
    boards: PROJECT5_BOARD,
    runs: { th_w1: [{ id: "wfr_68", status: "queued", currentPhase: "Queue" }] },
  };
  const { harness, vikunjaCalls } = await makeHarness(fake);
  try {
    await syncNow(harness);
    // The driver reported only at launch.
    await report(harness, { stage: "progress", note: "launched", workflowRunId: "wfr_68", workflowStatus: "queued" });
    fake.runs!.th_w1![0]!.status = "running";
    fake.runs!.th_w1![0]!.currentPhase = "Build";
    let listing = await harness.behavior.runCli(["tasks"]);
    expect(listing.stdout).toContain("#68 (active, feature running, phase Build)");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.workflowPhase).toBe("Build");
    expect(overview.tasks[0]!.runStatus).toBe("running");
    const brief = await harness.behavior.runCli(["brief", "--refresh"]);
    expect(brief.stdout).toContain("workflow running, phase Build");
    fake.runs!.th_w1![0]!.currentPhase = "Verify";
    await syncNow(harness);
    await vi.waitFor(() => expect(moves(vikunjaCalls).map((move) => move.bucket).at(-1)).toBe(22));
    listing = await harness.behavior.runCli(["tasks"]);
    expect(listing.stdout).toContain("phase Verify");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a reported run id from another thread falls back to the driver thread's latest run", async () => {
  const fake: FakeVikunja = {
    tasks: [{ id: 69, title: "Adopted run", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 }],
    runs: { th_w1: [{ id: "wfr_real", status: "running", currentPhase: "Spec" }] },
  };
  const { harness } = await makeHarness(fake);
  try {
    await syncNow(harness);
    await report(harness, { stage: "progress", workflowRunId: "wfr_elsewhere", workflowStatus: "queued" });
    const listing = await harness.behavior.runCli(["tasks"]);
    expect(listing.stdout).toContain("feature running, phase Spec");
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.workflowPhase).toBe("Spec");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("an idle feature driver whose run is still running is never nudged; a re-sync never re-dispatches or sends 'updated'", async () => {
  const fake: FakeVikunja = {
    tasks: [{ id: 70, title: "Long build", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 }],
    runs: { th_w1: [{ id: "wfr_70", status: "running", currentPhase: "Build" }] },
  };
  const { harness, workflowCalls } = await makeHarness(fake);
  vi.useFakeTimers();
  try {
    await syncNow(harness);
    const sendsAfterDispatch = harness.inspection.sdk.callsTo("threads.send").length;
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(Date.now() + 31 * 60_000);
      await syncNow(harness);
    }
    vi.useRealTimers();
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(sendsAfterDispatch);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(stops(workflowCalls)).toEqual([]);
    const overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks[0]!.stalled).toBe(false);
  } finally {
    vi.useRealTimers();
    await harness.lifecycle.dispose();
  }
});

test("dependency layers: backend runs beside Android, same resource and hard deps wait, soft never blocks", async () => {
  mergedFeatures = [];
  const fake: FakeVikunja = {
    tasks: [
      { id: 40, title: "Android e2e loop", description: "feature: android-e2e-loop", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 41, title: "Backend scaffold", description: "feature: backend-scaffold<br>Soft-after: android-e2e-loop", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 42, title: "Android settings screen", description: "feature: android-settings", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 43, title: "Admin web", description: "feature: admin-web<br>Depends-on: admin-auth", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
    ],
  };
  const { harness, vikunjaCalls } = await makeHarness(fake, { maxFeatureRuns: 3, maxConcurrent: 4 });
  try {
    await syncNow(harness);
    // Android + backend in parallel (soft dep on Android does not block).
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    let overview = await harness.behavior.callRpc("overview", null);
    const byId = (id: number) => overview.tasks.find((entry) => entry.taskId === id)!;
    expect(byId(40).state).toBe("active");
    expect(byId(40).resources).toContain("emulator");
    expect(byId(41).state).toBe("active");
    expect(byId(41).softAfter).toEqual(["android-e2e-loop"]);
    // Second Android task waits on the emulator; admin-web waits on its hard dep.
    expect(byId(42).state).toBe("paused");
    expect(byId(42).blockReason).toContain("resource: emulator is in use by #40");
    expect(byId(43).state).toBe("paused");
    expect(byId(43).blockReason).toContain("hard dependency: waiting for admin-auth");
    expect(comments(vikunjaCalls, 43).join("\n")).toContain("hard: admin-auth");
    expect(comments(vikunjaCalls, 41).join("\n")).toContain("soft: android-e2e-loop");
    // A re-sweep with the same reason does not comment again.
    const before = comments(vikunjaCalls, 43).length;
    await syncNow(harness);
    expect(comments(vikunjaCalls, 43)).toHaveLength(before);
    // Once admin-auth is on main, admin-web starts.
    mergedFeatures = ["admin-auth"];
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3);
    overview = await harness.behavior.callRpc("overview", null);
    expect(byId(43).state).toBe("active");
    expect(byId(43).blockReason).toBeNull();
    expect(byId(42).state).toBe("paused");
  } finally {
    mergedFeatures = [];
    await harness.lifecycle.dispose();
  }
});

test("heavy-device group: a live ios-simulator lease is recorded; resuming an Android task waits for it, then auto-resumes", async () => {
  leaseByRun = {};
  const fake: FakeVikunja = {
    tasks: [
      { id: 70, title: "Mac mini: iOS dev environment", description: "feature: ios-env<br>Resources: none", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 71, title: "Rename Android package", description: "feature: android-rename<br>Resources: emulator, android-sdk-gradle", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
    ],
    runs: { th_w1: [{ id: "wfr_ios", status: "running", currentPhase: "Build" }] },
  };
  const { harness } = await makeHarness(fake, { maxFeatureRuns: 3, maxConcurrent: 4 });
  try {
    await syncNow(harness);
    expect(harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
    // #70's run takes the iOS simulator lease although its ticket says "Resources: none".
    await report(harness, { stage: "progress", note: "launched", workflowRunId: "wfr_ios", workflowStatus: "running" }, "th_w1");
    leaseByRun = { wfr_ios: ["ios-simulator"] };
    await syncNow(harness);
    let overview = await harness.behavior.callRpc("overview", null);
    const byId = (id: number) => overview.tasks.find((entry) => entry.taskId === id)!;
    expect(byId(70).resources).toEqual(["ios-simulator"]);
    let listing = await harness.behavior.runCli(["tasks"]);
    expect(listing.stdout).toContain("ios-simulator");
    // The Android task is paused (its run stopped) and resumed: it must wait.
    await harness.behavior.runCli(["pause", "71"]);
    const sendsBefore = harness.inspection.sdk.callsTo("threads.send").length;
    await harness.behavior.runCli(["resume", "71"]);
    overview = await harness.behavior.callRpc("overview", null);
    expect(byId(71).state).toBe("paused");
    expect(byId(71).blockReason).toContain("emulator conflicts with ios-simulator in use by #70");
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(sendsBefore);
    listing = await harness.behavior.runCli(["tasks"]);
    expect(listing.stdout).toContain("conflicts with ios-simulator in use by #70");
    // Still held while #70 runs.
    await syncNow(harness);
    overview = await harness.behavior.callRpc("overview", null);
    expect(byId(71).state).toBe("paused");
    // #70 finishes: the Android worker is told to continue (one fresh run).
    leaseByRun = {};
    fake.tasks[0]!.done = true;
    await syncNow(harness);
    overview = await harness.behavior.callRpc("overview", null);
    expect(byId(71).state).toBe("active");
    expect(byId(71).blockReason).toBeNull();
    const sends = harness.inspection.sdk.callsTo("threads.send").slice(sendsBefore).map((call) => call[0] as { threadId: string });
    expect(sends.filter((send) => send.threadId === "th_w2")).toHaveLength(1);
  } finally {
    leaseByRun = {};
    await harness.lifecycle.dispose();
  }
});

test("heavy-device group: a linked (adopted) thread is not resumed while a conflicting run holds the device", async () => {
  leaseByRun = {};
  const fake: FakeVikunja = {
    tasks: [
      { id: 72, title: "iOS simulator smoke", description: "feature: ios-smoke", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
    ],
  };
  const { harness } = await makeHarness(fake, { maxFeatureRuns: 3, maxConcurrent: 4 });
  try {
    await syncNow(harness);
    fake.tasks.push({ id: 73, title: "Android rename", description: "feature: android-rename-2<br>Resources: emulator, android-sdk-gradle", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 });
    fake.links = { 73: ["th_old"] };
    await syncNow(harness);
    const overview = await harness.behavior.callRpc("overview", null);
    const row = overview.tasks.find((entry) => entry.taskId === 73)!;
    expect(row.state).toBe("paused");
    expect(row.threadId).toBeNull();
    expect(row.blockReason).toContain("emulator conflicts with ios-simulator in use by #72");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("heavy-device group: `bb chief resources` records a running task's real resources; a resumed Android task then waits", async () => {
  leaseByRun = {};
  const fake: FakeVikunja = {
    tasks: [
      { id: 75, title: "iOS env", description: "feature: ios-env-3<br>Resources: none", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
      { id: 76, title: "Android rename", description: "feature: android-rename-3<br>Resources: emulator, android-sdk-gradle", assignees: ["CTO-bot"], labels: ["feature"], bucketId: 16 },
    ],
  };
  const { harness } = await makeHarness(fake, { maxFeatureRuns: 3, maxConcurrent: 4 });
  try {
    await syncNow(harness);
    await harness.behavior.runCli(["pause", "76"]);
    const out = await harness.behavior.runCli(["resources", "75", "ios-simulator"]);
    expect(out.stdout).toContain("#75");
    expect(out.stdout).toContain("ios-simulator");
    let overview = await harness.behavior.callRpc("overview", null);
    expect(overview.tasks.find((entry) => entry.taskId === 75)!.resources).toEqual(["ios-simulator"]);
    // Unknown resource names are rejected.
    const bad = await harness.behavior.runCli(["resources", "75", "gpu"]).then((result) => JSON.stringify(result), (cause) => String(cause));
    expect(bad).toMatch(/unknown resource/);
    await harness.behavior.runCli(["resume", "76"]);
    overview = await harness.behavior.callRpc("overview", null);
    const row = overview.tasks.find((entry) => entry.taskId === 76)!;
    expect(row.state).toBe("paused");
    expect(row.blockReason).toContain("emulator conflicts with ios-simulator in use by #75");
  } finally {
    await harness.lifecycle.dispose();
  }
});
