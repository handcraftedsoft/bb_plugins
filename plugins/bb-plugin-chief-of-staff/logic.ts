// Pure, bb-free logic for the Chief of Staff plugin: Vikunja task parsing,
// policy triage, worker prompts, and briefing composition. Kept as plain
// functions so tests cover the behavior without a plugin host.

export type TaskState = "active" | "paused" | "closed";

export type ReportStage = "started" | "progress" | "done" | "blocked" | "failed";

/** The subset of a Vikunja task the chief of staff cares about. */
export interface VikunjaTask {
  id: number;
  title: string;
  description: string;
  done: boolean;
  projectId: number;
  updated: string;
  assignees: string[];
  /** The bucket holding this task in its kanban view, when expand=buckets returned one. */
  bucketId: number | null;
  bucketTitle: string | null;
  viewId: number | null;
}

export interface TaskRow {
  taskId: number;
  title: string;
  projectId: number;
  threadId: string | null;
  state: TaskState;
  lastTaskUpdated: string;
  progressNote: string | null;
  progressAt: number | null;
  launchedAt: number | null;
  closedAt: number | null;
  nudgeCount: number;
  retries: number;
  stalled: 0 | 1;
  error: string | null;
  updatedAt: number;
}

export interface DecisionRow {
  id: string;
  /** Vikunja task id, stored as text. */
  itemId: string;
  threadId: string | null;
  question: string;
  context: string | null;
  options: string[];
  status: "pending" | "answered" | "dismissed";
  answer: string | null;
  autoAnswered: 0 | 1;
  askedAt: number;
  answeredAt: number | null;
}

export interface PolicyRow {
  id: string;
  keywords: string[];
  answer: string;
  source: "builtin" | "user";
  createdAt: number;
}

export interface BriefingRow {
  id: number;
  createdAt: number;
  text: string;
  signature: string;
}

export interface CosSettings {
  /** BB project that new worker threads are spawned into. */
  project: string;
  /** Vikunja username whose tasks are managed ("CTO-bot"). */
  assignee: string;
  maxConcurrent: number;
  stallMinutes: number;
  maxNudges: number;
  pollSeconds: number;
  decisionTimeoutHours: number;
}

/** Realtime channel the backend publishes on after every board change; the
 * panel listens and refetches. Lives here (bb-free) so app.tsx can import it. */
export const CHANGED_CHANNEL = "chief-of-staff-changed";

