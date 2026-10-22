// bb-plugin-chief-of-staff — a BB plugin frontend entry.
//
// The Chief of Staff panel: latest briefing on top, then the decisions queue
// (the questions only the user can answer), then the managed Vikunja tasks
// with their worker threads, and the auto-answer policy list. The board
// refetches through one RPC call whenever the backend publishes CHANGED_CHANNEL.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DecisionView, Overview, TaskView, rpcContract } from "./server";
import { CHANGED_CHANNEL, formatAge } from "./logic";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type TaskAction = "pause" | "resume";

const STATE_ORDER: Record<TaskView["state"], number> = {
  active: 0,
  paused: 1,
  closed: 2,
};

const STATE_TONE: Record<TaskView["state"], string> = {
  active: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  paused: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  closed: "border-border bg-muted text-muted-foreground",
};

function StateBadge({ state }: { state: TaskView["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        STATE_TONE[state],
      )}
    >
      {state}
    </span>
  );
}

function SectionHeading({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold">{children}</h2>
      {hint === undefined ? null : (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("overview").then(
      (result) => {
        setOverview(result);
        setError(null);
      },
      report,
    );
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  return { rpc, overview, error, report, refetch };
}

function BriefingCard({ rpc, briefing }: { rpc: ReturnType<typeof useRpc<typeof rpcContract>>; briefing: Overview["briefing"] }) {
  const [busy, setBusy] = useState(false);
  const run = async (method: "brief_now" | "sync_now") => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call(method);
    } catch {
      // surfaced by the refetch error path
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Briefing</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run("sync_now")}>
            <Icon name="RefreshCw" className="size-3.5" />
            Sync now
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void run("brief_now")}>
            Refresh
          </Button>
        </div>
      </div>
      {briefing === null ? (
        <p className="text-sm text-muted-foreground">No briefing yet.</p>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{briefing.text}</pre>
      )}
    </Card>
  );
}

function DecisionCard({
  decision,
  rpc,
  report,
}: {
  decision: DecisionView;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  report: (cause: unknown) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [keywords, setKeywords] = useState("");
  const [busy, setBusy] = useState(false);
  const label =
    decision.taskId === null ? "unknown task" : `#${decision.taskId} ${decision.taskTitle ?? ""}`.trim();
  const submit = async (kind: "answer" | "dismiss") => {
    if (busy) return;
    if (kind === "answer" && answer.trim() === "") return;
    setBusy(true);
    try {
      if (kind === "answer") {
        await rpc.call("decision_answer", {
          id: decision.id,
          answer: answer.trim(),
          ...(keywords.trim() === "" ? {} : { rememberPolicyKeywords: keywords.trim() }),
        });
      } else {
        await rpc.call("decision_dismiss", { id: decision.id });
      }
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-decision-status={decision.status}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">{label}</p>
        <span className="shrink-0 text-xs text-muted-foreground">{formatAge(decision.askedAt, Date.now())}</span>
      </div>
      <p className="mt-1 text-sm font-medium">{decision.question}</p>
      {decision.context === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{decision.context}</p>
      )}
      {decision.options.length === 0 ? null : (
        <ul className="mt-2 space-y-1">
          {decision.options.map((option) => (
            <li key={option} className="text-xs">
              <button
                type="button"
                className="rounded-full border border-border px-2 py-0.5 hover:bg-muted"
                onClick={() => setAnswer(option)}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      )}
      {decision.status === "pending" ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            void submit("answer");
          }}
        >
          <textarea
            aria-label={`Answer for ${decision.question}`}
            className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Your answer goes straight to the worker thread"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || answer.trim() === ""}>
              Answer
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void submit("dismiss")}>
              Dismiss
            </Button>
            <Input
              className="h-8 flex-1 min-w-40 text-xs"
              aria-label={`Remember this answer for keywords (${decision.question})`}
              placeholder="Remember as policy for keywords…"
              value={keywords}
              onChange={(event) => setKeywords(event.target.value)}
            />
          </div>
        </form>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {decision.status}
          {decision.answer === null ? "" : ` — ${decision.answer}`}
          {decision.autoAnswered ? " (auto-answered by policy)" : ""}
        </p>
      )}
    </Card>
  );
}

function TaskRowView({
  task,
  rpc,
  report,
  onOpenThread,
}: {
  task: TaskView;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  report: (cause: unknown) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (action: TaskAction) => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call(action === "pause" ? "task_pause" : "task_resume", { taskId: task.taskId });
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm">
      <StateBadge state={task.state} />
      <span className="font-mono text-xs text-muted-foreground">#{task.taskId}</span>
      <span className="min-w-0 flex-1 truncate font-medium" title={task.title}>
        {task.title}
      </span>
      <span
        className="min-w-0 flex-[2] truncate text-xs text-muted-foreground"
        title={task.progressNote ?? task.error ?? undefined}
      >
        {task.stalled
          ? `stalled — nudged ${task.nudgeCount}×`
          : (task.progressNote ?? task.error ?? "")}
        {task.progressNote !== null && task.state === "active" ? ` (${formatAge(task.progressAt, Date.now())})` : ""}
        {task.threadStatus !== null && task.state === "active" ? ` · thread ${task.threadStatus}` : ""}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {task.threadId === null ? null : (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onOpenThread(task.threadId!)}>
            <Icon name="ExternalLink" className="size-3.5" />
            Thread
          </Button>
        )}
        {task.state === "active" ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void act("pause")}>
            Pause
          </Button>
        ) : null}
        {task.state === "paused" ? (
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void act("resume")}>
            Resume
          </Button>
        ) : null}
      </span>
    </li>
  );
}

