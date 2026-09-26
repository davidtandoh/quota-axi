import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readBoundedFile } from "../lib/fs.js";
import { currentUserProcessListArgs, execFileText } from "../lib/process.js";

/**
 * Preflight for the Kiro ACP usage read.
 *
 * Starting any Kiro V3 ACP process clears `running` and `queued` execution
 * statuses in every `<home>/.kiro/tasks/<dir>/*.meta.json` without checking
 * whether the task's owner is still alive. `KIRO_HOME` does not move that task
 * root (verified on kiro-cli 2.24.1; see docs/kiro-v3-transport-assessment.md).
 * A quota read is therefore allowed only when Kiro is idle: no Kiro process of
 * this user is running and no task metadata carries an active status.
 *
 * Fail closed: anything this check cannot prove idle blocks the read.
 */
export type KiroIdleResult =
  | { idle: true }
  | {
      idle: false;
      reason:
        | "kiro_busy_process_active"
        | "kiro_busy_task_active"
        | "kiro_busy_unverified";
    };

const PROCESS_LIST_TIMEOUT_MS = 4_000;
const MAX_META_BYTES = 4 * 1024 * 1024;
const MAX_META_FILES = 500;
const ACTIVE_STATUSES = new Set(["running", "queued"]);
/**
 * Executable names that can own Kiro tasks: the CLI launcher, its chat
 * process (which hosts the V3 engine), and the Kiro IDE. The desktop
 * companion (`kiro_cli_desktop`) and terminal integration do not run tasks.
 */
const KIRO_EXECUTABLES = new Set(["kiro-cli", "kiro-cli-chat", "Kiro"]);

type Dependencies = {
  home: () => string;
  /** Executable names of the current user's processes, or undefined. */
  listExecutables: () => Promise<string[] | undefined>;
  readDir: (path: string) => Promise<{ name: string; isDir: boolean }[]>;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export async function checkKiroIdle(
  overrides: Partial<Dependencies> = {},
): Promise<KiroIdleResult> {
  const dependencies: Dependencies = {
    home: homedir,
    listExecutables,
    readDir: async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDir: entry.isDirectory(),
      })),
    readFile: readBoundedFile,
    ...overrides,
  };

  const executables = await dependencies.listExecutables();
  if (!executables) return { idle: false, reason: "kiro_busy_unverified" };
  if (executables.some((name) => KIRO_EXECUTABLES.has(name)))
    return { idle: false, reason: "kiro_busy_process_active" };

  return scanTasks(dependencies, join(dependencies.home(), ".kiro", "tasks"));
}

async function scanTasks(
  dependencies: Dependencies,
  root: string,
): Promise<KiroIdleResult> {
  const unverified = { idle: false, reason: "kiro_busy_unverified" } as const;
  let groups: { name: string; isDir: boolean }[];
  try {
    groups = await dependencies.readDir(root);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { idle: true } : unverified;
  }
  let files = 0;
  for (const group of groups) {
    if (!group.isDir) continue;
    const dir = join(root, group.name);
    let entries: { name: string; isDir: boolean }[];
    try {
      entries = await dependencies.readDir(dir);
    } catch {
      return unverified;
    }
    for (const entry of entries) {
      if (entry.isDir || !entry.name.endsWith(".meta.json")) continue;
      if (++files > MAX_META_FILES) return unverified;
      let contents: Buffer;
      try {
        contents = await dependencies.readFile(
          join(dir, entry.name),
          MAX_META_BYTES,
        );
      } catch {
        return unverified;
      }
      if (contents.length > MAX_META_BYTES) return unverified;
      const active = hasActiveTask(contents.toString("utf8"));
      if (active === undefined) return unverified;
      if (active) return { idle: false, reason: "kiro_busy_task_active" };
    }
  }
  return { idle: true };
}

/** True or false for readable metadata; undefined when it cannot be parsed. */
function hasActiveTask(text: string): boolean | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const tasks = record(record(value)?.tasks);
  if (!tasks) return false; // Kiro itself leaves this shape untouched.
  return Object.values(tasks).some((task) => {
    const status = record(task)?.executionStatus;
    return typeof status === "string" && ACTIVE_STATUSES.has(status);
  });
}

async function listExecutables(): Promise<string[] | undefined> {
  if (process.platform === "win32") return undefined;
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) return undefined;
  try {
    const output = await execFileText(
      "ps",
      currentUserProcessListArgs(effectiveUid, "pid=,comm="),
      PROCESS_LIST_TIMEOUT_MS,
    );
    return output
      .split("\n")
      .map((line) => /^\s*\d+\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((command): command is string => command !== undefined)
      .map((command) => basename(command));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