export const BUILTIN_POLICIES: Array<Pick<PolicyRow, "keywords" | "answer">> = [
  {
    keywords: ["branch"],
    answer:
      "Create a new branch named for this task (for example work/<short-slug>). Never commit directly to the default branch.",
  },
  {
    keywords: ["test", "tests", "testing"],
    answer:
      "Run the repository's existing test suite before finishing, and add or update tests for any behavior you change.",
  },
  {
    keywords: ["commit", "commits"],
    answer:
      "Commit your work in small, conventional commits on your working branch as you go.",
  },
  {
    keywords: ["dependency", "dependencies", "package", "library", "install"],
    answer:
      "Prefer dependencies already used in this repository. Adding a new runtime dependency needs explicit approval — if you truly need one, ask again and mark it as a decision.",
  },
  {
    keywords: ["style", "lint", "format", "formatting"],
    answer:
      "Follow the repository's existing formatter and linter configuration; match the style of neighboring code.",
  },
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A policy matches when any of its keywords appears as a whole word in the question. */
export function matchPolicy(
  question: string,
  policies: PolicyRow[],
): PolicyRow | null {
  const haystack = question.toLowerCase();
  for (const policy of policies) {
    for (const keyword of policy.keywords) {
      const needle = keyword.trim().toLowerCase();
      if (needle === "") continue;
      const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`);
      if (pattern.test(haystack)) return policy;
    }
  }
  return null;
}

export function parseKeywords(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword !== ""),
    ),
  ];
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  );
}

/** Strip HTML-ish description markup to plain text for the worker prompt. */
export function plainDescription(description: string): string {
  if (description.trim() === "") return "";
  return description
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface RawTask {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  done?: unknown;
  project_id?: unknown;
  updated?: unknown;
  assignees?: unknown;
  buckets?: unknown;
}

function parseOneTask(raw: RawTask): VikunjaTask | null {
  if (typeof raw.id !== "number" || typeof raw.title !== "string") return null;
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees
        .filter(
          (entry): entry is { username?: unknown } =>
            typeof entry === "object" && entry !== null,
        )
        .map((entry) => (typeof entry.username === "string" ? entry.username : ""))
        .filter((username) => username !== "")
    : [];
  const bucket = Array.isArray(raw.buckets)
    ? raw.buckets.find(
        (entry): entry is { id?: unknown; title?: unknown; project_view_id?: unknown } =>
          typeof entry === "object" && entry !== null,
      )
    : undefined;
  return {
    id: raw.id,
    title: raw.title,
    description: typeof raw.description === "string" ? raw.description : "",
    done: raw.done === true,
    projectId: typeof raw.project_id === "number" ? raw.project_id : 0,
    updated: typeof raw.updated === "string" ? raw.updated : "",
    assignees,
    bucketId: typeof bucket?.id === "number" ? bucket.id : null,
    bucketTitle: typeof bucket?.title === "string" ? bucket.title : null,
    viewId: typeof bucket?.project_view_id === "number" ? bucket.project_view_id : null,
  };
}

/** Parse one paginated tasks_list envelope; returns null when the shape is wrong. */
export function parseVikunjaTasksPage(envelope: unknown): { tasks: VikunjaTask[]; totalPages: number } | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const page = envelope as { items?: unknown; total_pages?: unknown };
  if (!Array.isArray(page.items)) return null;
  const tasks = page.items.flatMap((raw) => {
    const task = parseOneTask(raw as RawTask);
    return task === null ? [] : [task];
  });
  return {
    tasks,
    totalPages: typeof page.total_pages === "number" ? page.total_pages : 1,
  };
}

/** Keep only tasks assigned to the managed Vikunja user. */
export function filterByAssignee(tasks: VikunjaTask[], assignee: string): VikunjaTask[] {
  const needle = assignee.trim().toLowerCase();
  if (needle === "") return [];
  return tasks.filter((task) => task.assignees.some((name) => name.toLowerCase() === needle));
}

/** The prompt a worker thread starts its first turn with. */
export function buildWorkerPrompt(task: Pick<VikunjaTask, "id" | "title" | "description">): string {
  const detail = plainDescription(task.description);
  const brief = detail === "" ? "(the task has no description — work from the title)" : detail;
  return [
    "You are working one Vikunja task for the user, supervised by the Chief of Staff plugin.",
    "",
    `Task #${task.id}: ${task.title}`,
    "Description:",
    brief,
    "",
    "Operating rules:",
    "- Work autonomously toward a finished result. Make the routine calls yourself (naming, structure, tests, commits) following this repository's conventions.",
    '- Report with the chief_of_staff_report tool: stage "started" when you begin, "progress" with a short note after each meaningful step, "done" when the task is complete, "failed" if you cannot finish.',
    "- If you are blocked on a question only the user can answer, call chief_of_staff_ask. It answers immediately when policy covers it; otherwise it waits for the user and may take a long time — only ask when genuinely blocked.",
    "- If the ask tool errors or times out, proceed with your best judgment and note the decision in your final report.",
    "- Keep your changes within this project's workspace.",
    "",
    "Begin now.",
  ].join("\n");
}

/** The dynamic instruction block the configure callback injects into worker sessions. */
export function workerInstructions(taskTitle: string): string {
  return [
    "You are working a Chief of Staff task:",
    JSON.stringify(taskTitle),
    "Use chief_of_staff_report to report progress and completion, and chief_of_staff_ask only when blocked on a question you cannot decide. If the ask tool errors or times out, proceed with your best judgment and note it in your final report.",
  ].join("\n");
}

export function describeAnswer(outcome: "answered" | "dismissed" | "timeout", answer: string): string {
  if (outcome === "answered") return `Decision from the user: ${answer}`;
  if (outcome === "dismissed") {
    return "The user dismissed this question without an answer. Proceed using your best judgment and note the choice in your final report.";
  }
  return "No answer arrived in time. Proceed using your best judgment and note the choice in your final report.";
}

export function formatAge(thenMs: number | null, nowMs: number): string {
  if (thenMs === null) return "never";
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface TaskBrief {
  taskId: number;
  title: string;
  state: TaskState;
  progressNote: string | null;
  progressAt: number | null;
  stalled: boolean;
  nudgeCount: number;
  threadStatus: string | null;
  error: string | null;
  closedAt: number | null;
}

export interface BriefingInput {
  now: number;
  lastBriefingAt: number | null;
  /** True when the Vikunja plugin is reachable and configured. */
  configured: boolean;
  tasks: TaskBrief[];
  /** Pending decisions, each paired with its task id and title. */
  pendingDecisions: Array<{ taskId: number; taskTitle: string; question: string }>;
}

export interface Briefing {
  text: string;
  signature: string;
}

function line(item: TaskBrief, now: number): string {
  const parts = [`#${item.taskId} ${item.title}`];
  if (item.state === "active") {
    if (item.stalled) {
      parts.push(`stalled: no progress, nudged ${item.nudgeCount}×`);
    } else {
      const note = item.progressNote === null ? "no report yet" : `last: ${item.progressNote}`;
      parts.push(`${note} (${formatAge(item.progressAt, now)})`);
      if (item.threadStatus !== null && item.threadStatus !== "idle") {
        parts.push(`thread ${item.threadStatus}`);
      }
    }
  } else if (item.error !== null) {
    parts.push(item.error);
  }
  return `  ${parts.join(" — ")}`;
}

/** Compose the user-facing briefing. `signature` excludes the timestamp so an
 * unchanged board does not look like a new briefing. */
export function buildBriefing(input: BriefingInput): Briefing {
  const { now, lastBriefingAt, configured, tasks } = input;
  const sections: string[] = [];

  if (input.pendingDecisions.length > 0) {
    sections.push(
      `NEEDS YOUR DECISION (${input.pendingDecisions.length})`,
      ...input.pendingDecisions.map(
        (decision) => `  #${decision.taskId} ${decision.taskTitle} — ${decision.question}`,
      ),
    );
  }

  const running = tasks.filter((task) => task.state === "active");
  if (running.length > 0) {
    sections.push(`IN FLIGHT (${running.length})`, ...running.map((task) => line(task, now)));
  }
  if (running.some((task) => task.stalled)) {
    sections.push(
      "Stalled workers need attention: answer their questions, nudge them, or pause the task.",
    );
  }

  const closed = tasks.filter(
    (task) => task.state === "closed" && (lastBriefingAt === null || (task.closedAt ?? 0) > lastBriefingAt),
  );
  if (closed.length > 0) {
    sections.push(
      `COMPLETED (${closed.length} since the last briefing)`,
      ...closed.map((task) => `  #${task.taskId} ${task.title}`),
    );
  }

  const paused = tasks.filter((task) => task.state === "paused");
  if (paused.length > 0) {
    sections.push(
      `PAUSED (${paused.length})`,
      `  ${paused.map((task) => `#${task.taskId} ${task.title}`).join(" · ")}`,
    );
  }

  const failed = tasks.filter((task) => task.state === "active" && task.error !== null);
  if (failed.length > 0) {
    sections.push(`FAILURES (${failed.length})`, ...failed.map((task) => line(task, now)));
  }

  if (!configured) {
    sections.push(
      "Not configured: the Vikunja plugin must be installed, running, and have a token set before the chief of staff can manage tasks.",
    );
  }

  const body = sections.length === 0 ? "All quiet: no CTO-bot tasks in flight." : sections.join("\n");
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 16);
  return {
    text: `Chief of staff briefing — ${stamp}\n\n${body}`,
    signature: body,
  };
}
