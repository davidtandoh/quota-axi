import * as processUtils from "../lib/process.js";
import type { ProviderAdapter, ProviderQuota, QuotaWindow } from "../types.js";
import { failedProvider, successProvider, withRemaining } from "./common.js";
import { KiroCliError } from "./kiro-cli.js";

const SOURCE = "kiro-v3-acp";
const LABEL = "Kiro CLI V3";

type KiroDependencies = {
  findCommandPath: typeof processUtils.findCommandPath;
  /** Test seam only. Native startup and refresh safety are not accepted yet. */
  readUsage?: (commandPath: string) => Promise<unknown>;
  now: () => number;
};

export function createKiroAdapter(
  overrides: Partial<KiroDependencies> = {},
): ProviderAdapter {
  const dependencies: KiroDependencies = {
    findCommandPath: (...args) => processUtils.findCommandPath(...args),
    now: Date.now,
    ...overrides,
  };
  return {
    id: "kiro",
    label: LABEL,
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
      if (!options.refreshCredentials)
        return unavailable("kiro_refresh_disabled", "skipped");
      if (!dependencies.readUsage)
        return unavailable("kiro_transport_unverified", "skipped");

      let raw: unknown;
      try {
        raw = await dependencies.readUsage(commandPath);
      } catch (error) {
        return unavailable(
          error instanceof KiroCliError ? error.code : "kiro_usage_failed",
          "failed",
        );
      }
      try {
        const normalized = normalizeKiroUsage(raw);
        if (!normalized) return unavailable("kiro_usage_unmeasured", "skipped");
        return successProvider({
          provider: "kiro",
          label: LABEL,
          source: "cli-rpc",
          plan: normalized.plan,
          windows: normalized.windows,
          refreshedAt: new Date(dependencies.now()).toISOString(),
          sourcesTried: [SOURCE],
          attempts: [{ source: SOURCE, status: "success" }],
        });
      } catch {
        return unavailable("kiro_usage_malformed", "failed");
      }
    },
    async inspectAuth() {
      try {
        const commandPath = await dependencies.findCommandPath("kiro-cli");
        return {
          provider: "kiro",
          sources: [
            commandPath
              ? {
                  source: SOURCE,
                  status: "skipped",
                  error: "kiro_transport_unverified",
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

function unavailable(
  error: string,
  status: "failed" | "skipped",
): ProviderQuota {
  return failedProvider({
    provider: "kiro",
    label: LABEL,
    status: "unavailable",
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
): { plan?: string; windows: QuotaWindow[] } | undefined {
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
  return { plan: data.planName as string | undefined, windows };
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
