# bb-plugin-folders

Folders for BB's thread list. A folder is a BB thread section (bb core
state); this plugin adds the folder workflow on top of it and keeps no
state of its own:

- `server.ts` — the backend: a `bb folders` CLI command built with
  `defineCli`, and the `folders_list` / `folders_move` agent tools.
  Create/rename/delete call `bb.sdk.threadSections`; filing a thread is
  `bb.sdk.threads.update` with a `sectionId`.
- `server.test.ts` — behavioral tests against
  `@get-bb/plugin-sdk/testing`'s fake plugin host.
- `skills/thread-folders/SKILL.md` — the skill that tells agents how to
  file threads with the command and the tools.
- `PLUGIN_OVERVIEW.md` — store listing text.

The plugin is headless: no frontend bundle, no settings, no storage, no
secrets. The sidebar's own section groups are the read side, so every
surface agrees without realtime glue.

## Commands

```
bb folders list [--json]                 folders with active thread counts
bb folders create <name>                 create a folder
bb folders rename <folder> <new-name>    rename; threads stay filed
bb folders delete <folder>               delete; threads return to no folder
bb folders move <folder> [--thread <id>] file a thread, creating the folder
                                         when missing (default: current thread)
bb folders remove [--thread <id>]        take a thread out of its folder
                                         (alias: unfile)
bb folders threads <folder> [--json]     list the threads in a folder
```

`<folder>` is an id or a name; names resolve case-insensitively when the
match is unique. `move --require-existing` fails instead of creating.

Agent tools: `folders_list` (counts as JSON) and `folders_move` (file a
thread by id, or the current thread when `threadId` is omitted).
Rename/delete are CLI-only by design — they change shared state and are
for the user to run.

## Sidebar

Folders appear as section groups in BB's thread list. If the list is
organized another way, switch it once:

```
bb thread-list prefs set organizationMode manual
```

The built-in `thread-list/move` row action also files threads from the
UI. Counts cover active (non-archived, non-hidden) threads, matching
what the sidebar shows.

## Install

From the repository root:

```
npm ci --include=dev
npm run check
bb plugin install path:. --plugin folders
```

After editing sources, `bb plugin reload folders`, or keep
`bb plugin dev plugins/bb-plugin-folders` running.

## Test

```
npm run test --workspace bb-plugin-folders
```

## Types & API reference

The plugin API ships as `@get-bb/plugin-sdk`, pinned to an exact version
in `devDependencies` (`0.6.49` — the SDK of the BB that scaffolded this
plugin). Readable declarations are at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.
After a BB upgrade, run `bb plugin types .` from this directory, then
`npm install --include=dev` and `npm run check` from the root.

Confused by the API? Clone the BB repo and read the source:
<https://github.com/get-bb/bb>.
