# bb-plugin-chief-of-staff

A chief of staff for your Vikunja backlog. It watches every open task
assigned to one Vikunja user (default `CTO-bot`) and runs each through a BB
worker thread:

- **Vikunja is the backlog.** The plugin polls through the **vikunja plugin**
  (cross-plugin RPC — no second token) for open tasks assigned to the managed
  user. Everything else in Vikunja is untouched.
- **Reuse or create.** A task that already has a linked thread
  (`bb vikunja link`) is adopted — its thread gains the chief-of-staff tools
  and a hand-off message. Otherwise a new worker spawns in the configured BB
  project (`proj_jjitzuscx6`, rateyourfood), titled `#<task-id> <title>`.
- **Kanban write-back.** Dispatch moves the card to its view's *Doing*
  bucket and leaves a comment; a `done` report closes the task (Vikunja moves
  it to *Done*) with a final comment; failures are commented too.
- **Routine questions answered by policy.** Workers ask through the
  `chief_of_staff_ask` tool; keyword policies (branches, tests, commits,
  dependencies, formatting — plus your own rules) answer instantly.
- **Decisions queue for you.** What policy cannot answer parks as a decision;
  answer it in the panel (or `bb chief answer`) and it reaches the waiting
  worker.
- **Kept moving.** The monitor nudges idle workers that go quiet, auto-retries
  a failed turn once, flags genuinely stalled tasks, respects the
  concurrency budget, and notices tasks completed or unassigned in Vikunja.
- **Feature routing.** Tasks labelled `feature` (or with a `feature: <name>`
  line) are driven through the rateyourfood `feature-delivery` workflow by a
  cheap driver worker (ZCode GLM-5.3-Flash) with frozen args; one feature run
  at a time (`maxFeatureRuns`); `done` only after `merged-to-main` (or
  `delivered` when the task asked for a deploy). Plain tasks get a GLM-5.3
  implementer that merges its branch into local main when tests pass.
- **Reversible work proceeds, irreversible work waits.** Irreversible or
  high-impact questions bypass the policies, never time out, and a dismissal
  means no. Push/deploy is allowed only when the task explicitly asked for it.
- **Briefings.** A running digest — decisions pending, in flight, stalled,
  completed — in the panel and via `bb chief brief`.

Surfaces:

- `server.ts` — registration only: settings, RPC, CLI, agent tools, thread
  events, and the monitor service.
- `runtime.ts` — the orchestration (poll, adopt/spawn, nudge, retry, write-back, brief).
- `logic.ts` / `store.ts` — pure parsing/triage/briefing logic and the SQLite store.
- `app.tsx` — the **Chief of Staff** panel in the sidebar.
- `skills/chief-of-staff/SKILL.md` — tells agents how to drive `bb chief`.

## Configure

1. The **vikunja plugin** must be installed, running, and have a token — the
   chief of staff reaches Vikunja only through it.
2. Settings → Installed plugins → Chief of Staff: the managed **Vikunja
   assignee** (default `CTO-bot`) and the **BB project** for new workers
   (default `proj_jjitzuscx6`), plus concurrency/nudge/poll tuning.
3. Assign a task to `CTO-bot` in Vikunja; the next sync (or the panel's
   **Sync now**) dispatches it.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins declared packages alongside the SDK; unused packages may be removed. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.6.49`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `bb.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`bb.description` changes, so the two never disagree.

The submission to the public BB Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `bb.description` verbatim; the page
shows both directly above.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload chief-of-staff
```

Or let `bb plugin dev` rebuild and reload on every save.

## Configure

```
bb plugin config chief-of-staff
bb plugin config chief-of-staff set showDone false
bb plugin reload chief-of-staff
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.6.49` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
