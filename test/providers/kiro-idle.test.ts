import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkKiroIdle } from "../../src/providers/kiro-idle.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/** A synthetic home whose `.kiro/tasks/<group>/<file>` holds `files`. */
function home(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-kiro-idle-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, ".kiro", "tasks", path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

function meta(...statuses: (string | undefined)[]): string {
  return JSON.stringify({
    tasks: Object.fromEntries(
      statuses.map((executionStatus, index) => [
        `task-${index}`,
        { executionStatus, updatedAt: 1 },
      ]),
    ),
  });
}

const noProcesses = () => Promise.resolve(["zsh", "node", "kiro_cli_desktop"]);

describe("Kiro idle preflight", () => {
  it("is idle with no Kiro process and no task root", async () => {
    expect(
      await checkKiroIdle({ home: () => home(), listExecutables: noProcesses }),
    ).toEqual({ idle: true });
  });

  it("is idle when every task is settled or statusless", async () => {
    const root = home({
      "spec-a/tasks.meta.json": meta("succeed", undefined, "failed"),
      "spec-a/notes.md": "running",
      "spec-b/other.json": meta("running"),
      "spec-c/shape.meta.json": JSON.stringify({ tasks: [] }),
    });
    expect(
      await checkKiroIdle({ home: () => root, listExecutables: noProcesses }),
    ).toEqual({ idle: true });
  });

  it.each(["running", "queued"])(
    "blocks on a %s task in the real task root",
    async (status) => {
      const root = home({ "spec/tasks.meta.json": meta("succeed", status) });
      expect(
        await checkKiroIdle({ home: () => root, listExecutables: noProcesses }),
      ).toEqual({ idle: false, reason: "kiro_busy_task_active" });
    },
  );

  it.each(["kiro-cli", "kiro-cli-chat", "Kiro"])(
    "blocks while a %s process runs, before reading tasks",
    async (name) => {
      const readDir = vi.fn();
      expect(
        await checkKiroIdle({
          home: () => home(),
          listExecutables: () => Promise.resolve(["zsh", name]),
          readDir,
        }),
      ).toEqual({ idle: false, reason: "kiro_busy_process_active" });
      expect(readDir).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the process list is unavailable", async () => {
    expect(
      await checkKiroIdle({
        home: () => home(),
        listExecutables: () => Promise.resolve(undefined),
      }),
    ).toEqual({ idle: false, reason: "kiro_busy_unverified" });
  });

  it("fails closed on unparsable or oversized task metadata", async () => {
    const root = home({ "spec/tasks.meta.json": "{ partial" });
    expect(
      await checkKiroIdle({ home: () => root, listExecutables: noProcesses }),
    ).toEqual({ idle: false, reason: "kiro_busy_unverified" });
    expect(
      await checkKiroIdle({
        home: () => home({ "spec/tasks.meta.json": meta() }),
        listExecutables: noProcesses,
        readFile: (_path, maxBytes) =>
          Promise.resolve(Buffer.alloc(maxBytes + 1)),
      }),
    ).toEqual({ idle: false, reason: "kiro_busy_unverified" });
  });

  it("fails closed when the task root cannot be listed", async () => {
    expect(
      await checkKiroIdle({
        home: () => "/synthetic/home",
        listExecutables: noProcesses,
        readDir: () =>
          Promise.reject(
            Object.assign(new Error("denied"), { code: "EACCES" }),
          ),
      }),
    ).toEqual({ idle: false, reason: "kiro_busy_unverified" });
  });

  it("bounds how many metadata files it reads", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `spec/${index}.meta.json`,
        meta("succeed"),
      ]),
    );
    expect(
      await checkKiroIdle({
        home: () => home(files),
        listExecutables: noProcesses,
      }),
    ).toEqual({ idle: false, reason: "kiro_busy_unverified" });
  });
});
