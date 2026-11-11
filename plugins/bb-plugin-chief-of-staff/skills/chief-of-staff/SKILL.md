---
name: chief-of-staff
description: Drive the Chief of Staff with the bb chief command — it runs Vikunja tasks assigned to CTO-bot through worker threads and collects decisions, policies, and briefings.
---

## Current workflow safety and scheduling

The defaults are `maxConcurrent=1` and `maxFeatureRuns=1`: finish one admitted task
before admitting another, including a queued workflow with no resource lease. Existing
stored settings are not migrated by a source update; set both values to 1 in the plugin
settings when activating serial operation. Feature dispatch freezes `maxParallelRuns`
from `maxFeatureRuns` into its workflow args (default 1). This is scheduler admission,
not a universal host limit: directly launched workflows and old frozen args can bypass
CoS; the workflow's atomic run-slot/resource helper remains the execution gate.

With an explicit larger cap only, a fresh Queue workflow with verified no lease may
release its productive slot for a proven hard-dependency or fresh resource wait. Missing
or corrupt evidence remains counted. Urgent tasks go first, followed by previously
integrated candidates waiting for final acceptance, without preempting admitted work.
Custom workflow names retain conservative resource gating. Never remove leases or
restart active runs to create room.

`bb chief pause <task>` persists the pause before stopping durable workflows and the
driver, then verifies no queued/running workflows and a stopped driver remain. Failure
is reported as `pause incomplete`; the row stays paused and retains its admission slot.
Retry pause to finish cancellation; do not resume or admit a replacement on uncertainty.
Manual pauses never auto-resume, even after thread deletion. Only explicit resume may
request scheduler admission, and failed resume delivery restores the paused state.

While paused, a synchronous SDK dispatch guard rejects automatic system/agent/mixed
messages and retry drains for the tracked driver and verified direct children. Direct
user questions remain allowed with instructions forbidding task execution until resumed.
Late reports cannot erase the pause. This is not a process-tree kill: deeper/unmapped
threads are not guessed from titles, and the host's explicit user Send-now override bypasses
hooks. Durable workflow cancellation handles workflow workers; unrelated/manual processes
are outside this guard. Disabling the plugin also disables its dispatch hook.

For `nextAction=resume-final-candidate`, report final acceptance as pending, not delivered.
Use a fresh workflow with the exact last-run args plus `resumeFinalCandidate:true`, never
cached `--resume`, Build replay or reconstructed evidence. `candidate-checkpoint-invalid`
stays blocked for inspection. While paused, even this recovery waits for explicit resume.

For `publication-failed` / `nextAction=retry-publication`, preserve the saved receipt,
verified candidate and exact `publicationCommit`; `finalAcceptance=passed` is not
publication success. Park credential, refusal, divergence, hold, missing receipt,
changed main/candidate/context/origin, and dirty-tree failures with their exact reason.
For a transient/uncertain transport failure only, while admitted and not paused, start
at most one fresh workflow with the exact failed-run args plus `retryPublication:true`
and `publicationCommit` from the result. Do not use `--resume` or reconstruct receipts.
The publisher checks the remote outcome first and runs only publication: no Spec,
Build, review, checks, merge, or deploy. Another failure stays blocked, never force
push or merge new code to bypass it. `publication-held` remains parked under the task
restriction. `publication-complete` / `nextAction=deploy` means deployment is still
pending, not delivered; use only an existing documented, task-authorized deployment
path or report the missing path. A push never authorizes deployment.

Do not use `chief_of_staff_ask` for new worker questions: its long-held connection
is unreliable. Report stage `blocked` with a first line of:
`QUESTION: #<task> [irreversible|routine] thread=<thread id> run=<run id or none> | <question> | options: <A> / <B> / <C>`.
Post the same text as a task comment when available. Stop until Denis or his
assistant answers through `bb thread tell`; errors, timeouts, generic nudges and
silence are not approval. Report `progress` with `ANSWERED: #<task> <option>` before
continuing. Such QUESTION reports suppress automatic nudges, update wakeups and
failure retries. The legacy ask/decision APIs remain compatible for existing calls.

No app lanes is not evidence of completion. `lane-less-blocked` and legacy
`nothing-to-build` remain blocked; do not automatically restart Spec. Documentation
work must pass its independent acceptance check and normal merge/delivery gates.


The Chief of Staff plugin runs the Vikunja backlog for one assignee (by
default `CTO-bot`): every open task assigned to that user gets a BB worker
thread in the configured project (`proj_jjitzuscx6`, rateyourfood) — reusing
an already-linked thread when one exists. Routine worker questions are
answered from the policy table; everything else becomes a decision the user
answers in the Chief of Staff panel. Workers move the kanban: dispatch moves
the card to *Doing* with a comment, a done report closes the task.

