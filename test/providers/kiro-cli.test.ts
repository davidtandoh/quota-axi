import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKiroCliReader } from "../../src/providers/kiro-cli.js";
import { createKiroAdapter } from "../../src/providers/kiro.js";

function harness() {
  const process = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  const write = vi.spyOn(process.stdin, "write");
  const end = vi.spyOn(process.stdin, "end");
  const destroyInput = vi.spyOn(process.stdin, "destroy");
  const destroyOutput = vi.spyOn(process.stdout, "destroy");
  const spawn = vi.fn().mockReturnValue(process as unknown as ChildProcess);
  const reader = createKiroCliReader({
    spawn,
    cwd: "/synthetic/empty-workspace",
    env: { HOME: "/synthetic/home" },
  });
  const send = (message: unknown) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const initialize = () =>
    send({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: 1 },
    });
  const untouched = () => {
    expect(process.kill).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(destroyInput).not.toHaveBeenCalled();
    expect(destroyOutput).not.toHaveBeenCalled();
  };
  const closedNormally = () => {
    expect(process.kill).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(destroyInput).not.toHaveBeenCalled();
    expect(destroyOutput).not.toHaveBeenCalled();
  };
  const close = (code = 0, signal: NodeJS.Signals | null = null) => {
    process.emit("exit", code, signal);
    process.emit("close", code, signal);
  };
  return {
    process,
    write,
    spawn,
    reader,
    send,
    initialize,
    untouched,
    closedNormally,
    close,
  };
}

