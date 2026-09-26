import { spawn } from "node:child_process";
import * as processUtils from "../lib/process.js";
import { readCachedProvider as readCachedProviderFromDisk } from "../cache.js";
import { kiroAcpDirs } from "../lib/fs.js";
import type { ProviderAdapter, ProviderQuota, QuotaWindow } from "../types.js";
import {
  failedProvider,
  staleFromCache,
  successProvider,
  withRemaining,
} from "./common.js";
import {
  createKiroCliReader,
  KIRO_ENGINES,
  KiroCliError,
  type KiroEngine,
} from "./kiro-cli.js";
import { checkKiroIdle, type KiroIdleResult } from "./kiro-idle.js";

const SOURCE = "kiro-v3-acp";
const LABEL = "Kiro CLI V3";

type KiroDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  /** Fail-closed preflight; the read runs only when this proves Kiro idle. */
  checkIdle: () => Promise<KiroIdleResult>;
  readUsage: (commandPath: string, engine: KiroEngine) => Promise<unknown>;
  readCachedProvider: typeof readCachedProviderFromDisk;
  environment: () => NodeJS.ProcessEnv;
  now: () => number;
};

/** `QUOTA_AXI_KIRO_NATIVE=0` (or false/off/no) turns the native read off. */
const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

let nativeReader: ReturnType<typeof createKiroCliReader> | undefined;

/**
 * The production launcher: direct shell-free spawn of the vendor CLI in an
 * empty quota-axi-owned working directory, with a quota-axi-owned `KIRO_HOME`
 * so the read's settings and session files stay out of the user's `~/.kiro`.
 * The vendor environment is otherwise inherited, so Kiro resolves its own
 * sign-in; quota-axi never reads Kiro credentials.
 */
function readUsageNatively(
  commandPath: string,
  engine: KiroEngine,
): Promise<unknown> {
  if (!nativeReader) {
    const dirs = kiroAcpDirs();
    nativeReader = createKiroCliReader({
      spawn,
      cwd: dirs.cwd,
      env: { ...process.env, KIRO_HOME: dirs.kiroHome },
    });
  }
  return nativeReader(commandPath, engine);
}

