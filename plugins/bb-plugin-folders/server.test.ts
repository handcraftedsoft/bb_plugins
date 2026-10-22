// Behavioral tests for bb-plugin-folders against the fake plugin host.
// The SDK areas the plugin uses are stubbed with a tiny in-memory bb: a
// section list plus thread rows, mutated exactly the way the real server
// would so each command runs against believable state.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { resolveFolder } from "./server.ts";

interface FakeSection {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface FakeThread {
  id: string;
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
}

interface FakeState {
  sections: FakeSection[];
  threads: FakeThread[];
  nextId: number;
}

function makeState(): FakeState {
  return {
    sections: [
      { id: "sec_inbox", name: "Inbox", createdAt: 1, updatedAt: 1 },
      { id: "sec_done", name: "Done", createdAt: 2, updatedAt: 2 },
    ],
    threads: [
      {
        id: "thread-test",
        title: "Current thread",
        titleFallback: null,
        sectionId: null,
      },
      {
        id: "thr_alpha",
        title: "Alpha",
        titleFallback: null,
        sectionId: "sec_inbox",
      },
      {
        id: "thr_beta",
        title: null,
        titleFallback: "Beta fallback",
        sectionId: "sec_inbox",
      },
      {
        id: "thr_gamma",
        title: "Gamma",
        titleFallback: null,
        sectionId: null,
      },
    ],
    nextId: 1,
  };
}

function makeHost(state: FakeState) {
  return createFakePluginHost({
    pluginId: "bb-plugin-folders",
    sdk: {
      threadSections: {
        // Wire-faithful stubs: like the real loopback SDK, every call
        // returns fresh copies, never objects shared with later mutations.
        list: async () => state.sections.map((section) => ({ ...section })),
        create: async ({ name }: { name: string }) => {
          const section: FakeSection = {
            id: `sec_new_${state.nextId}`,
            name,
            createdAt: 3,
            updatedAt: 3,
          };
          state.nextId += 1;
          state.sections.push(section);
          return { ...section };
        },
        update: async ({ id, name }: { id: string; name: string }) => {
          const section = state.sections.find((entry) => entry.id === id);
          if (section === undefined) throw new Error("section not found");
          section.name = name;
          return {
            id,
            name,
            updatedThreadCount: state.threads.filter(
              (thread) => thread.sectionId === id,
            ).length,
          };
        },
        delete: async ({ id }: { id: string }) => {
          const section = state.sections.find((entry) => entry.id === id);
          if (section === undefined) throw new Error("section not found");
          const updatedThreadCount = state.threads.filter(
            (thread) => thread.sectionId === id,
          ).length;
          state.sections = state.sections.filter((entry) => entry.id !== id);
          for (const thread of state.threads) {
            if (thread.sectionId === id) thread.sectionId = null;
          }
          return { id, name: section.name, updatedThreadCount };
        },
      },
      threads: {
        list: async (args?: {
          limit?: number;
          offset?: number;
          sectionId?: string;
        }) => {
          const { limit = 200, offset = 0, sectionId } = args ?? {};
          const rows =
            sectionId === undefined
              ? state.threads
              : state.threads.filter((thread) => thread.sectionId === sectionId);
          return rows
            .slice(offset, offset + limit)
            .map((thread) => ({ ...thread }));
        },
        get: async ({ threadId }: { threadId: string }) => {
          const thread = state.threads.find((entry) => entry.id === threadId);
          if (thread === undefined) throw new Error("thread not found");
          return { ...thread };
        },
        update: async (args: { threadId: string; sectionId?: string | null }) => {
          const thread = state.threads.find((entry) => entry.id === args.threadId);
          if (thread === undefined) throw new Error("thread not found");
          if (args.sectionId !== undefined) thread.sectionId = args.sectionId;
          return { ...thread };
        },
      },
    },
  });
}

let state: FakeState;
let harness: ReturnType<typeof makeHost>["harness"];

async function loadPlugin() {
  state = makeState();
  const host = makeHost(state);
  harness = host.harness;
  await plugin(host.bb);
}

describe("resolveFolder", () => {
  const folders = [
    { id: "sec_1", name: "Inbox" },
    { id: "sec_2", name: "Done" },
    { id: "sec_3", name: "INBOX" },
  ];

  test("prefers exact id, then exact name, then a unique case-insensitive match", () => {
    assert.equal(resolveFolder(folders, "sec_1").kind, "found");
    assert.equal(resolveFolder(folders, "Done").kind, "found");
    const resolution = resolveFolder(folders, "done");
    assert.equal(resolution.kind, "found");
    if (resolution.kind === "found") {
      assert.equal(resolution.folder.id, "sec_2");
    }
  });

  test("reports ambiguous case-insensitive matches instead of guessing", () => {
    const resolution = resolveFolder(folders, "inbox");
    assert.equal(resolution.kind, "ambiguous");
    if (resolution.kind === "ambiguous") {
      assert.equal(resolution.candidates.length, 2);
    }
  });

  test("reports a miss", () => {
    assert.equal(resolveFolder(folders, "Later").kind, "missing");
  });
});

describe("bb folders", () => {
  beforeEach(async () => {
    await loadPlugin();
  });

  test("list shows folder counts and the unsectioned population", async () => {
    const result = await harness.behavior.runCli(["list"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Inbox (2)  sec_inbox"));
    assert.ok(result.stdout.includes("Done (0)  sec_done"));
    assert.ok(result.stdout.includes("Unsectioned: 2 threads"));
  });

  test("list --json emits machine-readable counts", async () => {
    const result = await harness.behavior.runCli(["list", "--json"]);
    assert.equal(result.exitCode, 0);
    const data = JSON.parse(result.stdout) as {
      folders: { name: string; count: number }[];
      unsectioned: number;
    };
    assert.deepEqual(
      data.folders.map((folder) => [folder.name, folder.count]),
      [
        ["Inbox", 2],
        ["Done", 0],
      ],
    );
    assert.equal(data.unsectioned, 2);
  });

  test("create rejects duplicate names regardless of case", async () => {
    const exact = await harness.behavior.runCli(["create", "Inbox"]);
    assert.equal(exact.exitCode, 1);
    assert.ok(exact.stderr.includes('"Inbox" already exists'));

    const otherCase = await harness.behavior.runCli(["create", "iNbOx"]);
    assert.equal(otherCase.exitCode, 1);

    const fresh = await harness.behavior.runCli(["create", "Later"]);
    assert.equal(fresh.exitCode, 0);
    assert.ok(fresh.stdout.includes('Created folder "Later"'));
  });

  test("move files into an existing folder without creating anything", async () => {
    const result = await harness.behavior.runCli([
      "move",
      "inbox",
      "--thread",
      "thr_gamma",
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('Filed "Gamma"'));
    assert.ok(!result.stdout.includes("folder created"));

    const creates = harness.inspection.sdk.callsTo("threadSections.create");
    assert.equal(creates.length, 0);
    assert.equal(state.threads[3]!.sectionId, "sec_inbox");
  });

  test("move creates a missing folder, then files the thread", async () => {
    const result = await harness.behavior.runCli([
      "move",
      "Later",
      "--thread",
      "thr_gamma",
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("folder created"));

    const created = state.sections.find((entry) => entry.name === "Later");
    assert.ok(created);
    assert.equal(state.threads[3]!.sectionId, created!.id);
  });

  test("move --require-existing fails on a missing folder with a JSON envelope", async () => {
    const result = await harness.behavior.runCli([
      "move",
      "Missing",
      "--thread",
      "thr_gamma",
      "--require-existing",
      "--json",
    ]);
    assert.equal(result.exitCode, 1);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "folder_not_found");
    assert.equal(state.threads[3]!.sectionId, null);
  });

  test("move defaults to the thread it runs in", async () => {
    const result = await harness.behavior.runCli(["move", "Done"], {
      threadId: "thr_gamma",
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('Filed "Gamma"'));
    assert.equal(state.threads[3]!.sectionId, "sec_done");
  });

  test("move without any thread fails with a hint", async () => {
    const result = await harness.behavior.runCli(["move", "Done"]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes("No thread to file"));
    assert.ok(result.stderr.includes("--thread"));
  });

  test("move reports an unknown thread", async () => {
    const result = await harness.behavior.runCli([
      "move",
      "Done",
      "--thread",
      "thr_missing",
    ]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes("No thread thr_missing"));
  });

  test("remove (and its unfile alias) takes a thread out of its folder", async () => {
    const result = await harness.behavior.runCli([
      "remove",
      "--thread",
      "thr_alpha",
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('Removed "Alpha"'));
    assert.equal(state.threads[1]!.sectionId, null);

    // File it back through the alias, then remove via the current thread.
    await harness.behavior.runCli(["move", "Done"], { threadId: "thr_alpha" });
    const alias = await harness.behavior.runCli(["unfile"], {
      threadId: "thr_alpha",
    });
    assert.equal(alias.exitCode, 0);
    assert.equal(state.threads[1]!.sectionId, null);
  });

  test("remove on a thread in no folder is a no-op note", async () => {
    const result = await harness.behavior.runCli(["remove"], {
      threadId: "thr_gamma",
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("is in no folder"));
  });

  test("rename updates the name and keeps threads filed", async () => {
    const result = await harness.behavior.runCli([
      "rename",
      "Inbox",
      "Incoming",
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('Renamed "Inbox" to "Incoming"'));
    assert.ok(result.stdout.includes("2 threads filed"));
    assert.equal(state.sections[0]!.name, "Incoming");
    assert.equal(state.threads[1]!.sectionId, "sec_inbox");

    const clash = await harness.behavior.runCli([
      "rename",
      "Incoming",
      "done",
    ]);
    assert.equal(clash.exitCode, 1);
    assert.ok(clash.stderr.includes('"Done" already exists'));
  });

  test("delete removes the folder and returns its threads to no folder", async () => {
    const result = await harness.behavior.runCli(["delete", "Inbox"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("2 threads returned to no folder"));
    assert.equal(state.sections.length, 1);
    assert.equal(state.threads[1]!.sectionId, null);
    assert.equal(state.threads[2]!.sectionId, null);
  });

  test("threads lists filed threads and hints on unknown folders", async () => {
    const result = await harness.behavior.runCli(["threads", "Inbox"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("thr_alpha  Alpha"));
    assert.ok(result.stdout.includes("thr_beta  Beta fallback"));

    const unknown = await harness.behavior.runCli(["threads", "Nope"]);
    assert.equal(unknown.exitCode, 1);
    assert.ok(unknown.stderr.includes('No folder "Nope"'));
    assert.ok(unknown.stderr.includes('"Inbox"'));
  });
});

describe("agent tools", () => {
  beforeEach(async () => {
    await loadPlugin();
  });

  test("folders_move files the current thread and creates a missing folder", async () => {
    const result = await harness.behavior.callAgentTool("folders_move", {
      folder: "Review",
    });
    const text =
      typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("folder created"));

    const created = state.sections.find((entry) => entry.name === "Review");
    assert.ok(created);
    assert.equal(
      state.threads.find((thread) => thread.id === "thread-test")!.sectionId,
      created!.id,
    );
  });

  test("folders_move with an explicit thread files that thread", async () => {
    const result = await harness.behavior.callAgentTool("folders_move", {
      folder: "Done",
      threadId: "thr_gamma",
    });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes('Filed "Gamma"'));
    assert.equal(state.threads[3]!.sectionId, "sec_done");
  });

  test("folders_list reports counts as JSON", async () => {
    const result = await harness.behavior.callAgentTool("folders_list", {});
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const start = text.indexOf("{");
    const data = JSON.parse(text.slice(start)) as {
      folders: { name: string; count: number }[];
    };
    assert.deepEqual(
      data.folders.map((folder) => [folder.name, folder.count]),
      [
        ["Inbox", 2],
        ["Done", 0],
      ],
    );
  });
});
