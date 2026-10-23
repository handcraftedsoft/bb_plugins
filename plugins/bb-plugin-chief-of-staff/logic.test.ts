import { expect, test } from "vitest";
import {
  bucketForColumn,
  classifyQuestion,
  classifyTask,
  columnForPhase,
  deployIntent,
  FEATURE_SLUG_MAX,
  parseBuckets,
  phaseFromNote,
  slugFeature,
  workflowPhaseFromTimeline,
} from "./logic";

const NO = [
  "Deploy: no",
  "deploy: No",
  "Ship: no",
  "**Deploy:** no",
  "Deploy = false",
  "Size: normal\nfeature: x\nDeploy: no\nThen deploy to prod.", // explicit line wins
  "Deploy: yes\nDeploy: no", // any explicit no wins
  "Do not deploy.",
  "don't deploy the VPS",
  "No deploy needed",
  "never push to origin",
  "Without deploying anything",
  "must not release this",
  "Skip the deploy",
  "Update the deploy script",
  "Fix the deploy docs",
  "Deployment notes for the team",
  "The app was deployed last week",
  "Add push notifications",
  "Build a release APK",
  "Deploy pipeline is flaky; investigate",
  "Android e2e testing loop (unit, device, real tunnel)",
  "",
];

const YES = [
  "Deploy: yes",
  "Ship: yes",
  "deploy = true",
  "Hero and redeploy prod after completion",
  "Update landing copy and deploy to production",
  "Then push to origin when green",
  "Please deploy.",
  "Deploy to staging after merge",
  "Ship it",
  "Release to the Play Store",
  "Deploy the landing page.",
];

test.each(NO)("deployIntent NO: %j", (text) => {
  expect(deployIntent(text).requested).toBe(false);
});

test.each(YES)("deployIntent YES: %j", (text) => {
  expect(deployIntent(text).requested).toBe(true);
});

test("deployIntent explains its decision", () => {
  expect(deployIntent("Deploy: no").reason).toMatch(/explicit/i);
  expect(deployIntent("do not deploy").reason).toMatch(/negat/i);
  expect(deployIntent("update the deploy script").reason).toMatch(/default|no explicit/i);
});

test("slugFeature: drops parentheses and filler, cuts at a word boundary, deterministic", () => {
  const title = "Android e2e testing loop (unit, device, real tunnel)";
  expect(slugFeature(title)).toBe("android-e2e-testing-loop");
  expect(slugFeature(title)).toBe(slugFeature(title));
  expect(slugFeature("Add the new onboarding flow for the Android app")).toBe("add-new-onboarding-flow-android");
  const long = slugFeature("Implement wireguard configuration import from qr codes and files [mobile]");
  expect(long.length).toBeLessThanOrEqual(FEATURE_SLUG_MAX);
  expect(long).not.toMatch(/-$/);
  expect(long).toBe("implement-wireguard") // "+-configuration" would be 33;
  expect(slugFeature("Supercalifragilisticexpialidociouslylongwordthatneverends")).toHaveLength(FEATURE_SLUG_MAX);
  expect(slugFeature("(only parens)")).toBe("feature");
  expect(slugFeature("The")).toBe("the");
});

test("slugFeature appends -<task id> on a collision", () => {
  const taken = (name: string) => name === "qr-import";
  expect(slugFeature("QR import", { taken, taskId: 12 })).toBe("qr-import-12");
  expect(slugFeature("QR export", { taken, taskId: 12 })).toBe("qr-export");
});

test("classifyTask: explicit feature line (markdown-tolerant) wins over the title slug", () => {
  const base = { id: 3, title: "Android e2e testing loop (unit, device, real tunnel)", labels: ["feature"] };
  expect(classifyTask({ ...base, description: "" }, "feature").feature).toBe("android-e2e-testing-loop");
  expect(classifyTask({ ...base, description: "**feature:** `android-e2e-loop`" }, "feature").feature).toBe("android-e2e-loop");
  expect(classifyTask({ ...base, description: "<p>feature: android-e2e-loop</p>" }, "feature").feature).toBe("android-e2e-loop");
  const meta = classifyTask({ ...base, description: "Size: normal\nfeature: android-e2e-loop\nDeploy: no" }, "feature");
  expect(meta).toMatchObject({ mode: "feature", feature: "android-e2e-loop", deployRequested: false });
});