export function createKiroAdapter(
  overrides: Partial<KiroDependencies> = {},
): ProviderAdapter {
  const dependencies: KiroDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    checkIdle: () => checkKiroIdle(),
    readUsage: readUsageNatively,
    readCachedProvider: readCachedProviderFromDisk,
    environment: () => process.env,
    now: Date.now,
    ...overrides,
  };
  return {
    id: "kiro",
    label: LABEL,
    // A busy, disabled, or unverified preflight skip says nothing about
    // whether Kiro is set up; only a missing CLI does.
    isUncertainSkip: (attempt) => attempt.error !== "kiro_cli_unavailable",
    async fetchQuota(options) {
      let commandPath: string | undefined;
      try {
        commandPath = await dependencies.findCommandPath("kiro-cli");
      } catch {
        return unavailable("kiro_discovery_failed", "failed");
      }
      if (!commandPath) return unavailable("kiro_cli_unavailable", "skipped");
      if (options.credentialMode === "profile-only")
        return unavailable("kiro_profile_only_unsupported", "skipped");
      // The vendor may rotate its own token during the read.
      if (!options.refreshCredentials)
        return unavailable("kiro_refresh_disabled", "skipped");
      const settings = nativeSettings(dependencies.environment());
      if (settings.disabled)
        return unavailableWithCache(
          dependencies,
          "kiro_native_disabled",
          "skipped",
        );
      if (!settings.engine) return unavailable("kiro_engine_invalid", "failed");

      let idle: KiroIdleResult;
      try {
        idle = await dependencies.checkIdle();
      } catch {
        idle = { idle: false, reason: "kiro_busy_unverified" };
      }
      if (!idle.idle)
        return unavailableWithCache(dependencies, idle.reason, "skipped");

      let raw: unknown;
      try {
        raw = await dependencies.readUsage(commandPath, settings.engine);
      } catch (error) {
        const code =
          error instanceof KiroCliError ? error.code : "kiro_usage_failed";
        if (code === "kiro_not_logged_in")
          return unavailableWithCache(dependencies, code, "failed", {
            status: "auth_required",
          });
        return unavailableWithCache(dependencies, code, "failed");
      }
      try {
        const normalized = normalizeKiroUsage(raw);
        if (!normalized)
          return unavailableWithCache(
            dependencies,
            "kiro_usage_unmeasured",
            "skipped",
          );
        return successProvider({
          provider: "kiro",
          label: LABEL,
          source: "cli-rpc",
          plan: normalized.plan,
          windows: normalized.windows,
          ...(normalized.creditsRemaining !== undefined
            ? {
                credits: {
                  remaining: normalized.creditsRemaining,
                  unit: "credits" as const,
                },
              }
            : {}),
          refreshedAt: new Date(dependencies.now()).toISOString(),
          sourcesTried: [SOURCE],
          attempts: [{ source: SOURCE, status: "success" }],
        });
      } catch {
        return unavailableWithCache(
          dependencies,
          "kiro_usage_malformed",
          "failed",
        );
      }
    },
    async inspectAuth() {
      try {
        const commandPath = await dependencies.findCommandPath("kiro-cli");
        // Kiro owns its sign-in store; quota-axi never opens it, so presence
        // of the CLI says nothing about usable authentication.
        return {
          provider: "kiro",
          sources: [
            commandPath
              ? {
                  source: SOURCE,
                  status: "skipped",
                  error: nativeSettings(dependencies.environment()).disabled
                    ? "kiro_native_disabled"
                    : "kiro_auth_vendor_owned",
                }
              : { source: SOURCE, status: "missing" },
          ],
        };
      } catch {
        return {
          provider: "kiro",
          sources: [
            { source: SOURCE, status: "error", error: "kiro_discovery_failed" },
          ],
        };
      }
    },
  };
}

export const kiroAdapter = createKiroAdapter();

function nativeSettings(environment: NodeJS.ProcessEnv): {
  disabled: boolean;
  engine?: KiroEngine;
} {
  const flag = environment.QUOTA_AXI_KIRO_NATIVE?.trim().toLowerCase();
  const engine = environment.QUOTA_AXI_KIRO_ENGINE?.trim() || "v3";
  return {
    disabled: flag !== undefined && DISABLED_VALUES.has(flag),
    engine: (KIRO_ENGINES as readonly string[]).includes(engine)
      ? (engine as KiroEngine)
      : undefined,
  };
}

function unavailableWithCache(
  dependencies: KiroDependencies,
  error: string,
  status: "failed" | "skipped",
  options: { status?: ProviderQuota["state"]["status"] } = {},
): ProviderQuota {
  const attempt = { source: SOURCE, status, error } as const;
  const cached = dependencies.readCachedProvider("kiro");
  const stale = cached
    ? staleFromCache(cached, error, [SOURCE], [attempt], dependencies.now())
    : undefined;
  return stale ?? unavailable(error, status, options.status);
}

function unavailable(
  error: string,
  status: "failed" | "skipped",
  providerStatus: ProviderQuota["state"]["status"] = "unavailable",
): ProviderQuota {
  return failedProvider({
    provider: "kiro",
    label: LABEL,
    status: providerStatus,
    error,
    sourcesTried: [SOURCE],
    attempts: [{ source: SOURCE, status, error }],
  });
}

/**
 * Parse the native `_kiro/account/getUsage` result, not a chat transcript.
 * Provenance and acceptance limits: docs/kiro-v3-transport-assessment.md.
 * The native `percentage` is used percent. Derive from used/limit instead.
 */
