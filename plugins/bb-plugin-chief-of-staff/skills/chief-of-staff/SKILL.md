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
  `merged-to-main` (or `delivered` when the task asked for a deploy). At most
  `maxFeatureRuns` (default 1) feature runs at once. Other tasks get a plain
  implementer (ZCode GLM-5.3) that merges its worktree branch into local main
  once tests pass.
- **Reversible vs irreversible:** code, docs, tests, local commits and merging
  into local main need no approval. Irreversible/high-impact questions
  (deleting data, destructive migrations, secrets, paid actions, external
  messages, production the task did not ask for) skip the policies, wait for
  Denis without a timeout, and a dismissal means **no**
  (`chief_of_staff_ask` with `kind: "irreversible"`, also detected from the
  question text). Push/deploy questions are auto-allowed only when the task
  text explicitly asked for a push/deploy/release.