Kanban flow (buckets matched by name, case-insensitive, per project/view; no
hardcoded ids): *Doing* on dispatch and through Queue/Spec/Contract/Approval/
Build → *Testing* when Verify starts (incl. the Merge checks) → back to
*Doing* on repair → *Done* when `done` is accepted. A board without a Testing
column keeps the card in Doing. Workers drive it with the
`chief_of_staff_report` `phase` field (feature drivers: the workflow phase from
`bb workflows status`, `repair` when Verify sent it back; plain workers:
`verifying` / `building`). For features the plugin also reads the live run
(run id → status and current phase) from the workflows plugin on every sweep,
`bb chief tasks` and brief, so `#12 (active, feature running, phase Build)` is
current even when the driver reported only at launch.

A task marked done, deleted or unassigned from the managed user in Vikunja is
closed by the next sweep whatever its state: queued/running workflow runs are
cancelled (which releases the feature-delivery Queue lock and the
`maxFeatureRuns` slot), the worker thread is stopped and archived, and one
comment is left. A run in Merge/Deliver is left to finish first (the task shows
`closed in Vikunja; waiting for the in-flight Merge …`); do not cancel it by
hand.

Use the `bb chief` CLI to inspect and drive it:

```sh
bb chief tasks                   # managed tasks with worker state
bb chief sync                    # poll Vikunja now and reconcile workers
bb chief brief --refresh         # decisions, in flight, stalled, completed
bb chief decisions               # pending decisions first, with ids
bb chief answer <decision-id> "Use the existing auth middleware" --remember "auth,middleware"
bb chief pause 7                 # pause driver + durable workflows; verify cancellation
bb chief resume 7
bb chief policy list             # keyword → auto-answer rules
bb chief policy add deploy "Ship behind the feature flag; never enable by default."
```

Operating constraints:

- Requires the **vikunja plugin** to be installed, running, and configured
  with a token; the chief of staff reaches Vikunja only through it.
- Only tasks **assigned to the managed user** (default `CTO-bot`) are
  managed; everything else in Vikunja is untouched.
- New worker threads spawn only in the configured BB project; existing linked
  threads are reused wherever they live (`bb vikunja link` records them).
- At most `maxConcurrent` workers run at once; extra tasks wait for a free
  slot and are picked up on later syncs.
- `bb chief answer` delivers the answer to the waiting worker; `dismiss`
  tells it to proceed with its best judgment.
- Policies match when any keyword appears as a whole word in the question;
  the built-ins cover branches, tests, commits, dependencies, and formatting.
- Worker threads titled `#<task-id> <title>` report through
  chief_of_staff_report; a `done` report closes the Vikunja task.
