import type { ChildProcess, SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const WAIT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;
/** Stderr is kept only to classify a sign-in failure; it is never published. */
const MAX_STDERR_BYTES = 16 * 1024;
/** After EOF, how long the vendor gets to exit before each signal escalation. */
const TERMINATE_GRACE_MS = 2_000;
export const KIRO_ENGINES = ["v1", "v2", "v3"] as const;
export type KiroEngine = (typeof KIRO_ENGINES)[number];

type Failure =
  | "kiro_usage_pending"
  | "kiro_usage_timed_out"
  | "kiro_usage_failed"
  | "kiro_usage_malformed"
  | "kiro_usage_protocol_error"
  | "kiro_usage_request_unsupported"
  | "kiro_usage_too_large"
  | "kiro_not_logged_in";

export class KiroCliError extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}

type Dependencies = {
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Signal the child's process group. Defaults to `process.kill(-pid)`. */
  signalGroup?: (child: ChildProcess, signal: NodeJS.Signals) => void;
};

/**
 * Fixed ACP exchange only: `initialize`, then `_kiro/account/getUsage`. No
 * session, prompt, or credential request is ever sent, so no model credits are
 * consumed. The caller owns the safety preflight (see `kiro-idle.ts`).
 */
export function createKiroCliReader(dependencies: Dependencies) {
  let pending: ChildProcess | undefined;
  const signalGroup = dependencies.signalGroup ?? defaultSignalGroup;
  return (commandPath: string, engine: KiroEngine = "v3"): Promise<unknown> => {
    if (pending) return Promise.reject(new KiroCliError("kiro_usage_pending"));
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = dependencies.spawn(
          commandPath,
          ["acp", "--agent-engine", engine, "--auth-method", "cli"],
          {
            cwd: dependencies.cwd,
            env: dependencies.env,
            detached: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
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
      let responseReceived = false;
      let response: unknown;
      let sawExit = false;
      let sawClose = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let expectedId = 0;
      let bytes = 0;
      let buffer = "";
      let stderr = "";
      let stderrBytes = 0;
      let terminating = false;
      const escalations: NodeJS.Timeout[] = [];
      const decoder = new StringDecoder("utf8");
      const timer = setTimeout(() => fail("kiro_usage_timed_out"), WAIT_MS);

      function finish(error?: Failure, result?: unknown) {
        if (settled) return;
        settled = true;
        buffer = "";
        clearTimeout(timer);
        if (error) reject(new KiroCliError(error));
        else resolve(result);
        // Retain ownership until both process exit and stream close are
        // observed, or close after a confirmed failure to create a process.
      }
      function fail(error: Failure) {
        finish(error);
        terminate();
      }
      /**
       * Clean termination of a failed exchange: normal EOF first, so the
       * vendor can drain its own authentication work, then SIGTERM and
       * finally SIGKILL to the whole detached process group if it has not
       * exited. A confirmed failed spawn has no process to signal.
       */
      function terminate() {
        if (terminating || sawExit) return;
        if (failedSpawn && !spawned && child.pid === undefined) return;
        terminating = true;
        try {
          child.stdin?.end();
        } catch {
          // The escalation below still applies.
        }
        escalate("SIGTERM", TERMINATE_GRACE_MS);
        escalate("SIGKILL", 2 * TERMINATE_GRACE_MS);
      }
      function escalate(signal: NodeJS.Signals, delayMs: number) {
        const handle = setTimeout(() => {
          if (sawExit) return;
          try {
            signalGroup(child, signal);
          } catch {
            // Already gone; exit and close events settle ownership.
          }
        }, delayMs);
        handle.unref?.();
        escalations.push(handle);
      }
      function maybeComplete() {
        if (failedSpawn && !spawned && child.pid === undefined && sawClose) {
          if (pending === child) pending = undefined;
          fail("kiro_usage_failed");
          return;
        }
        if (!sawExit || !sawClose) return;
        for (const handle of escalations) clearTimeout(handle);
        if (pending === child) pending = undefined;
        if (responseReceived && exitCode === 0 && exitSignal === null)
          finish(undefined, response);
        else if (!responseReceived && /not logged in/i.test(stderr))
          finish("kiro_not_logged_in");
        else finish("kiro_usage_failed");
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
        } else {
          response = message.result;
          responseReceived = true;
          buffer = "";
          try {
            if (!child.stdin) return fail("kiro_usage_failed");
            child.stdin.end();
          } catch {
            fail("kiro_usage_failed");
          }
        }
      }

      child.on("exit", (code, signal) => {
        sawExit = true;
        exitCode = code;
        exitSignal = signal;
        maybeComplete();
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
        sawClose = true;
        if (!sawExit && !(failedSpawn && !spawned && child.pid === undefined))
          fail("kiro_usage_failed");
        maybeComplete();
      });
      child.stderr?.on("error", () => undefined);
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        stderrBytes += chunk.length;
        stderr += chunk.toString("utf8");
      });
      // A broken input pipe or early output EOF usually means the vendor is
      // exiting on its own (for example, not signed in). Let exit and close
      // classify it; the total wait still bounds the exchange.
      child.stdin?.on("error", () => terminate());
      child.stdout?.on("error", () => fail("kiro_usage_failed"));
      child.stdout?.on("end", () => {
        if (!responseReceived) terminate();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        spawned = true;
        if (settled || responseReceived) return;
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

function defaultSignalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    // Negative PID: the detached child leads its own process group, which
    // also holds the V3 engine it starts.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