test("question routing: push notifications / release builds are not deploy questions", () => {
  expect(classifyQuestion("Should I add push notifications via FCM?", false)).toBe("routine");
  expect(classifyQuestion("Should the release build use R8?", false)).toBe("routine");
  expect(classifyQuestion("Should I push to origin now?", false)).toBe("irreversible");
  expect(classifyQuestion("Should I push to origin now?", true)).toBe("deploy-allowed");
  expect(classifyQuestion("Can I deploy to prod?", false)).toBe("irreversible");
});

test("parseBuckets accepts the v2 envelope and bare arrays, sorted by position", () => {
  const envelope = { items: [{ id: 15, title: "Done", position: 300 }, { id: 22, title: "Testing", position: 250 }], page: 1, total_pages: 1 };
  expect(parseBuckets(envelope).map((bucket) => bucket.id)).toEqual([22, 15]);
  expect(parseBuckets([{ id: 1, title: "To-Do" }]).map((bucket) => bucket.title)).toEqual(["To-Do"]);
  expect(parseBuckets(null)).toEqual([]);
});

test("bucketForColumn matches names case-insensitively with fallbacks", () => {
  const board = parseBuckets([
    { id: 13, title: "To-Do", position: 1 },
    { id: 14, title: "DOING", position: 2 },
    { id: 22, title: "testing", position: 3 },
    { id: 15, title: "Done", position: 4 },
  ]);
  expect(bucketForColumn(board, "doing")?.bucket.id).toBe(14);
  expect(bucketForColumn(board, "testing")?.bucket.id).toBe(22);
  expect(bucketForColumn(board, "done")?.bucket.id).toBe(15);
  const noTesting = board.filter((bucket) => bucket.id !== 22);
  expect(bucketForColumn(noTesting, "testing")).toEqual({ bucket: expect.objectContaining({ id: 14 }), column: "doing" });
  const oddDone = parseBuckets([{ id: 1, title: "Backlog" }, { id: 9, title: "Shipped" }]);
  expect(bucketForColumn(oddDone, "done", 9)?.bucket.id).toBe(9);
  expect(bucketForColumn(oddDone, "doing")).toBeNull();
});

test("columnForPhase / phaseFromNote map workflow phases to columns", () => {
  for (const phase of ["Queue", "Spec", "Contract", "Approval", "Build", "repair", "building"]) expect(columnForPhase(phase)).toBe("doing");
  for (const phase of ["Verify", "verifying", "Merge", "Deliver", "testing"]) expect(columnForPhase(phase)).toBe("testing");
  expect(columnForPhase(undefined)).toBeNull();
  expect(columnForPhase("lunch")).toBeNull();
  expect(phaseFromNote("run wfr_1 phase: Verify")?.toLowerCase()).toBe("verify");
  expect(phaseFromNote("now in phase **Build**")?.toLowerCase()).toBe("build");
  expect(phaseFromNote("all good")).toBeNull();
});

test("workflowPhaseFromTimeline picks the running agent's phase, repair when a repair agent runs", () => {
  const row = (agents: unknown[]) => ({ rows: [{ workKind: "workflow", workflow: { agents } }] });
  expect(
    workflowPhaseFromTimeline(
      row([
        { label: "build:web", state: "done", phaseTitle: "Build", startedAt: "2026-10-22T01:00:00Z" },
        { label: "verify:web", state: "running", phaseTitle: "Verify", startedAt: "2026-10-22T01:05:00Z" },
      ]),
    ),
  ).toBe("Verify");
  expect(
    workflowPhaseFromTimeline(row([{ label: "repair:web#1", state: "running", phaseTitle: "Build", startedAt: "2026-10-22T01:09:00Z" }])),
  ).toBe("repair");
  expect(workflowPhaseFromTimeline({ rows: [] })).toBeNull();
  expect(workflowPhaseFromTimeline(null)).toBeNull();
});
