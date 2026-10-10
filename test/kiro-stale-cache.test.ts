import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider } from "../src/cache.js";
import { quotaCommand } from "../src/commands.js";
import { cacheFilePath } from "../src/lib/fs.js";
import { PROVIDERS } from "../src/providers/index.js";
import { createKiroAdapter } from "../src/providers/kiro.js";
import { KiroCliError } from "../src/providers/kiro-cli.js";
import { renderQuotaTui } from "../src/tui.js";
import type { QuotaAxiResponse } from "../src/types.js";

const observedAt = "2026-09-16T12:00:00.000Z";
let directory: string;
const checkIdle = vi.fn();
const readUsage = vi.fn();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kiro-stale-"));
  vi.stubEnv("XDG_CACHE_HOME", directory);
  vi.stubEnv("QUOTA_AXI_MAX_AGE", "0");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(observedAt));
  checkIdle.mockResolvedValue({ idle: true });
  readUsage.mockResolvedValue({
    success: true,
    data: {
      planName: "Synthetic plan",
      billingCycleReset: "2026-10-01",
      usageBreakdowns: [
        {
          resourceType: "CREDIT",
          displayName: "Credits",
          used: 25,
          limit: 100,
          hasLimit: true,
        },
      ],
    },
  });
  const adapter = createKiroAdapter({
    findCommandPath: async () => "/synthetic/kiro-cli",
    checkIdle,
    readUsage,
    environment: () => ({}),
  });
  vi.spyOn(PROVIDERS.kiro, "fetchQuota").mockImplementation(adapter.fetchQuota);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

async function report(): Promise<QuotaAxiResponse> {
  return JSON.parse(
    await quotaCommand(["--provider", "kiro", "--json"], undefined),
  );
}

describe("Kiro last observation through the quota command", () => {
  it("persists a successful reading, counts active-process fallback as stale, and resumes live reads", async () => {
    expect((await report()).providers[0].state.status).toBe("fresh");
    expect(readCachedProvider("kiro")).toMatchObject({
      credits: { remaining: 75 },
      state: { refreshedAt: observedAt, stale: false },
      windows: [{ percentRemaining: 75 }],
    });
    expect(statSync(cacheFilePath()).mode & 0o777).toBe(0o600);
    const original = readFileSync(cacheFilePath(), "utf8");
    checkIdle.mockResolvedValue({
      idle: false,
      reason: "kiro_busy_process_active",
    });
    vi.setSystemTime(new Date(Date.parse(observedAt) + 90_000));
    const stale = await report();
    expect(stale.providers[0]).toMatchObject({
      credits: { remaining: 75 },
      windows: [{ percentRemaining: 75 }],
      state: {
        status: "stale",
        stale: true,
        refreshedAt: observedAt,
        ageSeconds: 90,
        error: "kiro_busy_process_active",
      },
    });
    for (const scope of stale.providers[0].quotaSemantics
      ?.effectiveAvailability ?? []) {
      expect(scope.effectivePercentRemaining).toBeUndefined();
    }
    const tui = renderQuotaTui(stale, { columns: 120, colorDepth: "none" });
    expect(tui).toContain("0 live · 1 stale · 0 need attention");
    expect(tui).toContain("75%");
    expect(tui).toContain("last refreshed 1m ago");
    expect(tui).not.toContain("excluded from fleet totals");
    const toon = await quotaCommand(["--provider", "kiro"], undefined);
    expect(toon).toContain("stale");
    expect(toon).toContain("age 90s");
    expect(readUsage).toHaveBeenCalledTimes(1);
    expect(readFileSync(cacheFilePath(), "utf8")).toBe(original);

    checkIdle.mockResolvedValue({ idle: true });
    expect((await report()).providers[0].state).toMatchObject({
      status: "fresh",
      stale: false,
    });
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(readCachedProvider("kiro")?.state.refreshedAt).toBe(
      new Date().toISOString(),
    );
  });

  it("retires a signed-out snapshot before a later active-process fallback", async () => {
    expect((await report()).providers[0].state.status).toBe("fresh");
    expect(readCachedProvider("kiro")).toBeDefined();

    readUsage.mockRejectedValue(new KiroCliError("kiro_not_logged_in"));
    expect((await report()).providers[0]).toMatchObject({
      windows: [],
      state: {
        status: "auth_required",
        stale: false,
        error: "kiro_not_logged_in",
      },
    });
    expect(readCachedProvider("kiro")).toBeUndefined();

    readUsage.mockClear();
    checkIdle.mockResolvedValue({
      idle: false,
      reason: "kiro_busy_process_active",
    });
    const busy = await report();
    expect(busy.providers[0]).toMatchObject({
      windows: [],
      state: {
        status: "unavailable",
        stale: false,
        error: "kiro_busy_process_active",
      },
    });
    expect(busy.providers[0].credits).toBeUndefined();
    expect(
      renderQuotaTui(busy, { columns: 120, colorDepth: "none" }),
    ).toContain("excluded from fleet totals");
    expect(readUsage).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "invalid timestamp", "future timestamp"])(
    "reports unavailable for %s cache while active",
    async (kind) => {
      if (kind !== "missing") {
        await report();
        if (kind === "malformed") writeFileSync(cacheFilePath(), "{broken");
        else {
          const payload = JSON.parse(readFileSync(cacheFilePath(), "utf8"));
          // The shared cache persists normalized provider records.
          payload.providers[0].state.refreshedAt =
            kind === "invalid timestamp" ? "bad" : "2027-01-01T00:00:00.000Z";
          writeFileSync(cacheFilePath(), JSON.stringify(payload));
        }
      }
      readUsage.mockClear();
      checkIdle.mockResolvedValue({
        idle: false,
        reason: "kiro_busy_process_active",
      });
      expect((await report()).providers[0]).toMatchObject({
        windows: [],
        state: { status: "unavailable", stale: false },
      });
      expect(readUsage).not.toHaveBeenCalled();
    },
  );

  it.each([
    "kiro_busy_task_active",
    "kiro_busy_unverified",
    "kiro_usage_failed",
  ])(
    "does not admit resetless values for ordinary failure %s",
    async (reason) => {
      await report();
      if (reason === "kiro_usage_failed")
        readUsage.mockRejectedValue(new KiroCliError(reason));
      else checkIdle.mockResolvedValue({ idle: false, reason });
      const unavailable = await report();
      expect(unavailable.providers[0]).toMatchObject({
        windows: [],
        state: { status: "unavailable", stale: false, error: reason },
      });
      expect(unavailable.providers[0].credits).toBeUndefined();
      expect(
        renderQuotaTui(unavailable, { columns: 120, colorDepth: "none" }),
      ).toContain("excluded from fleet totals");
    },
  );
});
