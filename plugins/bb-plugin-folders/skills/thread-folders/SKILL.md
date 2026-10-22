---
name: thread-folders
description: Organize BB threads into folders (named sections) with the `bb folders` CLI. Use when the user asks to create folders or sections for threads, file/move threads into folders, rename or delete folders, or list what is in a folder.
---

# Thread folders

Folders are BB's own thread sections under a friendlier workflow. The
sidebar shows the same folders as section groups; this skill's commands
manage them by name. Folders are shared BB state — every thread of the
project files into the same folders.

## Commands

| Command | Effect |
| --- | --- |
| `bb folders list [--json]` | Folders with active thread counts, plus the unsectioned count. |
| `bb folders create <name>` | Create a folder. |
| `bb folders rename <folder> <new-name>` | Rename; filed threads stay filed. `<folder>` is an id or name. |
| `bb folders delete <folder>` | Delete; its threads return to no folder. |
| `bb folders move <folder> [--thread <id>]` | File a thread into a folder, creating the folder when missing. Default thread: the current one. |
| `bb folders remove [--thread <id>]` | Take a thread out of its folder (`unfile` is an alias). |
| `bb folders threads <folder> [--json]` | List the threads filed in a folder. |

Add `--json` when the output drives code. Pass `--require-existing` to
`move` to fail instead of creating a missing folder.

## Procedure

1. Run `bb folders list` before changing anything; use the folder names
   and ids it prints. Never guess a folder id.
2. `bb folders move` resolves names case-insensitively when the match is
   unique, so `move inbox` files into the folder named `Inbox`.
3. Filing several threads is one `move` per thread; report each result.
4. Delete a folder only when the user asks; mention that its threads
   return to no folder.

## Rules

- Change folders only through `bb folders` (or the `folders_move` and
  `folders_list` agent tools). Do not edit BB's database directly.
- `folder_not_found` or `ambiguous_folder` means the reference did not
  resolve: run `bb folders list` again and use an exact name or id.
- Folder names are 1–80 characters; creation rejects a name that only
  differs in case from an existing folder's.
- Counts cover active (non-archived, non-hidden) threads, matching the
  sidebar. Archived threads keep their folder but are not counted.
- If folders do not appear in the sidebar, the thread list may be
  organized another way; the user can switch with
  `bb thread-list prefs set organizationMode manual`.
