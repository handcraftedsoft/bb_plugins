// @vitest-environment jsdom
import { expect, test } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Overview } from "./server";

function overviewFixture(overrides: Partial<Overview> = {}): Overview {
  return {
    configured: true,
    assignee: "CTO-bot",
    settings: { maxConcurrent: 2, stallMinutes: 30, maxNudges: 2 },
    counts: { active: 1, paused: 0, closed: 0, pendingDecisions: 1 },
    briefing: {
      id: 1,
      createdAt: 1_700_000_000_000,
      text: "Chief of staff briefing — 2026-10-21 09:00\n\nNEEDS YOUR DECISION (1)\n  #7 Pick vendor — Vendor A or B?",
    },
    tasks: [
      {
        taskId: 7,
        title: "Pick vendor",
        projectId: 6,
        state: "active",
        threadId: "th_1",
        progressNote: "comparing",
        progressAt: Date.now(),
        stalled: false,
        nudgeCount: 0,
        error: null,
        threadStatus: "active",
        mode: "task",
        deployRequested: false,
        workflowStatus: null,
      },
    ],
    decisions: [
      {
        id: "d1",
        taskId: 7,
        taskTitle: "Pick vendor",
        question: "Vendor A or B?",
        context: null,
        options: ["Vendor A", "Vendor B"],
        status: "pending",
        answer: null,
        autoAnswered: false,
        askedAt: Date.now(),
        answeredAt: null,
        kind: "routine",
      },
    ],
    policies: [
      { id: "p1", keywords: ["branch"], answer: "Use a task branch.", source: "builtin", createdAt: 1 },
    ],
    ...overrides,
  };
}

async function mount(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      overview: () => overviewFixture(),
      brief_now: () => ({ briefing: overviewFixture().briefing }),
      sync_now: () => ({ ok: true }),
      ...handlers,
    },
  });
}

test("the board shows the briefing, the decision queue, and managed tasks", async () => {
  const slot = await mount();
  try {
    await slot.findByText(/NEEDS YOUR DECISION \(1\)/);
    await slot.findByText("Vendor A or B?");
    await slot.findByText("Pick vendor");
    expect(slot.getByRole("button", { name: /Sync now/ })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Thread" })).toBeTruthy();
    expect(slot.getByText("#7")).toBeTruthy();
    expect(slot.getByText(/assignee CTO-bot/)).toBeTruthy();
  } finally {
    slot.lifecycle.unmount();
  }
});

test("answering a decision sends it to the worker", async () => {
  const slot = await mount();
  try {
    const answerBox = await slot.findByLabelText("Answer for Vendor A or B?");
    fireEvent.change(answerBox, { target: { value: "Vendor A" } });
    fireEvent.click(slot.getByRole("button", { name: "Answer" }));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "decision_answer",
        input: { id: "d1", answer: "Vendor A" },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("an option chip prefills the answer box", async () => {
  const slot = await mount();
  try {
    fireEvent.click(await slot.findByRole("button", { name: "Vendor B" }));
    expect((slot.getByLabelText("Answer for Vendor A or B?") as HTMLTextAreaElement).value).toBe("Vendor B");
  } finally {
    slot.lifecycle.unmount();
  }
});

test("pausing an active task calls task_pause", async () => {
  const slot = await mount();
  try {
    await slot.findByText("Pick vendor");
    fireEvent.click(slot.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "task_pause",
        input: { taskId: 7 },
      });
    });
  } finally {
    slot.lifecycle.unmount();
  }
});

test("an unreachable Vikunja plugin shows the setup banner", async () => {
  const slot = await mount({ overview: () => overviewFixture({ configured: false, briefing: null, tasks: [] }) });
  try {
    await slot.findByText(/Vikunja plugin is not reachable/);
  } finally {
    slot.lifecycle.unmount();
  }
});