- **Routing:** a task labelled `feature` (setting `featureLabel`) or whose
  description has a `feature: <kebab-name>` line is a *feature*: its worker
  (ZCode GLM-5.3-Flash) only drives the `feature-delivery` bb workflow with
  frozen args, and its `done` is accepted only once the workflow returned
  `merged-to-main` (or `delivered` when the task asked for a deploy). The
  feature name is the `feature:` line verbatim, else a ≤32-char word-boundary
  slug of the title (parentheses/filler dropped; `-<task id>` appended on a
  collision with another task's feature or a git branch/worktree). "Asked for
  a deploy" means an explicit `Deploy: yes` / `Ship: yes` line or a clear
  affirmative ("and deploy to prod"); `Deploy: no`, negations and bare
  mentions ("deploy script", "push notifications") mean NO — write
  `Deploy: no` / `Deploy: yes` in task descriptions to be unambiguous. A negated
  deployment overrides even `Deploy: yes`. `Push: yes`, `publishRequested: true`,
  and pushing to origin/main/remote/GitHub never authorize deployment. At most
  `maxFeatureRuns` (default 1) feature runs at once; the workflow also enforces
  its configured atomic slot cap and resource leases, so a run in phase `Queue` ("queued
  behind <run id>") is waiting normally and must not be restarted. Other tasks get a plain
  implementer (ZCode GLM-5.3). Commit the final candidate with current main
  included in the worker's own worktree, confirm a clean worktree, record its
  immutable SHA, and run the required gates on that exact SHA. Only `merge --ff-only <verified-sha>`
  into main when it has not moved and no local edits are touched; never create
  another merge commit after verification. Candidate/main changes require
  preparation and verification again. Unless the task explicitly says no-push
  or local-only, push `<verified-sha>:refs/heads/main` (never force) and verify
  the remote ref equals that SHA. A rejected push stays blocked.
- **Tests:** follow `rateyourfood-test-budget` in rateyourfood. Reuse meaningful
  existing coverage, extend the nearest case for a concrete uncovered failure,
  and choose the cheapest valid layer. Do not add tests for quotas, coverage
  percentages, or assertions proving only mocks. Focused iteration does not
  replace the required final-candidate acceptance gates.
- **Reversible vs irreversible:** code, docs, tests, local commits and merging
  into local main need no approval. Irreversible/high-impact questions
  (deleting data, destructive migrations, force-push, secrets, spending money,
  external messages, changing DNS records, issuing/revoking production certs,
  production config changes, production the task did not ask for) skip the
  policies, wait for
  Denis without a timeout, and a dismissal means **no**
  (`chief_of_staff_ask` with `kind: "irreversible"`, also detected from the
  question text). Publishing the exact verified SHA is standing policy unless
  the task explicitly says no-push or local-only. A Git push answer authorizes
  only publication, not deployment. Deploy/release questions are auto-allowed only when the task
  text explicitly asked for a deploy/release. Detection is negation- and
  context-aware: "no DNS change", "don't spend", "without touching certs",
  reading DNS/certs and estimating cost are routine; genuinely ambiguous DNS,
  cert or money questions escalate. Phrase questions plainly, one action per
  sentence.

Codex cost savings (A–E + A+ + A++): on `nextAction=continue-repair` / partial with `repairIssues` / **main-merge conflict** (`mergeConflict` / `mergeConflictRepair`) / **manager adoption** of process or lane-ownership MAJORs on the integration branch, re-run with `continueRepair:true` + same `specRound` (and mergeConflict fields when present) — no fresh Spec. Fresh Spec only on first attempt, true scope change, or new ticket; never solely for a merge conflict or solely because the manager patched process MAJORs; "manager fixes + ONE FRESH run" means continue-repair, not a new Codex Spec; cap `MAX_SPEC_ROUNDS=3` then pause. Mechanical/identity tickets skip early/final Codex review inside the workflow.


### Durable pause and legacy recovery limitations

Pause persists before cancellation and invalidates pending admissions. It verifies the worker,
all host-verified descendants (including hidden grandchildren), and their active workflows.
An enumeration or stop failure remains `pause incomplete` and reserves admission even if the
root thread was deleted. Retry pause only after the ownership/stop problem is resolved.
Automatic dispatch with unavailable or cyclic ancestry is rejected; ownership comes from host
thread relationships, never titles, task text, or untrusted plugin metadata. Verified ownership
survives reload and root deletion. No live settings or existing tasks are migrated by installing
this source change.

Historical task metadata does not contain the exact last workflow arguments or a durable
recovery envelope. If a feature driver is lost, resume therefore leaves the task paused and
blocked: it must not reconstruct arguments from task text, assume a stale Merge status is
current, or replay Spec/Build. Restore the original driver and inspect its actual run result and
checkpoint before resuming it. If the user explicitly wants genuinely new work, create a new
Vikunja task with a new identity; do not silently reset the old feature task. Merely changing a
title or clearing an error is not authorization to replay an old candidate.

### Held bootstrap for safe reconciliation

`dispatchEnabled` defaults to false, including existing installations without the setting.
Enabling/loading the plugin alone exposes status, pause, decisions and other management tools
but does not poll/admit tasks, resume drivers, retry failed workers, or dispatch automatic
messages to owned threads. Direct user questions remain allowed without execution. This hold
does not retroactively stop already-running processes: use task pause and verify cancellation.

Before turning dispatch on, inspect `bb chief tasks`, reconcile completed work through the
source tracker, preserve intended task pauses, and verify no other exclusive work reservation.
Only then explicitly run `bb plugin config chief-of-staff set dispatchEnabled true`. Keep
`maxConcurrent=1` and `maxFeatureRuns=1` for serial delivery. Setting dispatchEnabled false
holds future dispatch again; it does not delete task history or reset old workflow arguments.

While dispatch is held, `bb chief reconcile-completed <task-id> --json` closes only
that task's local bookkeeping after two authoritative source checks confirm done=true
and the root plus host-verified descendants have idle/error status and no active workflows.
Unverifiable ownership/status blocks instead of guessing. It never sends a message, stops or
archives a thread, cancels a workflow, changes leases, runs admission, or edits the tracker.
Missing/unassigned source tasks do not qualify. Other paused tasks and decisions stay untouched.


### Restore only one selected task

`allowedTaskId` is a durable numeric setting: `-1` (the default) holds all task execution, `0` explicitly permits the normal serial queue, and a positive task ID restricts execution to that task and its verified descendants. The SDK cannot represent a nullable numeric setting. Missing or malformed stored values fall back to the fail-closed default; the host may normalize legacy numeric strings to their exact numeric value.

Keep `dispatchEnabled=false` while selecting a task and reconciling completed tasks. After all external acceptance leases are released and the operator approves restoration, enable dispatch and explicitly resume the selected task. Selection does not bypass pauses, closed-task barriers, serial caps, or missing-driver recovery checks. It does not clear when the selected task completes: other tasks remain excluded until the operator explicitly changes the setting. Direct questions/status remain available, without execution tools on excluded tasks. Selection is an admission barrier, not cancellation of already running work; set it while held and quiescent.
