// bb-plugin-folders — folders for BB's thread list.
//
// A folder is a bb core thread section ("Later", "Slop Cop" in bb's own
// words): this plugin keeps no state of its own and adds the folder workflow
// on top — name-based lookup, file-a-thread-in-one-step, and agent tools.
// Create/rename/delete go straight to bb.sdk.threadSections; filing a thread
// is bb.sdk.threads.update with a sectionId. The sidebar's own section
// groups stay the read side, so every surface agrees without realtime glue.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The slice of a thread section row this plugin reads. */
interface FolderSection {
  id: string;
  name: string;
}

/** The slice of a thread row this plugin reads. */
interface FolderThread {
  id: string;
  title: string | null;
  titleFallback: string | null;
  sectionId: string | null;
}

const MAX_NAME_LENGTH = 80;
const PAGE_SIZE = 200;
// Counting pages every active thread; past this the counts are marked
// truncated rather than spinning forever on an unheard-of installation.
const MAX_COUNTED_THREADS = 10_000;

/**
 * Resolve a folder reference: exact id, exact name, then a unique
 * case-insensitive name match. Ambiguous case-insensitive matches are
 * reported instead of guessed, because filing a thread into the wrong
 * near-duplicate folder is hard to notice afterwards.
 */
export type FolderResolution =
  | { kind: "found"; folder: FolderSection }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: FolderSection[] };

export function resolveFolder(
  folders: readonly FolderSection[],
  ref: string,
): FolderResolution {
  const byId = folders.find((folder) => folder.id === ref);
  if (byId !== undefined) return { kind: "found", folder: byId };
  const byName = folders.find((folder) => folder.name === ref);
  if (byName !== undefined) return { kind: "found", folder: byName };
  const caseInsensitive = folders.filter(
    (folder) => folder.name.toLowerCase() === ref.toLowerCase(),
  );
  if (caseInsensitive.length === 1) {
    return { kind: "found", folder: caseInsensitive[0]! };
  }
  if (caseInsensitive.length > 1) {
    return { kind: "ambiguous", candidates: caseInsensitive };
  }
  return { kind: "missing" };
}

function parseFolderName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new PluginCliError(
      `Folder names must be 1–${MAX_NAME_LENGTH} characters`,
      { code: "invalid_folder_name" },
    );
  }
  return name;
}

function folderListHint(folders: readonly FolderSection[]): string {
  return folders.length === 0
    ? 'No folders yet; run "bb folders create <name>".'
    : `Known folders: ${folders.map((f) => `"${f.name}"`).join(", ")}.`;
}

