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

/** An adapter whose preflight proves idle and whose environment is empty. */
function adapterWith(
  overrides: Parameters<typeof createKiroAdapter>[0] = {},
): ReturnType<typeof createKiroAdapter> {
  return createKiroAdapter({
    findCommandPath: vi.fn().mockResolvedValue("/synthetic/kiro-cli"),
    checkIdle: vi.fn().mockResolvedValue({ idle: true }),
    readUsage: vi.fn().mockRejectedValue(new Error("unexpected read")),
    readCachedProvider: vi.fn(),
    environment: () => ({}),
    now: () => Date.parse(generatedAt) + 60_000,
    ...overrides,
  });
}

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
        // A dated window: resetless credit windows have no stale age bound.
        resetsAt: "2026-10-01T00:00:00.000Z",
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
    const adapter = adapterWith({
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

  it("inspects auth without launching Kiro or claiming auth usability", async () => {
    const findCommandPath = vi.fn().mockResolvedValue("/synthetic/kiro-cli");
    const readUsage = vi.fn();
    const checkIdle = vi.fn();
    const adapter = adapterWith({ findCommandPath, readUsage, checkIdle });
    expect(await adapter.inspectAuth(options)).toEqual({
      provider: "kiro",
      sources: [
        {
          source: "kiro-v3-acp",
          status: "skipped",
          error: "kiro_auth_vendor_owned",
        },
      ],
    });
    expect(findCommandPath).toHaveBeenCalledWith("kiro-cli");
    expect(readUsage).not.toHaveBeenCalled();
    expect(checkIdle).not.toHaveBeenCalled();
  });

  it.each(["0", "false", "OFF", "no"])(
    "honors the QUOTA_AXI_KIRO_NATIVE=%s opt-out before any preflight",
    async (value) => {
      const readUsage = vi.fn();
      const checkIdle = vi.fn();
      const adapter = adapterWith({
        readUsage,
        checkIdle,
        environment: () => ({ QUOTA_AXI_KIRO_NATIVE: value }),
      });
      expect(await adapter.fetchQuota(options)).toMatchObject({
        state: { status: "unavailable", error: "kiro_native_disabled" },
      });
      expect((await adapter.inspectAuth(options)).sources[0].error).toBe(
        "kiro_native_disabled",
      );
      expect(checkIdle).not.toHaveBeenCalled();
      expect(readUsage).not.toHaveBeenCalled();
    },
  );

  it("reads with the V3 engine by default and a configured engine otherwise", async () => {
    const readUsage = vi.fn().mockResolvedValue(usage());
    await adapterWith({ readUsage }).fetchQuota(options);
    await adapterWith({
      readUsage,
      environment: () => ({ QUOTA_AXI_KIRO_ENGINE: "v2" }),
    }).fetchQuota(options);
    expect(readUsage.mock.calls).toEqual([
      ["/synthetic/kiro-cli", "v3"],
      ["/synthetic/kiro-cli", "v2"],
    ]);
  });

  it("fails closed on an unknown engine without a preflight or launch", async () => {
    const readUsage = vi.fn();
    const checkIdle = vi.fn();
    const adapter = adapterWith({
      readUsage,
      checkIdle,
      environment: () => ({ QUOTA_AXI_KIRO_ENGINE: "v3 --trust-all-tools" }),
    });
    expect(await adapter.fetchQuota(options)).toMatchObject({
      state: { status: "unavailable", error: "kiro_engine_invalid" },
    });
    expect(checkIdle).not.toHaveBeenCalled();
    expect(readUsage).not.toHaveBeenCalled();
  });

  it.each([
    "kiro_busy_process_active",
    "kiro_busy_task_active",
    "kiro_busy_unverified",
  ] as const)(
    "skips the launch and serves stale cache when the preflight reports %s",
    async (reason) => {
      const readUsage = vi.fn();
      const cached = cachedQuota();
      const busy = adapterWith({
        readUsage,
        checkIdle: vi.fn().mockResolvedValue({ idle: false, reason }),
        readCachedProvider: vi.fn().mockReturnValue(cached),
      });
      expect(await busy.fetchQuota(options)).toMatchObject({
        source: "cache",
        windows: cached.windows,
        state: { status: "stale", error: reason },
        attempts: [{ source: "kiro-v3-acp", status: "skipped", error: reason }],
      });
      const uncached = adapterWith({
        readUsage,
        checkIdle: vi.fn().mockResolvedValue({ idle: false, reason }),
      });
      const quota = await uncached.fetchQuota(options);
      expect(quota).toMatchObject({
        windows: [],
        state: { status: "unavailable", error: reason },
      });
      expect(readUsage).not.toHaveBeenCalled();
      expect(
        uncached.isUncertainSkip?.({
          source: "kiro-v3-acp",
          status: "skipped",
          error: reason,
        }),
      ).toBe(true);
    },
  );

  it("withholds a resetless cached credit window instead of serving it stale", async () => {
    const cached = cachedQuota();
    delete cached.windows[0].resetsAt;
    const adapter = adapterWith({
      checkIdle: vi
        .fn()
        .mockResolvedValue({ idle: false, reason: "kiro_busy_task_active" }),
      readCachedProvider: vi.fn().mockReturnValue(cached),
    });
    expect(await adapter.fetchQuota(options)).toMatchObject({
      windows: [],
      state: { status: "unavailable", error: "kiro_busy_task_active" },
    });
  });

  it("treats a throwing preflight as unverified, never as idle", async () => {
    const readUsage = vi.fn();
    const adapter = adapterWith({
      readUsage,
      checkIdle: vi.fn().mockRejectedValue(new Error("private detail")),
    });
    expect(await adapter.fetchQuota(options)).toMatchObject({
      state: { status: "unavailable", error: "kiro_busy_unverified" },
    });
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("reports a Kiro sign-out as auth_required without reading credentials", async () => {
    const adapter = adapterWith({
      readUsage: vi
        .fn()
        .mockRejectedValue(new KiroCliError("kiro_not_logged_in")),
    });
    expect(await adapter.fetchQuota(options)).toMatchObject({
      windows: [],
      state: { status: "auth_required", error: "kiro_not_logged_in" },
      attempts: [
        {
          source: "kiro-v3-acp",
          status: "failed",
          error: "kiro_not_logged_in",
        },
      ],
    });
  });

  it("reports the 2,000-credit cycle with absolute remaining credits and date-only reset", async () => {
    const adapter = adapterWith({
      readUsage: vi.fn().mockResolvedValue({
        success: true,
        data: {
          planName: "KIRO PRO+",
          billingCycleReset: "2026-10-01",
          usageBreakdowns: [
            {
              resourceType: "CREDIT",
              displayName: "Credits",
              used: 61.22,
              limit: 2000,
              hasLimit: true,
            },
          ],
          bonusCredits: [],
          addOnCredits: [],
        },
      }),
      now: () => Date.parse(generatedAt),
    });
    const quota = withQuotaSemantics(
      await adapter.fetchQuota(options),
      generatedAt,
    );
    expect(quota).toMatchObject({
      plan: "KIRO PRO+",
      source: "cli-rpc",
      credits: { remaining: 1938.78, unit: "credits" },
      state: { status: "fresh" },
    });
    expect(quota.windows).toHaveLength(1);
    expect(quota.windows[0]).toMatchObject({
      id: "usage:1",
      kind: "credits",
      resetText: "2026-10-01",
    });
    expect(quota.windows[0].percentUsed).toBeCloseTo(3.061);
    expect(quota.windows[0].resetsAt).toBeUndefined();
    expect(quota.windows[0].pace).toMatchObject({ status: "unknown" });
  });

  it("reports absent or failed discovery without reading credentials", async () => {
    const readUsage = vi.fn();
    const adapter = adapterWith({
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
    expect(
      adapter.isUncertainSkip?.({
        source: "kiro-v3-acp",
        status: "skipped",
        error: "kiro_cli_unavailable",
      }),
    ).toBe(false);
    const failed = adapterWith({
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
    const adapter = adapterWith({
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
      const adapter = adapterWith({
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
    const adapter = adapterWith({
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
      const adapter = adapterWith({
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
    const adapter = adapterWith({
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
