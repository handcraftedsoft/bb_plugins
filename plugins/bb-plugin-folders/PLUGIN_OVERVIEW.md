Give every thread a home. Thread Folders adds named folders to BB's
thread list and the one-step filing BB was missing.

## What you get

- A `bb folders` command that creates, renames, and deletes folders and
  files threads into them by name — from a terminal or from an agent
  thread.
- `bb folders move <folder>`, which files the thread you are in and
  creates the folder when it does not exist yet. No ids to look up, no
  two-step dance.
- `folders_list` and `folders_move` agent tools, so an agent can file its
  own thread when you ask it to.
- Folders in the sidebar: each folder is a section group in BB's thread
  list, so the UI, the CLI, and the agents all read the same state.

## How it works

Folders are BB's own thread sections — the plugin keeps no data of its
own. Every command goes straight to BB's thread and section APIs, so a
folder renamed here is renamed everywhere, and nothing leaves the
machine.

## Good to know

- Counts cover active threads; archived threads keep their folder.
- Folder names resolve case-insensitively when the match is unique, and
  `--json` is available on every command.
- Deleting a folder returns its threads to the unsectioned list; nothing
  is deleted but the folder itself.