function PoliciesSection({
  policies,
  rpc,
  report,
}: {
  policies: Overview["policies"];
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  report: (cause: unknown) => void;
}) {
  const [keywords, setKeywords] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || keywords.trim() === "" || answer.trim() === "") return;
    setBusy(true);
    try {
      await rpc.call("policy_add", { keywords: keywords.trim(), answer: answer.trim() });
      setKeywords("");
      setAnswer("");
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await rpc.call("policy_remove", { id });
    } catch (cause) {
      report(cause);
    }
  };
  return (
    <details className="rounded-lg border border-border bg-card px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Auto-answer policies ({policies.length})
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        A worker's question is answered instantly when any keyword appears in it. Built-in policies cover branches,
        tests, commits, dependencies, and formatting.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {policies.map((policy) => (
          <li key={policy.id} className="flex items-start gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap gap-1">
                {policy.keywords.map((keyword) => (
                  <code key={keyword} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {keyword}
                  </code>
                ))}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{policy.answer}</p>
            </div>
            {policy.source === "builtin" ? (
              <span className="shrink-0 text-xs text-muted-foreground">built-in</span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              aria-label={`Remove policy for ${policy.keywords.join(", ")}`}
              onClick={() => void remove(policy.id)}
            >
              <Icon name="Trash2" className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          className="w-48"
          aria-label="Policy keywords"
          placeholder="keywords, comma or space"
          value={keywords}
          onChange={(event) => setKeywords(event.target.value)}
        />
        <Input
          className="min-w-40 flex-1"
          aria-label="Policy answer"
          placeholder="Answer sent to the worker"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={busy || keywords.trim() === "" || answer.trim() === ""}>
          Add policy
        </Button>
      </form>
    </details>
  );
}

function ChiefPage() {
  const { rpc, overview, error, report } = useOverview();
  const navigate = useBbNavigate();
  const tasks = useMemo(() => {
    if (overview === null) return [];
    return [...overview.tasks].sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.taskId - a.taskId,
    );
  }, [overview]);
  if (overview === null) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
          {error === null ? <EmptyState>Loading your chief of staff…</EmptyState> : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    );
  }
  const pending = overview.decisions.filter((decision) => decision.status === "pending");
  const settled = overview.decisions.filter((decision) => decision.status !== "pending");
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {overview.configured ? null : (
          <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            The Vikunja plugin is not reachable or has no token configured. The chief of staff manages Vikunja
            tasks assigned to <code>{overview.assignee}</code>; nothing will run until Vikunja is configured.
          </div>
        )}
        <BriefingCard rpc={rpc} briefing={overview.briefing} />
        <section aria-label="Decisions">
          <SectionHeading hint={pending.length === 0 ? "nothing needs you" : `${pending.length} waiting`}>
            Decisions for you
          </SectionHeading>
          {pending.length === 0 ? (
            <EmptyState>No pending decisions — routine questions were answered by policy.</EmptyState>
          ) : (
            <div className="space-y-3">
              {pending.map((decision) => (
                <DecisionCard key={decision.id} decision={decision} rpc={rpc} report={report} />
              ))}
            </div>
          )}
        </section>
        <section aria-label="Tasks">
          <SectionHeading
            hint={`${overview.counts.active} active · ${overview.counts.paused} paused · ${overview.counts.closed} closed · assignee ${overview.assignee}`}
          >
            Managed Vikunja tasks
          </SectionHeading>
          {tasks.length === 0 ? (
            <EmptyState>
              No tasks assigned to <code>{overview.assignee}</code> in Vikunja yet. Assign one and press Sync now.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {tasks.map((task) => (
                <TaskRowView
                  key={task.taskId}
                  task={task}
                  rpc={rpc}
                  report={report}
                  onOpenThread={(threadId) => navigate.toThread(threadId, { split: true })}
                />
              ))}
            </ul>
          )}
        </section>
        <PoliciesSection policies={overview.policies} rpc={rpc} report={report} />
        {settled.length === 0 ? null : (
          <details className="rounded-lg border border-border bg-card px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold">Recent answers ({settled.length})</summary>
            <ul className="mt-2 divide-y divide-border">
              {settled.map((decision) => (
                <li key={decision.id} className="py-2 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {decision.taskId === null ? "" : `#${decision.taskId} `}
                    {decision.status}
                    {decision.autoAnswered ? " · policy" : ""}
                  </p>
                  <p className="mt-0.5">{decision.question}</p>
                  {decision.answer === null ? null : (
                    <p className="mt-0.5 text-xs text-muted-foreground">→ {decision.answer}</p>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "chief-of-staff",
    title: "Chief of Staff",
    icon: "Workflow",
    path: "board",
    component: ChiefPage,
  });
});
