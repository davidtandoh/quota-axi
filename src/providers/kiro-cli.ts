import type { ChildProcess, SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const WAIT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;

type Failure =
  | "kiro_usage_pending"
  | "kiro_usage_timed_out"
  | "kiro_usage_failed"
  | "kiro_usage_malformed"
  | "kiro_usage_protocol_error"
  | "kiro_usage_request_unsupported"
  | "kiro_usage_too_large";

export class KiroCliError extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}

type Dependencies = {
  // Mandatory injection: there is no accepted native launch binding yet.
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

/** Fixed ACP exchange only. Native lifecycle acceptance remains outstanding. */
export function createKiroCliReader(dependencies: Dependencies) {
  let pending: ChildProcess | undefined;
  return (commandPath: string): Promise<unknown> => {
    if (pending) return Promise.reject(new KiroCliError("kiro_usage_pending"));
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = dependencies.spawn(
          commandPath,
          ["acp", "--agent-engine", "v3", "--auth-method", "cli"],
          {
            cwd: dependencies.cwd,
            env: dependencies.env,
            detached: true,
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
          },
        );
      } catch {
        reject(new KiroCliError("kiro_usage_failed"));
        return;
      }
      pending = child;
      let spawned = child.pid !== undefined;
      let failedSpawn = false;
      let settled = false;
      let expectedId = 0;
      let bytes = 0;
      let buffer = "";
      const decoder = new StringDecoder("utf8");
      const timer = setTimeout(() => fail("kiro_usage_timed_out"), WAIT_MS);

      function finish(error?: Failure, result?: unknown) {
        if (settled) return;
        settled = true;
        buffer = "";
        clearTimeout(timer);
        if (error) reject(new KiroCliError(error));
        else resolve(result);
        // Keep draining stdout and retain ownership until observed exit,
        // or close after a confirmed failure to create a process.
        // Closing stdin/pipes or signaling could interrupt vendor refresh.
      }
      function fail(error: Failure) {
        finish(error);
      }
      function send(id: number, method: string, params: object) {
        try {
          if (!child.stdin) return fail("kiro_usage_failed");
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        } catch {
          fail("kiro_usage_failed");
        }
      }
      function receive(line: string) {
        if (!line.trim()) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return fail("kiro_usage_malformed");
        }
        if (!value || typeof value !== "object" || Array.isArray(value))
          return fail("kiro_usage_protocol_error");
        const message = value as Record<string, unknown>;
        if (message.jsonrpc !== "2.0") return fail("kiro_usage_protocol_error");
        if (typeof message.method === "string") {
          if (Object.hasOwn(message, "id"))
            fail("kiro_usage_request_unsupported");
          return; // Bounded notifications do not advance the exchange.
        }
        if (
          message.id !== expectedId ||
          Object.hasOwn(message, "error") ||
          !Object.hasOwn(message, "result")
        )
          return fail("kiro_usage_protocol_error");
        if (expectedId === 0) {
          const result = message.result;
          if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            (result as Record<string, unknown>).protocolVersion !== 1
          )
            return fail("kiro_usage_protocol_error");
          expectedId = 1;
          send(1, "_kiro/account/getUsage", {});
        } else finish(undefined, message.result);
      }

      child.on("exit", () => {
        if (pending === child) pending = undefined;
        fail("kiro_usage_failed");
      });
      child.on("spawn", () => {
        spawned = true;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        // Node identifies spawn failures by syscall, with no assigned PID.
        // Generic child errors do not prove that no process was created.
        failedSpawn =
          !spawned &&
          child.pid === undefined &&
          error?.syscall === `spawn ${commandPath}` &&
          typeof error.code === "string";
        fail("kiro_usage_failed");
      });
      child.on("close", () => {
        if (
          failedSpawn &&
          !spawned &&
          child.pid === undefined &&
          pending === child
        )
          pending = undefined;
        fail("kiro_usage_failed");
      });
      child.stdin?.on("error", () => fail("kiro_usage_failed"));
      child.stdout?.on("error", () => fail("kiro_usage_failed"));
      child.stdout?.on("end", () => fail("kiro_usage_failed"));
      child.stdout?.on("data", (chunk: Buffer) => {
        spawned = true;
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return fail("kiro_usage_too_large");
        buffer += decoder.write(chunk);
        let newline: number;
        while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          receive(line);
        }
      });
      if (!child.stdout || !child.stdin) return fail("kiro_usage_failed");
      send(0, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    });
  };
}
