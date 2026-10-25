---
name: chief-of-staff
description: Drive the Chief of Staff with the bb chief command — it runs Vikunja tasks assigned to CTO-bot through worker threads and collects decisions, policies, and briefings.
---

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
bb chief pause 7                 # stop a task's worker (task id from Vikunja)
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
  `Deploy: no` / `Deploy: yes` in task descriptions to be unambiguous. At most
  `maxFeatureRuns` (default 1) feature runs at once; the workflow also enforces
  one run at a time with a project lock, so a run in phase `Queue` ("queued
  behind <run id>") is waiting normally and must not be restarted. Other tasks get a plain
  implementer (ZCode GLM-5.3) that merges its worktree branch into local main
  once tests pass.
- **Reversible vs irreversible:** code, docs, tests, local commits and merging
  into local main need no approval. Irreversible/high-impact questions
  (deleting data, destructive migrations, force-push, secrets, spending money,
  external messages, changing DNS records, issuing/revoking production certs,
  production config changes, production the task did not ask for) skip the
  policies, wait for
  Denis without a timeout, and a dismissal means **no**
  (`chief_of_staff_ask` with `kind: "irreversible"`, also detected from the
  question text). Plain `git push origin` after a green merge is standing policy
  (always allowed). Deploy/release questions are auto-allowed only when the task
  text explicitly asked for a deploy/release. Detection is negation- and
  context-aware: "no DNS change", "don't spend", "without touching certs",
  reading DNS/certs and estimating cost are routine; genuinely ambiguous DNS,
  cert or money questions escalate. Phrase questions plainly, one action per
  sentence.

Codex cost savings (A–E + A+): on `nextAction=continue-repair` / partial with `repairIssues` / **main-merge conflict** (`mergeConflict` / `mergeConflictRepair`), re-run with `continueRepair:true` + same `specRound` (and mergeConflict fields when present) — no fresh Spec. Fresh Spec only on first attempt, true scope change, or new ticket; never solely for a merge conflict; cap `MAX_SPEC_ROUNDS=3` then pause. Mechanical/identity tickets skip early/final Codex review inside the workflow.
