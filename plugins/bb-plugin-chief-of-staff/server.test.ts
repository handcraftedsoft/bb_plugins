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
  const { bb, harness } = createFakePluginHost({
    pluginId: "chief-of-staff",
    settings: { project: "proj_jjitzuscx6", assignee: "CTO-bot", ...settings },
    sdk: {
      plugins: {
        callRpc: async (args: { method: string; input: unknown }) => {
          calls.push({ method: args.method, input: args.input });
          const input = args.input as Record<string, unknown> | null;
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
            if (name === "tasks_list") return envelope(fake.tasks);
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
  return { harness, vikunjaCalls: calls };
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
  });
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
