import { describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createKiroAdapter,
  normalizeKiroUsage,
} from "../../src/providers/kiro.js";
import { KiroCliError } from "../../src/providers/kiro-cli.js";
import type { ProviderOptions, ProviderQuota } from "../../src/types.js";

const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: true,
};
const generatedAt = "2026-09-16T12:00:00.000Z";

// Synthetic values in the vendor-normalized ACP result shape. No live store.
function usage() {
  return {
    success: true,
    data: {
      planName: "Synthetic plan",
      billingCycleReset: "2026-10-01",
      usageBreakdowns: [
        {
          resourceType: "CREDIT",
          displayName: "credits",
          used: 25.5,
          limit: 100,
          percentage: 25,
          hasLimit: true,
        },
      ],
      bonusCredits: [
        { name: "trial credits", used: 20, total: 40, daysUntilExpiry: 0 },
      ],
      addOnCredits: [
        { used: 5, total: 50, isActive: false, expiresAt: "Oct 1, 2026" },
      ],
    },
  };
}

function cachedQuota(): ProviderQuota {
  return {
    provider: "kiro",
    label: "Kiro CLI V3",
    source: "cli-rpc",
    windows: [
      {
        id: "usage:1",
        label: "credits",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        resetText: "2026-10-01",
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: generatedAt,
      sourcesTried: ["kiro-v3-acp"],
    },
  };
}

describe("Kiro V3 native usage normalization", () => {
  it("derives remaining from used credits and keeps pools separate", () => {
    const normalized = normalizeKiroUsage(usage());
    expect(normalized?.plan).toBe("Synthetic plan");
    expect(normalized?.windows).toMatchObject([
      { id: "usage:1", percentUsed: 25.5, percentRemaining: 75 },
      { id: "bonus:1", percentUsed: 50, percentRemaining: 50 },
      { id: "add-on:1", percentUsed: 10, percentRemaining: 90 },
    ]);
    for (const window of normalized!.windows) {
      expect(window.startsAt).toBeUndefined();
      expect(window.resetsAt).toBeUndefined();
      expect(window.windowSeconds).toBeUndefined();
    }
    expect(normalized!.windows[0].resetText).toBe("2026-10-01");
    expect(normalized!.windows[1].resetText).toBeUndefined();
  });

  it("does not use vendor used-percent as remaining-percent", () => {
    const payload = usage();
    payload.data.usageBreakdowns[0].percentage = 99;
    expect(normalizeKiroUsage(payload)?.windows[0].percentRemaining).toBe(75);
  });

  it("keeps unknown resources and unlimited meters unmeasured", () => {
    const payload = usage();
    payload.data.usageBreakdowns.push(
      { ...payload.data.usageBreakdowns[0], resourceType: "NEW_RESOURCE" },
      { ...payload.data.usageBreakdowns[0], hasLimit: false },
      { ...payload.data.usageBreakdowns[0], limit: 0 },
    );
    const windows = normalizeKiroUsage(payload)!.windows;
    expect(windows[1].kind).toBe("unknown");
    for (const window of windows.slice(1, 4)) {
      expect(window.percentUsed).toBeUndefined();
      expect(window.percentRemaining).toBeUndefined();
    }
    expect(new Set(windows.map((window) => window.id)).size).toBe(
      windows.length,
    );
  });

  it("clamps overdrawn credits to zero remaining", () => {
    const payload = usage();
    payload.data.usageBreakdowns[0].used = 110;
    expect(normalizeKiroUsage(payload)?.windows[0]).toMatchObject({
      percentUsed: 100,
      percentRemaining: 0,
    });
  });

  it.each([-1, NaN, Infinity, "25", undefined])(
    "rejects malformed credit amounts: %s",
    (used) => {
      const payload = usage();
      Object.assign(payload.data.usageBreakdowns[0], { used });
      expect(() => normalizeKiroUsage(payload)).toThrow("kiro_usage_malformed");
    },
  );

  it("rejects overflowing ratios instead of interpreting them as zero", () => {
    const payload = usage();
    payload.data.usageBreakdowns[0].limit = Number.MIN_VALUE;
    expect(() => normalizeKiroUsage(payload)).toThrow("kiro_usage_malformed");
  });

  it.each([
    null,
    {},
    { success: true, data: {} },
    { success: true, data: { usageBreakdowns: "not an array" } },
    { success: true, data: { usageBreakdowns: [], addOnCredits: [null] } },
  ])("rejects malformed responses: %j", (raw) => {
    expect(() => normalizeKiroUsage(raw)).toThrow("kiro_usage_malformed");
  });

  it("distinguishes unmeasured admin-managed results from explicit empty usage", () => {
    expect(normalizeKiroUsage({ success: true })).toBeUndefined();
    expect(normalizeKiroUsage({ success: false })).toBeUndefined();
    expect(
      normalizeKiroUsage({ success: true, data: { usageBreakdowns: [] } }),
    ).toEqual({ plan: undefined, windows: [] });
  });
});

describe("Kiro provider acceptance boundary", () => {
  it("blocks the injected reader for read-only, auth and profile-only paths", async () => {
    const readUsage = vi.fn();
    const adapter = createKiroAdapter({
      findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
      readUsage,
    });
    expect(
      await adapter.fetchQuota({ ...options, refreshCredentials: false }),
    ).toMatchObject({ state: { error: "kiro_refresh_disabled" } });
    expect(
      await adapter.fetchQuota({ ...options, credentialMode: "profile-only" }),
    ).toMatchObject({ state: { error: "kiro_profile_only_unsupported" } });
    await adapter.inspectAuth(options);
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("discovers the executable without launching it or claiming auth usability", async () => {
    const findCommandPath = vi.fn().mockResolvedValue("/synthetic/kiro-cli");
    const adapter = createKiroAdapter({ findCommandPath });
    expect(await adapter.fetchQuota(options)).toMatchObject({
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", error: "kiro_transport_unverified" },
    });
    expect(await adapter.inspectAuth(options)).toEqual({
      provider: "kiro",
      sources: [
        {
          source: "kiro-v3-acp",
          status: "skipped",
          error: "kiro_transport_unverified",
        },
      ],
    });
    expect(findCommandPath).toHaveBeenCalledWith("kiro-cli");
  });

  it("reports absent or failed discovery without reading credentials", async () => {
    const readUsage = vi.fn();
    const adapter = createKiroAdapter({
      findCommandPath: vi.fn().mockResolvedValue(undefined),
      readUsage,
    });
    expect(await adapter.fetchQuota(options)).toMatchObject({
      state: { error: "kiro_cli_unavailable", status: "unavailable" },
    });
    expect((await adapter.inspectAuth(options)).sources[0].status).toBe(
      "missing",
    );
    expect(readUsage).not.toHaveBeenCalled();
    const failed = createKiroAdapter({
      findCommandPath: vi
        .fn()
        .mockRejectedValue(new Error("secret-shaped text")),
    });
    expect(await failed.fetchQuota(options)).toMatchObject({
      state: { error: "kiro_discovery_failed" },
    });
    expect((await failed.inspectAuth(options)).sources[0]).toMatchObject({
      status: "error",
      error: "kiro_discovery_failed",
    });
  });

  it("normalizes mocked usage without inventing effective bounds or pace", async () => {
    const adapter = createKiroAdapter({
      findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
      readUsage: vi.fn().mockResolvedValue(usage()),
      now: () => Date.parse(generatedAt),
    });
    const quota = withQuotaSemantics(
      await adapter.fetchQuota(options),
      generatedAt,
    );
    expect(quota.state).toMatchObject({
      status: "fresh",
      refreshedAt: generatedAt,
    });
    expect(quota.quotaSemantics?.effectiveAvailability).toEqual([]);
    expect(quota.quotaSemantics?.unresolvedWindowIds).toEqual([
      "usage:1",
      "bonus:1",
      "add-on:1",
    ]);
    for (const window of quota.windows)
      expect(window.pace).toMatchObject({
        status: "unknown",
        reason: "missing_cycle",
      });
  });

  it.each([
    [undefined, "kiro_usage_malformed"],
    [{ success: true }, "kiro_usage_unmeasured"],
    [{ success: false, message: "private text" }, "kiro_usage_unmeasured"],
  ])(
    "keeps unsupported or malformed evidence unavailable",
    async (raw, error) => {
      const adapter = createKiroAdapter({
        findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
        readUsage: vi.fn().mockResolvedValue(raw),
        readCachedProvider: vi.fn(),
      });
      expect(await adapter.fetchQuota(options)).toMatchObject({
        windows: [],
        state: { status: "unavailable", stale: false, error },
      });
    },
  );

  it("redacts transport errors and does not convert them into sign-out", async () => {
    const adapter = createKiroAdapter({
      findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
      readUsage: vi.fn().mockRejectedValue(new Error("private token: example")),
      readCachedProvider: vi.fn(),
    });
    const quota = await adapter.fetchQuota(options);
    expect(quota.state).toMatchObject({
      status: "unavailable",
      error: "kiro_usage_failed",
    });
    expect(JSON.stringify(quota)).not.toContain("private token");
    expect(quota.state.authStatus).toBeUndefined();
  });

  it.each([
    [undefined, "kiro_usage_malformed", "failed"],
    [
      { success: false, message: "Authentication required: private detail" },
      "kiro_usage_unmeasured",
      "skipped",
    ],
  ])(
    "reports cached Kiro data as stale after %s evidence",
    async (raw, error, attemptStatus) => {
      const cached = cachedQuota();
      const adapter = createKiroAdapter({
        findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
        readUsage: vi.fn().mockResolvedValue(raw),
        readCachedProvider: vi.fn().mockReturnValue(cached),
      });

      const quota = await adapter.fetchQuota(options);

      expect(quota).toMatchObject({
        source: "cache",
        windows: cached.windows,
        state: {
          status: "stale",
          stale: true,
          error,
          refreshedAt: generatedAt,
          sourcesTried: ["kiro-v3-acp", "cache"],
        },
        attempts: [
          {
            source: "kiro-v3-acp",
            status: attemptStatus,
            error,
          },
        ],
      });
      expect(quota.state.authStatus).toBeUndefined();
      expect(JSON.stringify(quota)).not.toContain("private detail");
    },
  );

  it("reports cached Kiro data as stale after a bounded reader failure", async () => {
    const cached = cachedQuota();
    const adapter = createKiroAdapter({
      findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
      readUsage: vi
        .fn()
        .mockRejectedValue(new KiroCliError("kiro_usage_timed_out")),
      readCachedProvider: vi.fn().mockReturnValue(cached),
    });

    expect(await adapter.fetchQuota(options)).toMatchObject({
      source: "cache",
      windows: cached.windows,
      state: {
        status: "stale",
        stale: true,
        error: "kiro_usage_timed_out",
      },
      attempts: [
        {
          source: "kiro-v3-acp",
          status: "failed",
          error: "kiro_usage_timed_out",
        },
      ],
    });
  });
});
