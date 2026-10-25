import { expect, test } from "vitest";
import {
  bucketForColumn,
  buildWorkerPrompt,
  classifyQuestion,
  classifyTask,
  columnForPhase,
  deployIntent,
  FEATURE_SLUG_MAX,
  featureArgs,
  MAX_SPEC_ROUNDS,
  parseBuckets,
  phaseFromNote,
  slugFeature,
  workflowPhaseFromTimeline,
  operatingRules,
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
  expect(classifyQuestion("Should I push to origin now?", false)).toBe("deploy-allowed");
  expect(classifyQuestion("Should I push to origin now?", true)).toBe("deploy-allowed");
  expect(classifyQuestion("Can I deploy to prod?", false)).toBe("irreversible");
  expect(classifyQuestion("Can I deploy to prod?", true)).toBe("deploy-allowed");
  expect(classifyQuestion("Tests are green. Should I push and deploy now?", false)).toBe("irreversible");
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

test("dependency layers: inference and explicit lines", async () => {
  const { classifyDependencies, describeDeps } = await import("./logic");
  const android = classifyDependencies({ title: "Android e2e loop", description: "" }, "android-e2e-loop");
  expect(android.resources).toContain("emulator");
  expect(android.dependsOn).toEqual([]);
  const backend = classifyDependencies({ title: "M2-1 Backend scaffold", description: "Postgres + API" }, "backend-scaffold");
  expect(backend.resources).toEqual([]);
  expect(backend.dependsOn).toEqual([]);
  const tunnel = classifyDependencies({ title: "VPN check", description: "Assert that tunnel traffic reaches the peer" }, "vpn-check");
  expect(tunnel.dependsOn).toEqual(["android-e2e-loop"]);
  const explicit = classifyDependencies(
    { title: "Android client for menus", description: "Depends-on: menus-api<br>Resources: none<br>Soft-after: admin-web" },
    "android-menus",
  );
  expect(explicit.dependsOn).toEqual(["menus-api"]);
  expect(explicit.resources).toEqual([]);
  expect(explicit.softAfter).toEqual(["admin-web"]);
  expect(describeDeps(explicit)).toContain("soft: admin-web");
  // Mechanical / applicationId rename: android-sdk-gradle only, never infer emulator.
  const rename = classifyDependencies(
    {
      title: "Rename Android applicationId",
      description: "Size: small\nTags: mechanical, applicationId-only\nResources: android-sdk-gradle\nDepends-on: none\nSoft-after: none\nRename the applicationId/namespace only; no UX or behavior change.",
    },
    "android-package-rename",
  );
  expect(rename.resources).toEqual(["android-sdk-gradle"]);
  expect(rename.resources).not.toContain("emulator");
  const renameInferred = classifyDependencies(
    {
      title: "Rename Android package name",
      description: "Size: small\nRename the Android applicationId and namespace only. No UX change.",
    },
    "android-package-rename",
  );
  expect(renameInferred.resources).toEqual(["android-sdk-gradle"]);
  expect(renameInferred.source.resources).toMatch(/mechanical/);
  // Real behavior/UI android still gets the emulator.
  const behavior = classifyDependencies(
    { title: "Android onboarding screen", description: "Add an onboarding flow with e2e coverage" },
    "android-onboarding",
  );
  expect(behavior.resources).toEqual(["emulator", "android-sdk-gradle"]);
});

test("scheduling decision: hard > resource > cap; soft never blocks", async () => {
  const { schedulingDecision } = await import("./logic");
  const deps = (over: Partial<{ dependsOn: string[]; resources: string[]; softAfter: string[] }>) => ({
    dependsOn: [],
    resources: [],
    softAfter: [],
    source: { dependsOn: "", resources: "", softAfter: "" },
    ...over,
  });
  const android = [{ taskId: 12, feature: "android-e2e-loop", resources: ["emulator", "android-sdk-gradle"] }];
  // Backend runs in parallel with the Android run.
  expect(schedulingDecision({ deps: deps({}), active: android, maxFeatureRuns: 3, depDone: () => false }).eligible).toBe(true);
  // Same resource serializes.
  const sameRes = schedulingDecision({ deps: deps({ resources: ["emulator"] }), active: android, maxFeatureRuns: 3, depDone: () => false });
  expect(sameRes).toMatchObject({ eligible: false, layer: "resource" });
  expect(sameRes.reason).toContain("#12");
  // Hard dep blocks until merged.
  const hard = schedulingDecision({
    deps: deps({ dependsOn: ["admin-auth"] }),
    active: [],
    maxFeatureRuns: 3,
    depDone: () => false,
    taskForFeature: () => 31,
  });
  expect(hard).toMatchObject({ eligible: false, layer: "hard" });
  expect(hard.reason).toContain("admin-auth (#31)");
  expect(schedulingDecision({ deps: deps({ dependsOn: ["admin-auth"] }), active: [], maxFeatureRuns: 3, depDone: () => true }).eligible).toBe(true);
  // Soft deps never block.
  expect(schedulingDecision({ deps: deps({ softAfter: ["android-e2e-loop"] }), active: android, maxFeatureRuns: 3, depDone: () => false }).eligible).toBe(true);
  // Global cap.
  const full = [1, 2, 3].map((taskId) => ({ taskId, feature: null, resources: [] }));
  expect(schedulingDecision({ deps: deps({}), active: full, maxFeatureRuns: 3, depDone: () => true })).toMatchObject({ layer: "cap" });
});

test("heavy-device group: ios-simulator never runs alongside emulator / android-sdk-gradle; Xcode tickets get ios-simulator", async () => {
  const { schedulingDecision, classifyDependencies, resourcesConflict } = await import("./logic");
  expect(resourcesConflict("ios-simulator", "emulator")).toBe(true);
  expect(resourcesConflict("emulator", "ios-simulator")).toBe(true);
  expect(resourcesConflict("ios-simulator", "android-sdk-gradle")).toBe(true);
  expect(resourcesConflict("android-sdk-gradle", "ios-simulator")).toBe(true);
  expect(resourcesConflict("emulator", "emulator")).toBe(true);
  expect(resourcesConflict("emulator", "android-sdk-gradle")).toBe(false);
  expect(resourcesConflict("ios-simulator", "postgres")).toBe(false);
  // Inference: iOS / Xcode / simulator tickets need the iOS simulator.
  const xcode = classifyDependencies({ title: "Mac mini: install Xcode and runtimes", description: "" }, "xcode-setup");
  expect(xcode.resources).toEqual(["ios-simulator"]);
  const sim = classifyDependencies({ title: "Simulator smoke for the app", description: "" }, "sim-smoke");
  expect(sim.resources).toEqual(["ios-simulator"]);
  // Explicit Resources lines still win.
  expect(classifyDependencies({ title: "Xcode setup", description: "Resources: none" }, "x").resources).toEqual([]);
  const deps = (resources: string[]) => ({
    dependsOn: [],
    resources,
    softAfter: [],
    source: { dependsOn: "", resources: "", softAfter: "" },
  });
  const iosRun = [{ taskId: 35, feature: "ios-mac-mini-env-setup", resources: ["ios-simulator"] }];
  const android = schedulingDecision({ deps: deps(["emulator", "android-sdk-gradle"]), active: iosRun, maxFeatureRuns: 3, depDone: () => true });
  expect(android).toMatchObject({ eligible: false, layer: "resource" });
  expect(android.reason).toContain("resource: emulator conflicts with ios-simulator in use by #35 (ios-mac-mini-env-setup)");
  const gradleOnly = schedulingDecision({ deps: deps(["android-sdk-gradle"]), active: iosRun, maxFeatureRuns: 3, depDone: () => true });
  expect(gradleOnly).toMatchObject({ eligible: false, layer: "resource" });
  const androidRun = [{ taskId: 28, feature: "android-package-rename", resources: ["emulator", "android-sdk-gradle"] }];
  const ios = schedulingDecision({ deps: deps(["ios-simulator"]), active: androidRun, maxFeatureRuns: 3, depDone: () => true });
  expect(ios).toMatchObject({ eligible: false, layer: "resource" });
  expect(ios.reason).toContain("ios-simulator conflicts with emulator in use by #28");
  // Backend work still runs beside the simulator.
  expect(schedulingDecision({ deps: deps([]), active: iosRun, maxFeatureRuns: 3, depDone: () => true }).eligible).toBe(true);
});

test("featureArgs includes specRound 1; MAX_SPEC_ROUNDS is 3", () => {
  expect(MAX_SPEC_ROUNDS).toBe(3);
  const args = featureArgs(
    { id: 13, title: "Backend scaffold", description: "Resources: none\nDepends-on: none" },
    { feature: "backend-scaffold", deployRequested: false },
  );
  expect(args.specRound).toBe(1);
  expect(args.feature).toBe("backend-scaffold");
  expect(args.vikunjaTask).toBe(13);
});

test("buildWorkerPrompt: continue-repair / spec-rounds-exhausted / no fresh Spec stuffing", () => {
  const prompt = buildWorkerPrompt(
    { id: 13, title: "Backend scaffold", description: "Resources: none" },
    { mode: "feature", feature: "backend-scaffold", deployRequested: false, workflowName: "feature-delivery" },
  );
  expect(prompt).toMatch(/continue-repair/);
  expect(prompt).toMatch(/continueRepair:true/);
  expect(prompt).toMatch(/spec-rounds-exhausted/);
  expect(prompt).toMatch(/DO NOT launch a fresh Spec/);
  expect(prompt).toMatch(/DO NOT stuff findings into a new brief/);
  expect(prompt).toMatch(/bump specRound by 1/);
  expect(prompt).toMatch(/SAME specRound/);
  expect(prompt).toContain('"specRound":1');
  // A+: main-merge conflict uses continue-repair / mergeConflictRepair — never fresh Spec alone
  expect(prompt).toMatch(/mergeConflictRepair:true/);
  expect(prompt).toMatch(/main-merge-failed/);
  expect(prompt).toMatch(/NEVER start a fresh Spec solely because of a main merge conflict/);
  // A++: manager adoption of process/lane-ownership MAJORs → continue-repair, never fresh Spec
  expect(prompt).toMatch(/NEVER start a fresh Spec solely because the manager/);
  expect(prompt).toMatch(/manager adoption/);
  expect(prompt).toMatch(/ONE FRESH run.*continueRepair/s);
  expect(prompt).toMatch(/Manager adoption exception/);
  expect(operatingRules({ mode: "feature", feature: "backend-scaffold", deployRequested: false, workflowName: "feature-delivery" }).join("\n")).toMatch(/continueRepair:true/);
});
