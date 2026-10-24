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
  /** Label titles on the task (used to route features to the workflow). */
  labels: string[];
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
  /** Hours a ROUTINE question waits before the worker proceeds on its own.
   * Irreversible decisions never time out. */
  decisionTimeoutHours: number;
  /** Vikunja label that routes a task through the feature-delivery workflow. */
  featureLabel: string;
  /** bb workflow (under .bb/workflows/) that feature tasks run through. */
  workflowName: string;
  /** Feature tasks allowed to drive a workflow run at the same time (RAM budget). */
  maxFeatureRuns: number;
  /** Provider/model for worker threads ("" = the project's remembered default). */
  workerProvider: string;
  featureWorkerModel: string;
  taskWorkerModel: string;
  workerReasoning: string;
}

export type TaskMode = "feature" | "task";

export type DecisionKind = "routine" | "irreversible";

/** Per-task routing facts the chief of staff derives from the Vikunja task. */
export interface TaskMeta {
  taskId: number;
  mode: TaskMode;
  /** kebab-case feature name for the workflow (feature mode only). */
  feature: string | null;
  /** The task text explicitly asks for a push / deploy / release. */
  deployRequested: boolean;
  workflowRunId: string | null;
  workflowStatus: string | null;
  /** Live phase of the workflow run, read from the workflows plugin (not the driver's last report). */
  workflowPhase: string | null;
  /** Live run status (queued/running/succeeded/failed/cancelled) from the workflows plugin. */
  runStatus: string | null;
  /** When the live run view was last read. */
  phaseAt: number | null;
}

/** Realtime channel the backend publishes on after every board change; the
 * panel listens and refetches. Lives here (bb-free) so app.tsx can import it. */
export const CHANGED_CHANNEL = "chief-of-staff-changed";