describe("Kiro fixed ACP exchange (mock child only)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spawns zero children for false, auth and profile-only adapter paths", async () => {
    const h = harness();
    const adapter = createKiroAdapter({
      findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
      readUsage: h.reader,
    });
    const options = { allowKeychainPrompt: false, refreshCredentials: false };
    await adapter.fetchQuota(options);
    await adapter.inspectAuth({ ...options, refreshCredentials: true });
    await adapter.fetchQuota({
      ...options,
      refreshCredentials: true,
      credentialMode: "profile-only",
    });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends exactly two correlated requests, with no credential or session request", async () => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith(
      "/synthetic/kiro-cli",
      ["acp", "--agent-engine", "v3", "--auth-method", "cli"],
      {
        cwd: "/synthetic/empty-workspace",
        env: { HOME: "/synthetic/home" },
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    h.send({ jsonrpc: "2.0", method: "synthetic/notification", params: {} });
    expect(h.write).toHaveBeenCalledTimes(1);
    h.initialize();
    const usage = {
      success: true,
      data: { planName: "synthetic £", usageBreakdowns: [] },
    };
    const bytes = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: usage }) + "\n",
    );
    const split = bytes.indexOf(Buffer.from("£")) + 1;
    h.process.stdout.write(bytes.subarray(0, split));
    h.process.stdout.write(bytes.subarray(split));
    expect(
      h.write.mock.calls.map(([line]) => JSON.parse(String(line))),
    ).toEqual([
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      },
      { jsonrpc: "2.0", id: 1, method: "_kiro/account/getUsage", params: {} },
    ]);
    h.closedNormally();
    await expect(h.reader("/synthetic/other-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.process.stdout.emit("end");
    h.close();
    await expect(result).resolves.toEqual(usage);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the total wait and retains a draining, unsignaled child until exit", async () => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    const rejection = expect(result).rejects.toThrow("kiro_usage_timed_out");
    await vi.advanceTimersByTimeAsync(10_000);
    h.initialize();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    h.process.stdout.write(Buffer.alloc(2 * 1024 * 1024));
    expect(h.process.stdout.readableLength).toBe(0);
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    h.untouched();
    h.close();
    const retry = h.reader("/synthetic/kiro-cli");
    const retryFailure = expect(retry).rejects.toThrow("kiro_usage_failed");
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.close(1);
    await retryFailure;
  });

  it("requires clean exit and stream close after a valid response", async () => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    const rejection = expect(result).rejects.toThrow("kiro_usage_failed");
    h.initialize();
    h.send({ jsonrpc: "2.0", id: 1, result: { success: true } });
    h.closedNormally();
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    h.close(1);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains ownership after clean exit until streams close", async () => {
    const h = harness();
    const settled = vi.fn();
    const result = h.reader("/synthetic/kiro-cli");
    void result.then(settled, settled);
    h.initialize();
    h.send({ jsonrpc: "2.0", id: 1, result: { success: true } });
    h.closedNormally();

    h.process.emit("exit", 0, null);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    h.process.emit("close", 0, null);
    await expect(result).resolves.toEqual({ success: true });
    expect(settled).toHaveBeenCalledExactlyOnceWith({ success: true });
  });

  it("keeps the total wait bound after a valid response", async () => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    const rejection = expect(result).rejects.toThrow("kiro_usage_timed_out");
    h.initialize();
    h.send({ jsonrpc: "2.0", id: 1, result: { success: true } });
    h.closedNormally();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    h.close();
  });

  it.each([
    ["malformed", "kiro_usage_malformed"],
    ["wrong-id", "kiro_usage_protocol_error"],
    ["rpc-error", "kiro_usage_protocol_error"],
    ["wrong-version", "kiro_usage_protocol_error"],
    ["credential-request", "kiro_usage_request_unsupported"],
    ["oversize", "kiro_usage_too_large"],
    ["child-error", "kiro_usage_failed"],
    ["stdin-error", "kiro_usage_failed"],
    ["stdout-error", "kiro_usage_failed"],
    ["stdout-end", "kiro_usage_failed"],
  ])("retains ownership and redacts %s failures", async (scenario, code) => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    const rejected = expect(result).rejects.toThrow(code);
    switch (scenario) {
      case "malformed":
        h.process.stdout.write("private raw text\n");
        break;
      case "wrong-id":
        h.send({ jsonrpc: "2.0", id: 1, result: {} });
        break;
      case "rpc-error":
        h.send({ jsonrpc: "2.0", id: 0, error: { message: "private text" } });
        break;
      case "wrong-version":
        h.send({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 2 } });
        break;
      case "credential-request":
        h.send({
          jsonrpc: "2.0",
          id: 9,
          method: "_kiro/resolveToken",
          params: {},
        });
        break;
      case "oversize":
        h.process.stdout.write(Buffer.alloc(1024 * 1024 + 1));
        break;
      case "child-error":
        h.process.emit("error", new Error("private text"));
        break;
      case "stdin-error":
        h.process.stdin.emit("error", new Error("private text"));
        break;
      case "stdout-error":
        h.process.stdout.emit("error", new Error("private text"));
        break;
      case "stdout-end":
        h.process.stdout.emit("end");
        break;
    }
    await rejected;
    expect(await result.catch((error: Error) => error.message)).not.toContain(
      "private",
    );
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledTimes(1);
    h.untouched();
    h.close(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the byte bound across chunks and both responses", async () => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    const rejected = expect(result).rejects.toThrow("kiro_usage_too_large");
    h.initialize();
    h.process.stdout.write(Buffer.alloc(512 * 1024, 32));
    h.process.stdout.write(Buffer.alloc(512 * 1024, 32));
    await rejected;
    h.untouched();
    h.close();
  });

  it("redacts synchronous spawn failures without claiming a pending child", async () => {
    const h = harness();
    h.spawn.mockImplementation(() => {
      throw new Error("private path");
    });
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_failed",
    );
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_failed",
    );
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a confirmed failed spawn only after close, without exit", async () => {
    const h = harness();
    const result = h.reader("/synthetic/kiro-cli");
    const rejected = expect(result).rejects.toThrow("kiro_usage_failed");
    h.process.emit(
      "error",
      Object.assign(new Error("private path"), {
        code: "ENOENT",
        syscall: "spawn /synthetic/kiro-cli",
      }),
    );
    await rejected;
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    h.process.emit("close", -2, null);
    h.untouched();

    const replacement = harness();
    h.spawn.mockReturnValueOnce(replacement.process as unknown as ChildProcess);
    const retry = h.reader("/synthetic/kiro-cli").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    expect(h.spawn).toHaveBeenCalledTimes(2);
    // Late events from the old child must not release its replacement.
    h.process.emit("close", -2, null);
    h.process.emit("exit", 1, null);
    await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
      "kiro_usage_pending",
    );
    replacement.initialize();
    replacement.send({ jsonrpc: "2.0", id: 1, result: { success: true } });
    replacement.closedNormally();
    replacement.close();
    await expect(retry).resolves.toEqual({ value: { success: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pid", "spawn", "data", "unknown-error", "close-only"])(
    "keeps %s ownership pending after error/close without exit",
    async (evidence) => {
      const h = harness();
      if (evidence === "pid") h.process.pid = 12345;
      const result = h.reader("/synthetic/kiro-cli");
      const rejected = expect(result).rejects.toThrow("kiro_usage_failed");
      if (evidence === "spawn") h.process.emit("spawn");
      if (evidence === "data")
        h.send({ jsonrpc: "2.0", method: "synthetic/notification" });
      if (evidence !== "close-only") {
        h.process.emit(
          "error",
          evidence === "unknown-error"
            ? new Error("private unknown error")
            : Object.assign(new Error("private path"), {
                code: "ENOENT",
                syscall: "spawn /synthetic/kiro-cli",
              }),
        );
      }
      h.process.emit("close", null, null);
      if (evidence === "close-only") await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      await expect(h.reader("/synthetic/kiro-cli")).rejects.toThrow(
        "kiro_usage_pending",
      );
      expect(h.spawn).toHaveBeenCalledTimes(1);
      h.untouched();
      h.process.emit("exit", 0, null);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