function displayTitle(thread: FolderThread): string {
  return thread.title ?? thread.titleFallback ?? thread.id;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  function listing(signal?: AbortSignal): Promise<FolderSection[]> {
    return bb.sdk.threadSections.list({ signal });
  }

  async function requireFolder(
    ref: string,
    signal?: AbortSignal,
  ): Promise<FolderSection> {
    const folders = await listing(signal);
    const resolution = resolveFolder(folders, ref);
    if (resolution.kind === "found") return resolution.folder;
    if (resolution.kind === "ambiguous") {
      throw new PluginCliError(
        `"${ref}" matches ${resolution.candidates.length} folders: ` +
          resolution.candidates.map((f) => `"${f.name}"`).join(", "),
        {
          code: "ambiguous_folder",
          hint: "Use the exact folder name or its id.",
        },
      );
    }
    throw new PluginCliError(`No folder "${ref}"`, {
      code: "folder_not_found",
      hint: folderListHint(folders),
    });
  }

  /** Reject a name another folder already uses, even differing only by case. */
  async function assertNameAvailable(
    name: string,
    exceptId: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const folders = await listing(signal);
    const clash = folders.find(
      (folder) =>
        folder.id !== exceptId &&
        folder.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash !== undefined) {
      throw new PluginCliError(`A folder named "${clash.name}" already exists`, {
        code: "folder_exists",
        hint: folderListHint(folders),
      });
    }
  }

  async function getThread(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<FolderThread> {
    try {
      return await bb.sdk.threads.get({ threadId, signal });
    } catch {
      throw new PluginCliError(`No thread ${threadId}`, {
        code: "thread_not_found",
        hint: 'Run "bb thread list" to see thread ids.',
      });
    }
  }

  // threads.list pages; counts only need every active (non-archived,
  // non-hidden) thread once, the same population the sidebar shows.
  async function collectActiveThreads(
    signal?: AbortSignal,
  ): Promise<{ rows: FolderThread[]; truncated: boolean }> {
    const rows: FolderThread[] = [];
    for (let offset = 0; offset < MAX_COUNTED_THREADS; offset += PAGE_SIZE) {
      const page = await bb.sdk.threads.list({
        limit: PAGE_SIZE,
        offset,
        signal,
      });
      rows.push(...page);
      if (page.length < PAGE_SIZE) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }

  async function overview(signal?: AbortSignal) {
    const [folders, { rows, truncated }] = await Promise.all([
      listing(signal),
      collectActiveThreads(signal),
    ]);
    const counts = new Map<string, number>();
    let unsectioned = 0;
    for (const thread of rows) {
      if (thread.sectionId === null) unsectioned += 1;
      else {
        counts.set(thread.sectionId, (counts.get(thread.sectionId) ?? 0) + 1);
      }
    }
    return {
      folders: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        count: counts.get(folder.id) ?? 0,
      })),
      unsectioned,
      truncated,
    };
  }

  type FileResult = {
    thread: FolderThread;
    folder: FolderSection;
    created: boolean;
  };

  /**
   * The one-step folder workflow: file a thread into a folder, creating the
   * folder when missing unless the caller requires an existing one.
   */
  async function fileThread(input: {
    folderRef: string;
    threadId?: string;
    requireExisting?: boolean;
    signal?: AbortSignal;
  }): Promise<FileResult> {
    const threadId = input.threadId;
    if (threadId === undefined || threadId === "") {
      throw new PluginCliError("No thread to file", {
        code: "missing_thread",
        hint: "Pass --thread <id>, or run the command from inside a thread.",
      });
    }
    const [thread, folders] = await Promise.all([
      getThread(threadId, input.signal),
      listing(input.signal),
    ]);
    const name = parseFolderName(input.folderRef);
    const resolution = resolveFolder(folders, name);
    let folder: FolderSection;
    let created = false;
    if (resolution.kind === "ambiguous") {
      throw new PluginCliError(
        `"${name}" matches ${resolution.candidates.length} folders: ` +
          resolution.candidates.map((f) => `"${f.name}"`).join(", "),
        { code: "ambiguous_folder", hint: "Use the exact folder name or its id." },
      );
    }
    if (resolution.kind === "found") {
      folder = resolution.folder;
    } else if (input.requireExisting === true) {
      throw new PluginCliError(`No folder "${name}"`, {
        code: "folder_not_found",
        hint: folderListHint(folders),
      });
    } else {
      folder = await bb.sdk.threadSections.create({ name });
      created = true;
    }
    await bb.sdk.threads.update({ threadId, sectionId: folder.id });
    return { thread, folder, created };
  }

  const jsonOption = {
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;

  bb.cli.register(
    defineCli({
      name: "folders",
      summary: "Folders (named sections) for the thread list",
      description:
        "Folders are bb thread sections. This command creates, renames, and " +
        "deletes them and files threads into them by name; the sidebar " +
        "shows the same folders as section groups.",
      commands: {
        list: cliCommand({
          summary: "List folders with their thread counts",
          options: jsonOption,
          async run(input, ctx) {
            const data = await overview(ctx.signal);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(data) };
            }
            if (data.folders.length === 0) {
              return {
                exitCode: 0,
                stdout:
                  'No folders yet. Create one with "bb folders create <name>".',
              };
            }
            const lines = data.folders.map(
              (folder) => `${folder.name} (${folder.count})  ${folder.id}`,
            );
            lines.push(`Unsectioned: ${data.unsectioned} threads`);
            if (data.truncated) {
              lines.push(`(counts capped at ${MAX_COUNTED_THREADS} threads)`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        create: cliCommand({
          summary: "Create a folder",
          positionals: [
            {
              name: "name",
              description: "Folder name (1–80 characters)",
              required: true,
            },
          ],
          options: jsonOption,
          async run(input, ctx) {
            const name = parseFolderName(input.positionals.name!);
            await assertNameAvailable(name, null, ctx.signal);
            const folder = await bb.sdk.threadSections.create({
              name,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(folder)
                : `Created folder "${folder.name}" (${folder.id}).`,
            };
          },
        }),
        rename: cliCommand({
          summary: "Rename a folder (its threads stay filed)",
          positionals: [
            {
              name: "folder",
              description: "Folder id or name",
              required: true,
            },
            {
              name: "newName",
              description: "New folder name (1–80 characters)",
              required: true,
            },
          ],
          options: jsonOption,
          async run(input, ctx) {
            const folder = await requireFolder(
              input.positionals.folder!,
              ctx.signal,
            );
            const name = parseFolderName(input.positionals.newName!);
            await assertNameAvailable(name, folder.id, ctx.signal);
            const result = await bb.sdk.threadSections.update({
              id: folder.id,
              name,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(result)
                : `Renamed "${folder.name}" to "${result.name}" ` +
                  `(${result.id}, ${result.updatedThreadCount} threads filed).`,
            };
          },
        }),
        delete: cliCommand({
          summary: "Delete a folder; its threads return to no folder",
          positionals: [
            { name: "folder", description: "Folder id or name", required: true },
          ],
          options: jsonOption,
          async run(input, ctx) {
            const folder = await requireFolder(
              input.positionals.folder!,
              ctx.signal,
            );
            const result = await bb.sdk.threadSections.delete({
              id: folder.id,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(result)
                : `Deleted folder "${result.name}" (${result.id}); ` +
                  `${result.updatedThreadCount} threads returned to no folder.`,
            };
          },
        }),
        move: cliCommand({
          summary: "File a thread into a folder, creating it when missing",
          description:
            "Files a thread into a folder. Without --thread the command " +
            "files the thread it runs in. The folder is created when it does " +
            "not exist yet; pass --require-existing to file only into an " +
            "existing folder.",
          positionals: [
            {
              name: "folder",
              description: "Folder id or name (created when missing)",
              required: true,
            },
          ],
          options: {
            thread: {
              type: "string",
              description: "Thread id (default: the current thread)",
            },
            "require-existing": {
              type: "boolean",
              description: "Fail instead of creating a missing folder",
            },
            ...jsonOption,
          },
          async run(input, ctx) {
            const result = await fileThread({
              folderRef: input.positionals.folder!,
              threadId: input.options.thread ?? ctx.threadId,
              requireExisting: input.options["require-existing"],
              signal: ctx.signal,
            });
            const title = displayTitle(result.thread);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({
                    threadId: result.thread.id,
                    folder: { id: result.folder.id, name: result.folder.name },
                    created: result.created,
                  })
                : `Filed "${title}" (${result.thread.id}) into ` +
                  `"${result.folder.name}"${result.created ? " (folder created)" : ""}.`,
            };
          },
        }),
        remove: cliCommand({
          summary: "Take a thread out of its folder",
          aliases: ["unfile"],
          options: {
            thread: {
              type: "string",
              description: "Thread id (default: the current thread)",
            },
            ...jsonOption,
          },
          async run(input, ctx) {
            const threadId = input.options.thread ?? ctx.threadId;
            if (threadId === undefined || threadId === "") {
              throw new PluginCliError("No thread to unfile", {
                code: "missing_thread",
                hint: "Pass --thread <id>, or run the command from inside a thread.",
              });
            }
            const thread = await getThread(threadId, ctx.signal);
            if (thread.sectionId === null) {
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ threadId, folder: null })
                  : `"${displayTitle(thread)}" (${threadId}) is in no folder.`,
              };
            }
            const folders = await listing(ctx.signal);
            const folder =
              folders.find((f) => f.id === thread.sectionId) ?? null;
            await bb.sdk.threads.update({ threadId, sectionId: null });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({
                    threadId,
                    folder: folder === null ? thread.sectionId : folder.name,
                  })
                : `Removed "${displayTitle(thread)}" (${threadId}) from ` +
                  `"${folder === null ? thread.sectionId : folder.name}".`,
            };
          },
        }),
        threads: cliCommand({
          summary: "List the threads filed in a folder",
          positionals: [
            { name: "folder", description: "Folder id or name", required: true },
          ],
          options: jsonOption,
          async run(input, ctx) {
            const folder = await requireFolder(
              input.positionals.folder!,
              ctx.signal,
            );
            const rows: FolderThread[] = [];
            for (let offset = 0; ; offset += PAGE_SIZE) {
              const page = await bb.sdk.threads.list({
                sectionId: folder.id,
                limit: PAGE_SIZE,
                offset,
                signal: ctx.signal,
              });
              rows.push(...page);
              if (page.length < PAGE_SIZE) break;
            }
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  folder: { id: folder.id, name: folder.name },
                  threads: rows.map((thread) => ({
                    id: thread.id,
                    title: displayTitle(thread),
                  })),
                }),
              };
            }
            if (rows.length === 0) {
              return {
                exitCode: 0,
                stdout: `No threads in "${folder.name}".`,
              };
            }
            return {
              exitCode: 0,
              stdout: rows
                .map((thread) => `${thread.id}  ${displayTitle(thread)}`)
                .join("\n"),
            };
          },
        }),
      },
    }),
  );

  // Agent tools: the read and the one-step file. Destructive folder
  // management (rename/delete) stays CLI-only, for the user to run.
  bb.agents.registerTool({
    name: "folders_list",
    description:
      "List thread folders with their active thread counts, plus the " +
      "unsectioned count.",
    presentation: {
      label: { pending: "Listing folders", completed: "Listed folders" },
    },
    parameters: z.object({}),
    async execute(_input, ctx) {
      const data = await overview(ctx.signal);
      return JSON.stringify(data);
    },
  });

  bb.agents.registerTool({
    name: "folders_move",
    description:
      "File a thread into a named folder; the folder is created when it " +
      "does not exist. Omit threadId to file the current thread.",
    instructions:
      "Use folders_move when the user asks to organize threads into " +
      "folders or sections. Resolve folder names from folders_list; never " +
      "guess a folder id.",
    presentation: {
      label: {
        pending: "Filing a thread into a folder",
        completed: "Filed a thread into a folder",
      },
    },
    parameters: z.object({
      folder: z.string().trim().min(1).max(MAX_NAME_LENGTH),
      threadId: z
        .string()
        .regex(/^thr_[a-z0-9]+$/)
        .optional(),
    }),
    async execute(input, ctx) {
      const result = await fileThread({
        folderRef: input.folder,
        threadId: input.threadId ?? ctx.threadId,
        signal: ctx.signal,
      });
      return (
        `Filed "${displayTitle(result.thread)}" (${result.thread.id}) into ` +
        `"${result.folder.name}"${result.created ? " (folder created)" : ""}.`
      );
    },
  });
}
