# Handcraftedsoft BB plugins

Custom plugins for [BB](https://getbb.app), organized as an npm workspace.
Each directory under `plugins/` is an independent plugin. The collection
index is `.bb/plugins.json`.

## Setup

Install BB (with its `bb` CLI), Node.js, npm, and Git. This workspace was
initialized with BB 0.46.1 and SDK 0.6.49; the SDK pin lives in each plugin.

```sh
npm ci --include=dev
npm run check
```

`check` verifies SDK pins, typechecks, and builds every plugin. Builds use
the installed BB CLI and may download BB's build toolchain on first use.
Generated bundles live in each plugin's ignored `dist/` directory.
The starter keeps strict source checking enabled and skips checking dependency
declaration files (`skipLibCheck`).

## Starter plugin

`plugins/bb-plugin-starter/` is the official `bb plugin new starter`
scaffold: a todo list demonstrating a sidebar page, typed RPC, persistent
storage, CLI commands, settings, realtime updates, and an agent skill.
It is ready to edit and is not installed automatically.

To install it locally and start the watch/reload loop:

```sh
bb plugin install path:. --plugin starter
bb plugin dev plugins/bb-plugin-starter
```

After installation, open **Example todos** in BB or run `bb starter list`.
Use `bb plugin logs starter -f` to inspect logs. The plugin's own README
describes its files and settings.

## Create another plugin

Use BB's scaffold so the APIs and dependency pins match your installed BB:

```sh
cd plugins
bb plugin new my-plugin
cd ..
```

Then:

1. Add an entry to `.bb/plugins.json` with name `my-plugin` and source
   `./plugins/bb-plugin-my-plugin`.
2. Add the starter's `build`, `typecheck`, and `sdk:check` scripts to the
   new plugin's package.json.
3. Remove its generated package-lock.json and run `npm install --include=dev`
   from this root to update the shared workspace lockfile.
4. Implement the plugin and update its README, skill, and PLUGIN_OVERVIEW.md.
5. Run `npm run check`, then install it with
   `bb plugin install path:. --plugin my-plugin` and run
   `bb plugin dev plugins/bb-plugin-my-plugin`.

Use a unique package name and CLI command for every plugin. For a headless
plugin, remove `bb.app` and the frontend files described in the scaffold README.

After upgrading BB, run `bb plugin types plugins/bb-plugin-<name>` for each
plugin, then `npm install --include=dev` and `npm run check`.

## Distribution

Commit source and the root lockfile. Local path and Git installations build
from source; npm releases must include the generated bundles and metadata.
A Git collection install selects a plugin explicitly:

```sh
bb plugin install git:github.com/handcraftedsoft/bb_plugins@main --plugin starter
```

That command requires the plugin source to have been committed and pushed.
See [BB's Plugin Guide](https://getbb.app/plugin-guide) and the
`bb-plugin-authoring` skill for manifests, APIs, testing, and publishing.

## Vikunja

`plugins/bb-plugin-vikunja` connects directly to Vikunja's built-in MCP endpoint.
It includes a sidebar task/kanban page, native agent tools, and `bb vikunja` commands.
See its [README](plugins/bb-plugin-vikunja/README.md) for setup and token permissions.
Run `npm run test --workspace bb-plugin-vikunja` for focused client tests.

## Thread Folders

`plugins/bb-plugin-folders` adds folders (named thread sections) to BB's
thread list: a `bb folders` CLI, `folders_list`/`folders_move` agent
tools, and one-step filing that creates a missing folder. It is headless
and keeps no state of its own — folders are BB core sections, shown by
the sidebar as section groups. Install it with
`bb plugin install path:. --plugin folders`, then try
`bb folders move "Inbox"` from inside a thread.
