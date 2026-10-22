import { afterEach, expect, test, vi } from "vitest";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

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

interface FakeVikunja {
  tasks: FakeTask[];
  links?: Record<number, string[]>;
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
          if (args.method === "buckets") {
            return [
              { id: 16, title: "To-Do" },
              { id: 17, title: "Doing" },
              { id: 18, title: "Done" },
            ];
          }
          if (args.method === "move") return {};
          if (args.method === "call") {
            const name = (input as { name?: string })?.name;
            if (name === "tasks_list") return envelope(fake.tasks);
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
    expect(metadata.set).toEqual({ itemId: "9" });
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
});
