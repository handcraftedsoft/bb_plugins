# Vikunja for BB

Connect BB to Vikunja's built-in MCP endpoint (Vikunja 2.7+). The plugin adds a
Vikunja sidebar page, `bb vikunja` commands, and two native agent tools:
`vikunja_tools` and `vikunja_call`.

```sh
npm install --cache /tmp/bb-npm-cache --include=dev
npm run check
npm run test --workspace bb-plugin-vikunja
bb plugin install ./plugins/bb-plugin-vikunja
```

In Settings → Plugins → Vikunja, enter your HTTPS `/api/v2/mcp` endpoint and token.
The token is a BB secret setting; it never enters the frontend bundle. Requests use
bearer authentication without redirects and have a 30-second network timeout.
Settings take effect on the next request. Docker is not needed after setup.

The sidebar supports paginated projects/tasks, creation, completion, descriptions,
links to Vikunja, local BB thread associations, and a kanban board with drag-and-drop between columns, task counts, labels, assignees,
due dates, priorities, and title/ID filtering. A move menu supports keyboard and touch.
Projects open their first kanban view by default; select All tasks for the list.
Card order comes from Vikunja; dragging changes columns rather than card order.
Board operations use REST v2 with the same token. The standard typed-tools token
may deny kanban routes: the page reports that and displays tasks instead.
Kanban requires permissions for reading a view's buckets with tasks and moving tasks
between buckets. No permissions are expanded automatically. Rich text is displayed
as plain Markdown rather than inserted as HTML. External changes appear on Refresh;
writes through this plugin notify its open pages.

Thread links are stored only in BB, at most 50 per task. They do not alter task
comments or create threads. Task and project IDs must be positive integers.
The API endpoint must use HTTPS with no URL credentials, query, or fragment.
Responses over 800 KB are rejected; use pagination. A timeout on a write may mean
it succeeded remotely: inspect before retrying. Board routes are not paginated by
Vikunja; large boards may exceed the response limit.

See [agent usage](skills/vikunja/SKILL.md) for command examples and operating constraints.
The official [MCP documentation](https://vikunja.io/help/mcp/) and
[API v2 reference](https://vikunja.io/docs/api-v2/) describe the upstream interfaces.

## Lifetime burndown

Select **Burndown** in the View menu to chart the selected project's remaining
work and total scope, from the earliest available task `updated` date through
today in your browser's timezone. The chart includes all pages of project tasks,
including completed tasks, independently of any kanban view's filters. Changing
projects keeps Burndown selected. Refresh reloads the latest counts and today's date.

Daily totals are reconstructed using `created` and `done_at` timestamps of tasks
currently visible in the project. Deleted tasks and past reopenings cannot be
reconstructed: the API supplies current task state rather than an audit history.
Missing creation dates fall back to `updated`, then today; missing completion dates
use the same fallback and are explicitly counted as estimates. The start date falls
back to the earliest creation date, then today, if no valid update date is available.
Today's point shows the current count; earlier points show end-of-day counts.

Hover over the graph or use the date slider to inspect counts. The expandable data
table provides accessible exact values. Points are retained on change dates plus the
start and today, so long lifetimes remain efficient without a sprint/date-window cap.
The loader follows server pagination (up to 200 pages), automatically reducing page
size and restarting the read when descriptions exceed the MCP response limit; a failed page or a project
above that cap produces an error rather than a partial chart. Loading is read-only.
