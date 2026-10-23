Run your Vikunja backlog through supervised agent threads and stay out of the
weeds: the Chief of Staff watches the tasks you assign to one Vikunja user
(CTO-bot), gives each a worker thread, answers the routine questions itself,
and brings you only the decisions that are yours.

## What you get

- A **Chief of Staff** panel: the current briefing on top, the decisions
  waiting on you, the managed Vikunja tasks with each worker thread, and the
  auto-answer policy list — plus a Sync-now button.
- **Reuse or create.** A task that already has a linked BB thread is adopted
  where it lives; otherwise a new worker spawns in one configured BB project,
  titled `#<task-id> <title>` and seeded with the task's description.
- **Kanban write-back.** Dispatch moves the card to *Doing* with a comment; a
  done report closes the task (landing in *Done*) with a final comment;
  failures are commented so the board tells the story.
- **Routine questions answered by policy.** Workers ask a single
  `chief_of_staff_ask` tool; keyword policies (branching, tests, commits,
  dependencies, formatting — plus your own rules) answer instantly.
- **A short decision queue.** What policy cannot answer waits for you in the
  panel; your answer is delivered straight back to the worker.
- **Workers that keep moving.** Idle workers get nudged, a failed turn is
  retried once, genuinely stalled tasks are flagged, tasks completed or
  unassigned in Vikunja wrap up on their own, and a concurrency budget keeps
  the spawn burst small.
- **Parallel features, dependency-aware.** Feature tasks run up to 3 at a
  time; each is classified into hard deps (wait for merge to main), shared
  resources (e.g. the Android emulator — serialize only on that), and soft
  deps (shown, never blocking). Blocked tasks say exactly why, on the board
  and in `bb chief tasks`.
- A `bb chief` CLI for everything — `sync`, `tasks`, `pause`/`resume`,
  `decisions`, `answer`, `policy`, `brief` — so agents and scripts can drive
  the same board.

## How it works

The plugin reaches Vikunja through the installed **vikunja plugin**'s RPC
(MCP `call`, task↔thread `links`, kanban `buckets`/`move`) — one token, one
integration. Task pairings, decisions, policies, and briefings live in this
plugin's own SQLite storage on the BB server. Nothing leaves the machine.