export function normalizeKiroUsage(
  raw: unknown,
):
  | { plan?: string; windows: QuotaWindow[]; creditsRemaining?: number }
  | undefined {
  const result = object(raw);
  if (!result || typeof result.success !== "boolean") malformed();
  if (!result.success || result.data === undefined) return undefined;
  const data = object(result.data);
  if (!data || !Array.isArray(data.usageBreakdowns)) malformed();
  if (data.planName !== undefined && typeof data.planName !== "string")
    malformed();
  if (
    data.billingCycleReset !== undefined &&
    typeof data.billingCycleReset !== "string"
  )
    malformed();

  const resetText =
    typeof data.billingCycleReset === "string" &&
    data.billingCycleReset !== "Unknown"
      ? data.billingCycleReset
      : undefined;
  const planCredits: { used: number; limit: number }[] = [];
  const windows = data.usageBreakdowns.map((value, index) => {
    const meter = object(value);
    if (
      !meter ||
      typeof meter.resourceType !== "string" ||
      typeof meter.displayName !== "string" ||
      typeof meter.hasLimit !== "boolean"
    )
      malformed();
    const credit = meter.resourceType === "CREDIT";
    if (
      credit &&
      meter.hasLimit &&
      nonnegativeNumber(meter.used) &&
      nonnegativeNumber(meter.limit)
    )
      planCredits.push({ used: meter.used, limit: meter.limit });
    return usageWindow({
      id: `usage:${index + 1}`,
      label: meter.displayName,
      kind: credit ? "credits" : "unknown",
      used: meter.used,
      limit: meter.limit,
      measured: credit && meter.hasLimit,
      resetText,
    });
  });

  for (const [field, prefix] of [
    ["bonusCredits", "bonus"],
    ["addOnCredits", "add-on"],
  ] as const) {
    const pools = data[field];
    if (pools === undefined) continue;
    if (!Array.isArray(pools)) malformed();
    pools.forEach((value, index) => {
      const pool = object(value);
      if (!pool) malformed();
      if (field === "bonusCredits" && typeof pool.name !== "string")
        malformed();
      if (field === "addOnCredits" && typeof pool.isActive !== "boolean")
        malformed();
      // isActive selects a drawing pack. False does not mean unusable.
      // Rounded expiry days and date-only resets cannot supply cycle times.
      windows.push(
        usageWindow({
          id: `${prefix}:${index + 1}`,
          label:
            field === "bonusCredits"
              ? (pool.name as string)
              : `add-on credits ${index + 1}`,
          kind: "credits",
          used: pool.used,
          limit: pool.total,
          measured: true,
        }),
      );
    });
  }
  // Absolute remaining credits only when a single plan meter is the whole
  // picture; with bonus or add-on pools their relationship is unknown.
  const onlyPlanMeter =
    planCredits.length === 1 && windows.length === 1
      ? planCredits[0]
      : undefined;
  return {
    plan: data.planName as string | undefined,
    windows,
    ...(onlyPlanMeter
      ? {
          creditsRemaining: Math.max(
            0,
            onlyPlanMeter.limit - onlyPlanMeter.used,
          ),
        }
      : {}),
  };
}

function usageWindow(args: {
  id: string;
  label: string;
  kind: QuotaWindow["kind"];
  used: unknown;
  limit: unknown;
  measured: boolean;
  resetText?: string;
}): QuotaWindow {
  if (!nonnegativeNumber(args.used) || !nonnegativeNumber(args.limit))
    malformed();
  const ratio = args.limit > 0 ? (args.used / args.limit) * 100 : undefined;
  if (ratio !== undefined && !Number.isFinite(ratio)) malformed();
  return withRemaining({
    id: args.id,
    label: args.label,
    kind: args.kind,
    ...(args.measured && ratio !== undefined
      ? { percentUsed: Math.min(100, ratio) }
      : {}),
    ...(args.resetText ? { resetText: args.resetText } : {}),
  });
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function malformed(): never {
  throw new Error("kiro_usage_malformed");
}