export const BUILTIN_POLICIES: Array<Pick<PolicyRow, "keywords" | "answer">> = [
  {
    keywords: ["branch", "branches", "worktree", "worktrees"],
    answer:
      "Feature tasks: the feature-delivery workflow creates and owns every branch and worktree (feature/<name>, feature/<name>-<lane>); never create or switch branches yourself. Plain tasks: commit on the branch of your own bb worktree. Never check out, stash, or edit files in the shared main checkout by hand.",
  },
  {
    keywords: ["merge", "merging", "merged"],
    answer:
      "Merging into LOCAL main is reversible and expected once everything passes. Feature tasks: feature-delivery does the merge. Plain tasks: once make test-<app> and make lint are green, merge with `git -C <main checkout> merge --no-ff <your branch>` where <main checkout> is the first entry of `git worktree list --porcelain` and must be on main; only if the merge touches no locally modified file there, otherwise report blocked. Never force-push or rewrite history.",
  },
  {
    keywords: ["test", "tests", "testing", "lint"],
    answer:
      "Run make test-<app> for every area you touched plus make lint; both must be green before you report done. Add or update tests for any behavior you change.",
  },
  {
    keywords: ["commit", "commits"],
    answer:
      "Commit small, clearly described commits locally as you go. Never commit secrets, never use --no-verify, never rewrite history.",
  },
  {
    keywords: ["dependency", "dependencies", "package", "library", "install"],
    answer:
      "Prefer dependencies already used in this repository. Adding a new runtime dependency needs explicit approval — if you truly need one, ask again and mark it as a decision.",
  },
  {
    keywords: ["style", "format", "formatting"],
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
  labels?: unknown;
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
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .filter((entry): entry is { title?: unknown } => typeof entry === "object" && entry !== null)
        .map((entry) => (typeof entry.title === "string" ? entry.title.trim() : ""))
        .filter((title) => title !== "")
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
    labels,
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

// ---- routing: feature vs plain task, deploy requests, irreversible questions ----

/** `feature: <name>` on its own line; tolerates markdown emphasis/backticks
 * (`**feature:** \`name\``, `- feature: name`). */
const FEATURE_LINE = /^[\s>*_`#-]*feature[*_`]*\s*[:=][\s*_`]*([a-z0-9][a-z0-9-]{0,47})[\s*_`]*$/im;

// ---- deploy intent ------------------------------------------------------------
// Rules (mirrored in the rateyourfood feature-delivery workflow's
// `// <deploy-intent>` block; keep the two in sync):
//   1. An explicit `Deploy: yes|no` / `Ship: yes|no` line wins. Any explicit
//      "no" beats an explicit "yes" (conflict = ambiguous = NO).
//   2. A negated mention ("no deploy", "don't deploy", "do not deploy",
//      "without deploying", "not deploy", "nothing ships", "no push") = NO.
//   3. Otherwise YES only for an explicit affirmative: "and deploy",
//      "please deploy", "deploy to prod/staging", "redeploy prod", "ship it",
//      "push to origin", or an imperative line starting with "Deploy ...".
//   4. Everything else, including bare mentions ("deploy script",
//      "deployment docs", "push notifications"), is NO.
const DEPLOY_VERB = String.raw`(?:re-?deploy(?:s|ed|ing)?|deploy(?:s|ed|ing)?|ship(?:s|ped|ping)?|push(?:es|ed|ing)?|releas(?:e|es|ed|ing)|publish(?:es|ed|ing)?)`;
const DEPLOY_EXPLICIT =
  /^[\s>*_`#-]*(?:deploy(?:ment)?|ship|push|release|deliver(?:y)?)(?:\s+requested)?[*_`]*\s*[:=]\s*[*_`]*\s*(yes|y|true|on|required|no|n|false|off|none|never|not)\b/gim;
/** Negation cues shared by the deploy rules and question triage. */
const NEGATION_CUE = String.raw`(?:no|not|never|without|nothing|don'?t|do\s+not|doesn'?t|does\s+not|shouldn'?t|should\s+not|must\s+not|mustn'?t|won'?t|will\s+not|avoid|skip)`;
const DEPLOY_NEGATED = new RegExp(
  String.raw`\b${NEGATION_CUE}\b(?:\s+[\w'/-]+){0,3}?\s+${DEPLOY_VERB}\b`,
  "i",
);
const DEPLOY_AFFIRMATIVE: RegExp[] = [
  /\b(?:and|then|please|also|afterwards?)\s+(?:re-?deploy|deploy|ship|push|release|publish)\b(?!\s+(?:script|docs?|notes?|notifications?)\b)/i,
  new RegExp(
    String.raw`\b${DEPLOY_VERB}\s+(?:it\s+|this\s+|them\s+|main\s+|the\s+[\w-]+\s+)?(?:to|on|in)\s+(?:the\s+)?(?:prod(?:uction)?|staging|origin|remote|github|upstream|live|server|vps|app\s+store|play\s+store|testflight)\b`,
    "i",
  ),
  /\b(?:re-?deploy|deploy)\s+(?:the\s+)?(?:prod(?:uction)?|staging|live)\b/i,
  /\bship\s+it\b/i,
  /^[\s>*_-]*(?:re-?deploy|deploy|ship)\b(?![\s-]*(?:script|docs?|documentation|pipeline|config\w*|process|keys?|steps?|targets?|guide|notes?|section|files?|logs?|is|was|has|:))/im,
];

export interface DeployIntent {
  requested: boolean;
  reason: string;
}

/** Whether the task text explicitly asks for a deploy/push/release. Ambiguous = NO. */
export function deployIntent(text: string): DeployIntent {
  const source = String(text ?? "");
  const explicit = [...source.matchAll(DEPLOY_EXPLICIT)].map((match) => match[1]!.toLowerCase());
  if (explicit.length > 0) {
    const yes = explicit.some((value) => ["yes", "y", "true", "on", "required"].includes(value));
    const no = explicit.some((value) => !["yes", "y", "true", "on", "required"].includes(value));
    if (no) return { requested: false, reason: "explicit Deploy/Ship: no line" };
    if (yes) return { requested: true, reason: "explicit Deploy/Ship: yes line" };
  }
  const plain = source.replace(/[*_`]/g, "").replace(/[’‘]/g, "'");
  if (DEPLOY_NEGATED.test(plain)) return { requested: false, reason: "negated deploy mention" };
  if (DEPLOY_AFFIRMATIVE.some((pattern) => pattern.test(plain))) return { requested: true, reason: "explicit deploy request" };
  return { requested: false, reason: "no explicit deploy request" };
}

/** Filler dropped from feature slugs derived from a title. */
const SLUG_FILLER = new Set([
  "a", "an", "the", "and", "or", "for", "of", "to", "in", "on", "at", "by", "with", "without", "via", "from",
  "into", "onto", "is", "are", "be", "as", "this", "that", "these", "those", "some", "please", "our", "my", "your", "its", "it",
]);
export const FEATURE_SLUG_MAX = 32;

export interface SlugOptions {
  /** True when the name is already used by a branch, worktree, or another task. */
  taken?: (name: string) => boolean;
  /** Vikunja task id appended on a collision (`<slug>-<id>`). */
  taskId?: number;
}

/** Deterministic kebab-case feature name from a task title: parenthesized
 * parts and filler words dropped, cut at a word boundary (≤ 32 chars, no
 * trailing dash); `-<task id>` appended when the name collides. */
export function slugFeature(title: string, options: SlugOptions = {}): string {
  const stripped = title.replace(/\([^)]*\)?|\[[^\]]*\]?|\{[^}]*\}?/g, " ").toLowerCase();
  const all = stripped.split(/[^a-z0-9]+/).filter((word) => word !== "");
  const kept = all.filter((word) => !SLUG_FILLER.has(word));
  const words = kept.length > 0 ? kept : all;
  let base = "";
  for (const word of words) {
    const next = base === "" ? word : `${base}-${word}`;
    if (next.length > FEATURE_SLUG_MAX) break;
    base = next;
  }
  if (base === "" && words.length > 0) base = words[0]!.slice(0, FEATURE_SLUG_MAX);
  if (base === "") base = "feature";
  if (options.taken !== undefined && options.taskId !== undefined && options.taken(base)) {
    return `${base}-${options.taskId}`;
  }
  return base;
}

/** Route a Vikunja task: features (label or a `feature: <name>` line) run
 * through the workflow; everything else is a plain worker task. An explicit
 * `feature:` name is used as-is; a title-derived one avoids collisions. */
export function classifyTask(
  task: Pick<VikunjaTask, "id" | "title" | "description" | "labels">,
  featureLabel: string,
  taken?: (name: string) => boolean,
): Omit<TaskMeta, "workflowRunId" | "workflowStatus" | "workflowPhase" | "runStatus" | "phaseAt"> {
  const text = `${task.title}\n${plainDescription(task.description)}`;
  const label = featureLabel.trim().toLowerCase();
  const line = FEATURE_LINE.exec(plainDescription(task.description));
  const labelled = label !== "" && task.labels.some((entry) => entry.toLowerCase() === label);
  const feature =
    line !== null ? line[1]! : labelled ? slugFeature(task.title, { taken, taskId: task.id }) : null;
  return {
    taskId: task.id,
    mode: feature === null ? "task" : "feature",
    feature,
    deployRequested: deployIntent(text).requested,
  };
}

// ---- question triage ------------------------------------------------------------
// Rules (README "Irreversible questions"):
//   * The question (plus its context) is split into clauses at sentence
//     punctuation and contrastive conjunctions (but, however, unless, ...). A
//     mention counts only when it is not negated: a negation cue (the same list
//     the deploy rules use) at most three plain words before it in the same
//     clause, with no punctuation, condition or "don't forget/hesitate"-style
//     word in between ("no DNS change", "don't spend", "without touching certs").
//     A negation in one clause never covers another clause.
//   * Always irreversible: deleting/wiping data, prod migrations, force-push /
//     history rewrites, secrets and credentials, external messages.
//   * DNS and certificates/keystores: a mutating verb (change, update, issue,
//     revoke, renew, ...) is irreversible; read-only context (check, inspect,
//     dig, verify, "when does it expire") is routine; anything else is
//     ambiguous and escalates. Local/debug/self-signed certs are routine unless
//     production is mentioned.
//   * Money: spending verbs (pay, buy, purchase, subscribe, upgrade to a paid
//     tier) escalate unless the clause is an estimate ("how much would it cost
//     to buy ...") with no "should I / and / then" before the verb; spending
//     time/effort and code nouns ("purchase flow", "billing page") are routine.
//   * Production config: changing prod config/env vars/feature flags escalates
//     even when the task asked for a deploy.
//   * Deploy/push/release/production: allowed only when the task asked for a
//     deploy (same verbs as deployIntent); negated mentions do not count.

const CLAUSE_SPLIT = /[?!;\n]+|\.(?=\s|$)|:(?=\s)|\s*,?\s*\b(?:but|however|although|though|except|unless|whereas)\b\s*/i;

/** Words that, between a negation cue and a topic, break the negation's scope. */
const SCOPE_BREAKERS = new Set([
  "when", "if", "before", "after", "while", "once", "until", "because", "since", "by", "instead", "rather",
  "sure", "certain", "clear", "whether", "yet", "only", "just", "but", "and", "or", "then", "also",
  "should", "can", "could", "would", "will", "may", "might", "must", "shall",
  "i", "we", "you", "they", "he", "she",
  "forget", "hesitate", "wait", "worry", "fail", "delay", "mind", "stop", "hold",
]);
const NEGATION_TAIL = new RegExp(String.raw`\b(${NEGATION_CUE})((?:\s+[\w'/.-]+){0,3}?)\s*$`, "i");

/** True when the mention starting at `index` is negated within its clause. */
function negatedAt(clause: string, index: number): boolean {
  const before = clause.slice(0, index);
  const match = NEGATION_TAIL.exec(before);
  if (match === null) return false;
  const words = match[2]!.trim().split(/\s+/).filter((word) => word !== "");
  if (words.some((word) => SCOPE_BREAKERS.has(word.toLowerCase()))) return false;
  // "whether or not to delete", "if not delete": not a negation of the action.
  const lead = before.slice(0, match.index).trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  if (lead === "or" || lead === "if" || lead === "whether") return false;
  return true;
}

function liveHits(clause: string, pattern: RegExp): RegExpMatchArray[] {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  return [...clause.matchAll(global)].filter((hit) => !negatedAt(clause, hit.index!));
}

const ALWAYS_IRREVERSIBLE: Array<[RegExp, string]> = [
  [/\b(?:delet\w*|remov\w* (?:the |all )?(?:data|users?|records?|accounts?|backups?)|drop(?:s|ped|ping)?\s+(?:the\s+|a\s+|this\s+|that\s+)?(?:[\w-]+\s+)?(?:tables?|databases?|dbs?|columns?|schemas?|collections?|indexes|buckets?)|truncat\w*|wip(?:e|es|ed|ing)\b|destroy\w*|purg\w*|irreversib\w*|destructive|migrat\w*\s+(?:on\s+|the\s+)?(?:prod|production|real|live))/i, "data loss"],
  [/(?:\bforce[- ]?push\w*|\bpush\w*\s+(?:\S+\s+){0,3}?(?:--force\S*|-f)(?=\s|$)|--force-with-lease|\brewrit\w*\s+(?:the\s+)?(?:git\s+)?history|\breset\s+--hard)/i, "force-push / history rewrite"],
  [/\b(?:secrets?|credentials?|passwords?|api[- ]?keys?|private[- ]keys?|(?:access|auth|api|bearer|refresh|github|vikunja|personal)\s+tokens?)\b/i, "secrets"],
  [/\b(?:send\w*\s+(?:an?\s+|the\s+|out\s+)?(?:e-?mails?|messages?|sms|texts?|newsletters?|notifications?|dms?|invites?|invitations?)|e-?mail\w*\s+(?:the\s+|to\s+|all\s+)?(?:users|customers|people|denis|subscribers|everyone)|tweet\w*|announc\w*|post\w*\s+(?:it\s+|this\s+)?(?:to|on)\s+(?:twitter|x|slack|social|linkedin|reddit|discord|mastodon|hacker\s+news|product\s+hunt))\b/i, "external message"],
];
/** A test send to a local device is not an external message. */
const LOCAL_SEND = /\b(?:emulator|simulator|test\s+device|my\s+(?:own\s+)?device|localhost|sandbox)\b/i;

const NOUN_GUARD = String.raw`(?<!\b(?:the|a|an|this|that|these|those|any|each|dns|cert|certificate|ssl|tls)\s)`;
const MUTATING = new RegExp(
  NOUN_GUARD +
    String.raw`\b(?:chang(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|modif(?:y|ies|ied|ying)|edit(?:s|ed|ing)?|add(?:s|ed|ing)?|creat(?:e|es|ed|ing)|set(?:s|ting)?(?:\s+up)?|re-?point\w*|point(?:s|ed|ing)?\s+(?!to\b|at\b)[\w.-]+(?:\s+[\w.-]+)?\s+(?:at|to)|switch(?:es|ed|ing)?|mov(?:e|es|ed|ing)|migrat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|transfer(?:s|red|ring)?|configur(?:e|es|ed|ing)|register(?:s|ed|ing)?|flip(?:s|ped|ping)?|replac(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|disabl(?:e|es|ed|ing)|appl(?:y|ies|ied|ying)|overrid(?:e|es|ing)|overrode|toggl(?:e|es|ed|ing)|reset(?:s|ting)?|cut(?:ting)?\s+over|rotat(?:e|es|ed|ing)|issu(?:e|es|ed|ing)|revok(?:e|es|ed|ing)|renew(?:s|ed|ing)?|install(?:s|ed|ing)?|generat(?:e|es|ed|ing)|request(?:s|ed|ing)?|upload(?:s|ed|ing)?|import(?:s|ed|ing)?|deploy(?:s|ed|ing)?|publish(?:es|ed|ing)?|push(?:es|ed|ing)?)\b`,
  "i",
);
/** "is configured", "be changed": describes a state, not an action to take. */
const PASSIVE_LEAD = /\b(?:is|are|was|were|been|be|get|gets|got)\s+(?:\w+\s+)?$/i;
const READ_CUE =
  /\b(?:check\w*|inspect\w*|look(?:s|ed|ing)?\s+(?:up|at)|lookup|read(?:s|ing)?|view\w*|list\w*|query\w*|dig|nslookup|whois|resolv\w*|verif\w*|confirm\w*|see|show\w*|audit\w*|monitor\w*|test\w*|validat\w*|examin\w*|review\w*|compar\w*|diagnos\w*|debug\w*|investigat\w*|propagat\w*|expir\w*|what|which|where|why|when|how|does|is|are|status)\b/i;

function mutates(clause: string): boolean {
  return liveHits(clause, MUTATING).some((hit) => !PASSIVE_LEAD.test(clause.slice(0, hit.index!)));
}

const DNS_TOPIC = /\b(?:dns|nameservers?|name\s+servers?|cname|aaaa|mx\s+records?|txt\s+records?|zone\s+files?|domain\s+records?)\b/i;
const DNS_RECORD_TYPE = /\b(?:A|AAAA|CNAME|MX|TXT|NS|SRV|CAA)\s+records?\b/; // case-sensitive: "a record" is not DNS
const CERT_TOPIC =
  /\b(?:certificates?|certs?|keystores?|provisioning\s+profiles?|signing\s+(?:keys?|certificates?|identit(?:y|ies)|configs?)|ssl|tls|csr|let'?s\s*encrypt|acme|certbot)\b/i;
const LOCAL_CERT = /\b(?:local(?:host)?|dev(?:elopment)?|debug|self-?signed|test(?:ing)?|emulator|simulator)\b/i;
const PROD_MENTION = /\b(?:prod(?:uction)?|live|release|play\s+store|app\s+store|testflight|vps|public)\b/i;

const SPEND_VERB =
  /\b(?:pay(?:s|ing)?|paid|purchas(?:e|es|ed|ing)|buy(?:s|ing)?|bought|subscrib(?:e|es|ed|ing)|spend(?:s|ing)?|spent|charg(?:e|es|ed|ing)\s+(?:the\s+|my\s+|a\s+|our\s+|his\s+|her\s+)?(?:card|credit\s+card|account)|top\s+up|upgrad(?:e|es|ed|ing)\s+(?:\S+\s+){0,3}?(?:to\s+)?(?:a\s+)?(?:paid|pro|premium|business|team|plus)\b)/i;
const SPEND_NOUN = /\b(?:payments?|billing|invoic(?:e|es)|subscriptions?|credit\s+cards?|pricing\s+plans?)\b/i;
/** Product/code nouns: "purchase flow", "billing page", "paying users". */
const CODE_NOUN =
  /^\s*(?:[\w-]+\s+)?(?:flows?|pages?|screens?|buttons?|forms?|apis?|sdks?|endpoints?|tests?|logic|ui|components?|modules?|webhooks?|integrations?|history|receipts?|validation|handlers?|models?|tables?|dialogs?|sheets?|users?|customers?|members?|plans?|tiers?|features?|wall|status|state|methods?|providers?|gateway|intents?|events?|code|schema|ux|copy|mocks?|stubs?|sandbox)\b/i;
const SPEND_RESOURCE = /^\s*(?:(?:more|less|some|a\s+lot\s+of|extra|an?|the|much|any|\d+)\s+)?(?:time|hours?|minutes?|days?|weeks?|effort|while|cycles|energy|attention)\b/i;
const ESTIMATE_CUE = /\b(?:estimat\w*|how\s+much|costs?|pric(?:e|es|ing)|quot(?:e|es)|budget\w*|forecast\w*|calculat\w*|compar\w*|projected)\b/i;
const PERMISSION_CUE = /\b(?:should|can|could|may|ok(?:ay)?\s+to|go\s+ahead|proceed|approv\w*|authori[sz]\w*|and|then|let\s+me|i'?ll|we'?ll)\b/i;

function spendVerdict(clause: string): "irreversible" | "routine" | null {
  let routine = false;
  for (const hit of liveHits(clause, SPEND_VERB)) {
    const after = clause.slice(hit.index! + hit[0].length);
    if (/^spen[dt]/i.test(hit[0]) && SPEND_RESOURCE.test(after)) { routine = true; continue; }
    if (CODE_NOUN.test(after) && !/^(?:spen|top|upgrad|charg)/i.test(hit[0])) { routine = true; continue; }
    const before = clause.slice(0, hit.index!);
    const estimate = [...before.matchAll(new RegExp(ESTIMATE_CUE.source, "gi"))].pop();
    if (estimate !== undefined && !PERMISSION_CUE.test(before.slice(estimate.index! + estimate[0].length))) {
      routine = true;
      continue;
    }
    return "irreversible";
  }
  for (const hit of liveHits(clause, SPEND_NOUN)) {
    const after = clause.slice(hit.index! + hit[0].length);
    if (CODE_NOUN.test(after)) { routine = true; continue; }
    if (mutates(clause)) return "irreversible";
    if (READ_CUE.test(clause) || ESTIMATE_CUE.test(clause)) { routine = true; continue; }
    return "irreversible"; // ambiguous money question
  }
  return routine ? "routine" : null;
}

function infraVerdict(clause: string, dns: boolean): "irreversible" | "routine" | null {
  const mentioned = dns
    ? liveHits(clause, DNS_TOPIC).length > 0 || liveHits(clause, DNS_RECORD_TYPE).length > 0
    : liveHits(clause, CERT_TOPIC).length > 0;
  if (!mentioned) return null;
  if (!dns && LOCAL_CERT.test(clause) && !PROD_MENTION.test(clause)) return "routine";
  if (mutates(clause)) return "irreversible";
  if (READ_CUE.test(clause)) return "routine";
  return "irreversible"; // genuinely ambiguous: escalate
}

const PROD_WORD = /\b(?:prod(?:uction)?)\b/i;
const PROD_CONFIG = /(?:\bconfig\w*|\bsettings?\b|\benv(?:ironment)?\s+var\w*|\.env\b|\bfeature\s+flags?|\bflags?\b|\bvariables?\b)/i;
/** Push / deploy / production topics: allowed only when the task asked for
 * them. Feature nouns are not deploys: "push notifications", "release
 * build/APK/variant/notes", "deployment docs" stay routine. */
const DEPLOY_TOPIC =
  /\b(re-?deploy(?:s|ed|ing)?|deploy(?:s|ed|ing)?\b(?!\s+(?:script|docs?|documentation)\b)|push(?:es|ed|ing)?\b(?!\s+(?:notifications?|messages?|tokens?|providers?|services?|payloads?)\b)|publish\w*|releas(?:e|es|ed|ing)\b(?!\s+(?:builds?|variants?|apks?|aabs?|notes|mode|config\w*|signing|types?)\b)|prod|production|go(?:es|ing)? live|app store|play store|testflight)\b/i;
const LOCAL_TARGET = /\b(?:emulator|simulator|localhost|local\s+(?:main|branch|repo\w*|checkout|worktree))\b/i;

export type QuestionClass = "routine" | "irreversible" | "deploy-allowed";

export interface QuestionTriage {
  class: QuestionClass;
  reason: string;
}

/** Decide how a worker question is handled, with the rule that decided it. */
export function triageQuestion(question: string, deployRequested: boolean, declared?: DecisionKind): QuestionTriage {
  const text = String(question ?? "").replace(/[’‘]/g, "'").replace(/[*_`]/g, "");
  const clauses = text.split(CLAUSE_SPLIT).map((clause) => clause?.trim() ?? "").filter((clause) => clause !== "");
  let deploy = false;
  for (const clause of clauses) {
    for (const [pattern, reason] of ALWAYS_IRREVERSIBLE) {
      if (reason === "external message" && LOCAL_SEND.test(clause)) continue;
      if (liveHits(clause, pattern).length > 0) return { class: "irreversible", reason };
    }
    if (infraVerdict(clause, true) === "irreversible") return { class: "irreversible", reason: "DNS change" };
    if (infraVerdict(clause, false) === "irreversible") return { class: "irreversible", reason: "certificate/signing change" };
    if (spendVerdict(clause) === "irreversible") return { class: "irreversible", reason: "spending money" };
    if (liveHits(clause, PROD_WORD).length > 0 && PROD_CONFIG.test(clause) && mutates(clause)) {
      return { class: "irreversible", reason: "production config change" };
    }
    if (!LOCAL_TARGET.test(clause)) {
      const hits = liveHits(clause, DEPLOY_TOPIC);
      const onlyProdNoun = hits.length > 0 && hits.every((hit) => /^prod(?:uction)?$/i.test(hit[0]));
      // "check the prod logs": reading production is routine; acting on it is a deploy question.
      if (hits.length > 0 && !(onlyProdNoun && !mutates(clause) && READ_CUE.test(clause))) deploy = true;
    }
  }
  if (deploy) {
    return deployRequested
      ? { class: "deploy-allowed", reason: "deploy/push requested by the task" }
      : { class: "irreversible", reason: "deploy/push not requested by the task" };
  }
  if (declared === "irreversible") return { class: "irreversible", reason: "declared irreversible by the worker" };
  return { class: "routine", reason: "no irreversible action" };
}

/** Decide how a worker question is handled. Irreversible questions bypass the
 * keyword policies and never time out into "best judgment". */
export function classifyQuestion(question: string, deployRequested: boolean, declared?: DecisionKind): QuestionClass {
  return triageQuestion(question, deployRequested, declared).class;
}

export const FINISHED_WORKFLOW_STATUSES = ["merged-to-main", "delivered"] as const;

/** Whether a feature task may close: the workflow merged to local main, and
 * delivered (pushed/deployed) too when the task asked for that. */
export function featureDoneAllowed(status: string | null, deployRequested: boolean): boolean {
  if (status === null) return false;
  if (deployRequested) return status === "delivered";
  return (FINISHED_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

// ---- kanban columns ------------------------------------------------------------

/** Board columns the chief of staff moves cards through. */
export type BoardColumn = "doing" | "testing" | "done";

export interface BucketInfo {
  id: number;
  title: string;
  position: number;
}

/** Buckets from the vikunja `buckets` RPC: Vikunja's v2 API returns a
 * paginated envelope ({items, page, total_pages}); older shapes were a bare
 * array. Accept both, drop malformed entries, sort by position. */
export function parseBuckets(raw: unknown): BucketInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" && raw !== null && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  return list
    .filter((entry): entry is { id: number; title: string; position?: unknown } =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as { id?: unknown }).id === "number" &&
      typeof (entry as { title?: unknown }).title === "string")
    .map((entry) => ({ id: entry.id, title: entry.title, position: typeof entry.position === "number" ? entry.position : 0 }))
    .sort((a, b) => a.position - b.position);
}

const COLUMN_TITLES: Record<BoardColumn, RegExp> = {
  doing: /^(doing|in[ -]?progress|wip|working|started)$/i,
  testing: /^(testing|test|tests|qa|in[ -]?review|review|verify|verifying|verification)$/i,
  done: /^(done|finished|complete|completed|closed)$/i,
};

/** The bucket for a column, looked up by name (case-insensitive). Testing
 * falls back to Doing when a board has no testing column; Done falls back to
 * the view's configured done bucket. */
export function bucketForColumn(
  buckets: BucketInfo[],
  column: BoardColumn,
  doneBucketId: number | null = null,
): { bucket: BucketInfo; column: BoardColumn } | null {
  const byName = (wanted: BoardColumn) => buckets.find((bucket) => COLUMN_TITLES[wanted].test(bucket.title.trim()));
  const direct = byName(column);
  if (direct !== undefined) return { bucket: direct, column };
  if (column === "testing") {
    const doing = byName("doing");
    return doing === undefined ? null : { bucket: doing, column: "doing" };
  }
  if (column === "done" && doneBucketId !== null) {
    const configured = buckets.find((bucket) => bucket.id === doneBucketId);
    if (configured !== undefined) return { bucket: configured, column: "done" };
  }
  return null;
}

/** Column for a workflow phase or a worker-reported phase. Spec / Contract /
 * Approval / Build / repair are "doing"; Verify, the Merge checks and Deliver
 * are "testing". Unknown phases return null (no move). */
export function columnForPhase(phase: string | null | undefined): BoardColumn | null {
  const value = String(phase ?? "").trim().toLowerCase();
  if (value === "") return null;
  if (/^(verify|verifying|verification|review|reviewing|testing|test|tests|qa|merge|merging|deliver|delivering|delivery)\b/.test(value)) return "testing";
  if (/^(queue|queued|spec|contract|approval|approve|build|building|repair|repairing|fixing|implement\w*|started|working|doing)\b/.test(value)) return "doing";
  return null;
}

const NOTE_PHASE = /\bphase\b\s*[:=]?\s*["'`*]*(queue|spec|contract|approval|build|verify|merge|deliver)\b/i;

/** A workflow phase named in a driver's progress note ("phase: Verify"). */
export function phaseFromNote(note: string | null | undefined): string | null {
  const match = NOTE_PHASE.exec(String(note ?? ""));
  return match === null ? null : match[1]!;
}

/** Current phase of the latest workflow run found anywhere in a thread
 * timeline payload (rows with workKind "workflow" carry agents with
 * phaseTitle/state). Running agents win; otherwise the latest started one. */
export function workflowPhaseFromTimeline(payload: unknown): string | null {
  const workflows: Array<{ agents: Array<Record<string, unknown>> }> = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const workflow = record.workflow as { agents?: unknown } | null | undefined;
    if ((record.workKind === "workflow" || record.kind === "work") && workflow && Array.isArray(workflow.agents)) {
      workflows.push({ agents: workflow.agents.filter((agent): agent is Record<string, unknown> => typeof agent === "object" && agent !== null) });
    }
    for (const key of Object.keys(record)) visit(record[key], depth + 1);
  };
  visit(payload, 0);
  if (workflows.length === 0) return null;
  const stamp = (agent: Record<string, unknown>) =>
    typeof agent.startedAt === "number" ? agent.startedAt : typeof agent.queuedAt === "number" ? agent.queuedAt : 0;
  const agents = workflows.flatMap((workflow) => workflow.agents).filter((agent) => typeof agent.phaseTitle === "string");
  if (agents.length === 0) return null;
  const running = agents.filter((agent) => agent.state === "running").sort((a, b) => stamp(b) - stamp(a));
  const pick = running[0] ?? [...agents].sort((a, b) => stamp(b) - stamp(a) || Number(b.index ?? 0) - Number(a.index ?? 0))[0]!;
  const label = typeof pick.label === "string" ? pick.label : "";
  // Repairs run under the Build phase; verify/review agents under Verify.
  if (/^repair:/i.test(label)) return "repair";
  return pick.phaseTitle as string;
}

export interface WorkerPlan {
  mode: TaskMode;
  feature: string | null;
  deployRequested: boolean;
  workflowName: string;
}

function deployRule(plan: WorkerPlan): string {
  return plan.deployRequested
    ? "- Push/deploy: this task EXPLICITLY asks for a push/deploy/release, so it is allowed — but only after everything is merged to local main and all tests pass. Push with a plain `git push origin main` (never force) and use the documented deploy procedure for the affected area only."
    : "- Push/deploy: this task does NOT ask for a push, deploy, or release, so do none of them. If you believe one is needed, ask with chief_of_staff_ask (kind \"irreversible\") and wait.";
}

const REVERSIBILITY_RULES = [
  "- Reversible work needs no approval: code, docs, tests, local commits, and merging into LOCAL main once everything passes. Do it without asking.",
  "- Irreversible or high-impact actions need Denis first: deleting data, destructive migrations on real data, secrets/credential changes, anything paid, external messages (email, chat, social), and anything touching production the task did not ask for. Ask with chief_of_staff_ask (kind \"irreversible\"), wait for the answer, and never proceed without an explicit yes — a dismissed or withdrawn irreversible question means NO.",
];

/** Rules shared by the first prompt and the hand-off message for adopted threads. */
export function operatingRules(plan: WorkerPlan): string[] {
  const common = [
    ...REVERSIBILITY_RULES,
    deployRule(plan),
    '- Report with chief_of_staff_report: "started" when you begin, "progress" with a short note after each meaningful step, "done" only when finished, "failed" if you cannot finish, "blocked" when you cannot proceed.',
    "- Ask routine questions with chief_of_staff_ask only when genuinely blocked; if a ROUTINE question errors or times out, proceed with your best judgment and note it in your final report.",
    "- Follow AGENTS.md (repo root and the area you touch). No tm/bd/br task tracker exists here; never push --force, use --no-verify, or rewrite history.",
  ];
  if (plan.mode === "feature") {
    return [
      `- This is a FEATURE: it ships through the \`${plan.workflowName}\` bb workflow, not by hand. Do not write app code, create branches, merge, or push yourself; the workflow owns spec, build, verify, merge to local main${plan.deployRequested ? ", and delivery (push/deploy)" : ""}.`,
      ...common,
      `- "done" is accepted only after the workflow returns status ${plan.deployRequested ? '"delivered"' : '"merged-to-main"'}; pass workflowRunId and workflowStatus in the report.`,
    ];
  }
  return [
    '- Kanban: report "progress" with phase "verifying" when the change is written and you are running the tests/review, and phase "building" if that sends you back to fixing; the card moves Doing → Testing → Done with it.',
    "- Work in this thread's own bb worktree branch; never edit, stash, or commit in the shared main checkout (the first entry of `git worktree list --porcelain`).",
    "- When make test-<app> and make lint are green, merge your branch into local main: `git -C <main checkout> merge --no-ff <branch>`, only if that checkout is on main and the merge touches no locally modified file; otherwise report blocked.",
    ...common,
  ];
}

// ---- dependency layers -----------------------------------------------------------
// Mirrors the rateyourfood feature-delivery `// <dep-classify>` block and
// .bb/workflows/README.md "Three dependency layers" (keep them in sync):
//   * hard (Depends-on): sequences work. The task is not dispatched until every
//     listed feature is merged to main (its CoS task finished, or git shows
//     feature/<slug> merged / a `feature: <slug>` commit on main).
//   * resource (Resources): serializes only on a shared resource (the Android
//     emulator + SDK/Gradle, the iOS simulator) with the active feature runs.
//   * soft (Soft-after): recorded and shown, never blocks.
// Explicit `Depends-on:` / `Resources:` / `Soft-after:` / `Tags:` lines win. Otherwise:
// Android/mobile/e2e/emulator/device work needs the emulator + android-sdk-gradle;
// mechanical / applicationId-only / identity-only / rename-only Android (Tags or
// rename-only brief) needs android-sdk-gradle only — do NOT infer the emulator;
// backend, admin-web and landing need nothing; anything asserting tunnel traffic
// hard-depends on the #12 harness (android-e2e-loop). A client's dependency on
// the ticket that adds its API cannot be guessed reliably: write Depends-on.

export const TUNNEL_HARNESS = "android-e2e-loop";

export interface TaskDeps {
  dependsOn: string[];
  resources: string[];
  softAfter: string[];
  /** How each layer was decided ("explicit" line or the inference rule). */
  source: { dependsOn: string; resources: string; softAfter: string };
}

function depSlugs(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, " ")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/[*_`.]+$/g, ""))
    .filter((entry) => entry !== "" && entry !== "none" && entry !== "-" && !/^#\d+$/.test(entry) && /^[a-z0-9][a-z0-9-]*$/.test(entry));
}

function depLine(text: string, key: string): string | null {
  const match = new RegExp("^[\\s>*_`#-]*" + key + "[*_`]*\\s*:[*_`]*[ \\t]*(.*)$", "im").exec(text);
  return match === null ? null : match[1]!;
}

const unique = (values: string[]) => values.filter((value, index) => values.indexOf(value) === index);

/** Mechanical / identity-only Android: rename applicationId/namespace/package, no UX change.
 *  Mirrors feature-delivery MECHANICAL_TAGS + isMechanicalAndroidSignal. When true, CoS must NOT
 *  infer the emulator — `android-sdk-gradle` alone is enough (unit/lint/assemble smoke). */
const MECHANICAL_TAGS = ["mechanical", "applicationid-only", "identity-only", "rename-only", "no-ux"];

function isMechanicalAndroidSignal(text: string): boolean {
  const t = String(text || "");
  if (MECHANICAL_TAGS.some((tag) => new RegExp("(^|[^a-z0-9-])" + tag.replace(/-/g, "[-_]?") + "([^a-z0-9-]|$)", "i").test(t))) {
    return true;
  }
  if (/\b(mechanical|identity[- _]?only|rename[- _]?only|applicationid[- _]?only|no[- _]?ux)\b/i.test(t)) return true;
  if (/\b(application\s*id|applicationid|package(?:\s*name)?|namespace)\b[^.\n]{0,100}\b(rename|renaming|only)\b/i.test(t)) return true;
  if (/\b(rename|renaming)\b[^.\n]{0,100}\b(application\s*id|applicationid|package(?:\s*name)?|namespace)\b/i.test(t)) return true;
  if (/\bno\s+(?:ux|ui|user[- ]facing|behavior|behaviour)\s+change/i.test(t)) return true;
  return false;
}

/** The three dependency layers of a task (explicit lines first, then conservative inference). */
const DEP_LINES = /^[\s>*_`#-]*(depends[- ]on|resources|soft[- ]after|tags)[*_`]*\s*:.*$/gim;

export function classifyDependencies(
  task: Pick<VikunjaTask, "title" | "description">,
  feature: string | null,
): TaskDeps {
  const text = `${task.title}\n\n${plainDescription(task.description)}`;
  const self = feature ?? "";
  const source = { dependsOn: "", resources: "", softAfter: "" };
  // Inference never reads the dependency / Tags lines themselves ("Soft-after:
  // android-e2e-loop" does not make a backend task need the emulator; "Tags: mechanical"
  // is read via briefTags below, not as prose).
  const prose = text.replace(DEP_LINES, "");
  const tagsLine = depLine(text, "tags");
  const tags = tagsLine === null ? [] : depSlugs(tagsLine);
  const mechanical =
    tags.some((t) => MECHANICAL_TAGS.indexOf(t) !== -1) || isMechanicalAndroidSignal(prose);
  let resources: string[];
  const resourceLine = depLine(text, "resources");
  if (resourceLine !== null) {
    resources = depSlugs(resourceLine);
    source.resources = "explicit Resources line";
  } else if (
    mechanical &&
    /\b(android|mobile|application\s*id|applicationid|package|namespace)\b/i.test(prose + " " + tags.join(" "))
  ) {
    resources = ["android-sdk-gradle"];
    source.resources = "inferred: mechanical/rename android needs android-sdk-gradle only (no emulator)";
  } else if (/\b(android|ios|mobile|e2e|emulator|simulator|device)\b/i.test(prose)) {
    resources =
      /\b(ios|simulator)\b/i.test(prose) && !/\b(android|emulator)\b/i.test(prose)
        ? ["ios-simulator"]
        : ["emulator", "android-sdk-gradle", ...(/\bios\b/i.test(prose) ? ["ios-simulator"] : [])];
    source.resources = "inferred: mobile/e2e work needs the emulator";
  } else {
    resources = [];
    source.resources = "inferred: backend/web work needs no shared resource";
  }
  const dependsLine = depLine(text, "depends[- ]on");
  let dependsOn = dependsLine === null ? [] : depSlugs(dependsLine);
  source.dependsOn = dependsLine === null ? "inferred: none" : "explicit Depends-on line";
  if (
    self !== TUNNEL_HARNESS &&
    !dependsOn.includes(TUNNEL_HARNESS) &&
    /\b(assert|verif|prove|check|measur)\w*\b[^.\n]{0,60}\btunnel|\btunnel(?:led)?[- ](traffic|e2e|assert)/i.test(prose)
  ) {
    dependsOn = [...dependsOn, TUNNEL_HARNESS];
    source.dependsOn += " + inferred: asserts tunnel traffic, needs the #12 harness";
  }
  const softLine = depLine(text, "soft[- ]after");
  const softAfter = softLine === null ? [] : depSlugs(softLine);
  source.softAfter = softLine === null ? "none" : "explicit Soft-after line";
  return {
    dependsOn: unique(dependsOn.filter((slug) => slug !== self)),
    resources: unique(resources),
    softAfter: unique(softAfter.filter((slug) => slug !== self)),
    source,
  };
}

/** "hard: a, b · resources: emulator · soft: none" */
export function describeDeps(deps: TaskDeps): string {
  const list = (values: string[]) => (values.length === 0 ? "none" : values.join(", "));
  return `hard: ${list(deps.dependsOn)} · resources: ${list(deps.resources)} · soft: ${list(deps.softAfter)}`;
}

export interface ActiveFeatureRun {
  taskId: number;
  feature: string | null;
  resources: string[];
}

export interface SchedulingInput {
  deps: TaskDeps;
  /** Feature tasks currently driving a workflow run. */
  active: ActiveFeatureRun[];
  maxFeatureRuns: number;
  /** True when the hard dependency is merged to main. */
  depDone: (slug: string) => boolean;
  /** The CoS task that delivers a feature slug, when known. */
  taskForFeature?: (slug: string) => number | null;
}

export interface SchedulingDecision {
  eligible: boolean;
  layer: "hard" | "resource" | "cap" | null;
  reason: string | null;
}

/** Whether a feature task may start now: hard deps merged, its shared
 * resources free, and a feature-run slot under the cap. Soft deps never block. */
export function schedulingDecision(input: SchedulingInput): SchedulingDecision {
  const unmet = input.deps.dependsOn.filter((slug) => !input.depDone(slug));
  if (unmet.length > 0) {
    const named = unmet.map((slug) => {
      const id = input.taskForFeature?.(slug) ?? null;
      return id === null ? slug : `${slug} (#${id})`;
    });
    return { eligible: false, layer: "hard", reason: `hard dependency: waiting for ${named.join(", ")} to merge to main` };
  }
  for (const resource of input.deps.resources) {
    const holder = input.active.find((run) => run.resources.includes(resource));
    if (holder !== undefined) {
      return {
        eligible: false,
        layer: "resource",
        reason: `resource: ${resource} is in use by #${holder.taskId}${holder.feature === null ? "" : ` (${holder.feature})`}`,
      };
    }
  }
  if (input.active.length >= input.maxFeatureRuns) {
    return {
      eligible: false,
      layer: "cap",
      reason: `waiting for a feature-delivery slot (${input.active.length}/${input.maxFeatureRuns})`,
    };
  }
  return { eligible: true, layer: null, reason: null };
}

/** The workflow args for a feature task, frozen at dispatch so --resume replays. */
export function featureArgs(task: Pick<VikunjaTask, "id" | "title" | "description">, meta: Pick<TaskMeta, "feature" | "deployRequested">): Record<string, unknown> {
  const detail = plainDescription(task.description);
  const feature = meta.feature ?? slugFeature(task.title);
  const deps = classifyDependencies(task, feature);
  return {
    feature,
    brief: `${task.title}\n\n${detail === "" ? "(no description — work from the title)" : detail}`.slice(0, 20000),
    deployRequested: meta.deployRequested,
    vikunjaTask: task.id,
    dependsOn: deps.dependsOn,
    resources: deps.resources,
    softAfter: deps.softAfter,
  };
}

/** The prompt a worker thread starts its first turn with. */
export function buildWorkerPrompt(
  task: Pick<VikunjaTask, "id" | "title" | "description">,
  plan: WorkerPlan = { mode: "task", feature: null, deployRequested: false, workflowName: "feature-delivery" },
): string {
  const detail = plainDescription(task.description);
  const brief = detail === "" ? "(the task has no description — work from the title)" : detail;
  const header = [
    "You are working one Vikunja task for the user, supervised by the Chief of Staff plugin.",
    "",
    `Task #${task.id}: ${task.title}`,
    "Description:",
    brief,
    "",
  ];
  if (plan.mode === "feature") {
    const argsFile = `/tmp/cos-task-${task.id}-args.json`;
    const args = JSON.stringify(featureArgs(task, plan));
    return [
      ...header,
      `You are the DRIVER for feature "${plan.feature}". Steps:`,
      `1. chief_of_staff_report stage "started".`,
      `2. Freeze the workflow args ONCE (never rewrite this file, even if the Vikunja task is edited later):`,
      `   cat > ${argsFile} <<'COS_ARGS_EOF'`,
      `   ${args}`,
      `   COS_ARGS_EOF`,
      `3. From this thread's workspace root run: bb workflows run --name ${plan.workflowName} --args "$(cat ${argsFile})"`,
      `   Report "progress" with the run id (workflowRunId). The workflow notifies this thread when it finishes; check with \`bb workflows status <run-id>\` whenever you are woken or nudged, and report "progress" with the run's current phase in the phase field (Queue, Spec, Contract, Approval, Build, Verify, Merge, Deliver; "repair" when Verify sent it back to Build) — the kanban card follows it. Phase "Queue" / "queued behind <run id>" means the run waits for a lease (a shared resource such as the emulator, a free slot under the parallel-run cap, or a hard dependency merging to main): that is normal, keep waiting; never stop, restart or re-run it. Other feature runs may be active at the same time; never touch their worktrees, containers or the emulator.`,
      `4. When the run finishes, read its result (bb workflows status <run-id>; the result has status, nextAction, report):`,
      `   - nextAction "approve": the spec flagged irreversible/high-impact work. Call chief_of_staff_ask with kind "irreversible", the result's approvalReasons and report as context, options ["Approve", "Revise: <notes>", "Cancel"]. Approve → re-run with the SAME args plus "approved": true and --resume <run-id> (write ${argsFile.replace(".json", "-approved.json")} once from the frozen file with approved:true added). Revise → a new run whose brief is the frozen brief plus the notes. Cancel → report "failed" with "cancelled by Denis".`,
      `   - status "${plan.deployRequested ? "delivered" : "merged-to-main"}": report "done" with workflowRunId and workflowStatus.`,
      `   - status "queue-timeout" (nextAction "rerun"): nothing was started; start ONE fresh run with the same frozen args.`,
      `   - anything else (partial, main-merge-failed, contract-failed, deliver-failed, ...): report "blocked" with the result's report, then chief_of_staff_ask (routine) whether to start a fresh run, hand it to Denis, or cancel.`,
      "",
      "Operating rules:",
      ...operatingRules(plan),
      "",
      "Begin now.",
    ].join("\n");
  }
  return [
    ...header,
    "Operating rules:",
    "- Work autonomously toward a finished result. Make the routine calls yourself (naming, structure, tests, commits) following this repository's conventions.",
    ...operatingRules(plan),
    "- If the ask tool errors or times out on a routine question, proceed with your best judgment and note the decision in your final report.",
    "",
    "Begin now.",
  ].join("\n");
}

/** The dynamic instruction block the configure callback injects into worker sessions. */
export function workerInstructions(taskTitle: string, mode: TaskMode = "task"): string {
  return [
    "You are working a Chief of Staff task:",
    JSON.stringify(taskTitle),
    "Use chief_of_staff_report to report progress and completion, and chief_of_staff_ask only when blocked on a question you cannot decide.",
    'Reversible work (code, docs, tests, local commits, merge to LOCAL main once everything passes) needs no approval. Irreversible or high-impact actions (deleting data, destructive migrations, secrets, paid actions, external messages, production the task did not ask for) need chief_of_staff_ask with kind "irreversible" and an explicit yes — never proceed on a dismissal or timeout.',
    mode === "feature"
      ? "This is a feature task: it ships through the feature-delivery workflow; report done only with the workflow's final workflowStatus."
      : "If a routine question errors or times out, proceed with your best judgment and note it in your final report.",
  ].join("\n");
}

export function describeAnswer(
  outcome: "answered" | "dismissed" | "timeout" | "withdrawn",
  answer: string,
  kind: DecisionKind = "routine",
): string {
  if (kind === "irreversible") {
    if (outcome === "answered") return `Decision from the user (irreversible action): ${answer}`;
    return "Denis did not approve this irreversible action (the question was dismissed or withdrawn). Do NOT perform it. Continue with any reversible work and report \"blocked\" if nothing else can be done.";
  }
  if (outcome === "withdrawn") {
    return "The question was withdrawn (thread stopped or the chief of staff restarted). Proceed with your best judgment and note it in your final report.";
  }
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
  /** Feature tasks: the live workflow phase and run status (workflows plugin). */
  workflowPhase?: string | null;
  runStatus?: string | null;
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
      if (item.workflowPhase != null || item.runStatus != null) {
        parts.push(`workflow ${[item.runStatus, item.workflowPhase === null || item.workflowPhase === undefined ? null : `phase ${item.workflowPhase}`].filter(Boolean).join(", ")}`);
      }
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
