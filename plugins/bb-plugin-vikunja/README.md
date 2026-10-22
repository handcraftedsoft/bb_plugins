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
