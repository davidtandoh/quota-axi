import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../src/cache.js";
import { withQuotaSemantics } from "../src/interpretation.js";
import { coalesceVerifiedSubscriptions } from "../src/providers/accounts.js";
import {
  normalizeCodexUsage,
  mergeAccountAndLimits,
} from "../src/providers/codex.js";
import { quotaJsonReport, renderQuotaToon } from "../src/render.js";
import { renderQuotaTui } from "../src/tui.js";
import type { ProviderQuota, QuotaAxiResponse } from "../src/types.js";

const NOW = "2026-11-11T20:00:00.000Z";
const known = {
  status: "known",
  availableCount: 2,
  application: "on_demand",
} as const;
const unmeasurable = {
  status: "unmeasurable",
  reason: "not_reported",
} as const;
const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/codex/oauth-reset-inventory.json"),
    "utf8",
  ),
);
let temp: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = undefined;
});

function reading(raw: unknown = fixture): ProviderQuota {
  const normalized = normalizeCodexUsage(raw);
  if (!normalized) throw new Error("fixture has no reading");
  return {
    ...normalized,
    provider: "codex",
    label: "Codex",
    source: "oauth",
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: NOW,
      sourcesTried: ["oauth"],
    },
  };
}

function response(provider = reading()): QuotaAxiResponse {
  return {
    generatedAt: NOW,
    schemaVersion: 5,
    providers: [withQuotaSemantics(provider, NOW)],
  };
}

describe("earned limit-reset inventory", () => {
  it.each([2, 0, undefined])(
    "retains the winning subscription observation (%s) without summing inventory",
    (count) => {
      const first = {
        ...reading(),
        accountKey: "native",
        accountKeys: ["native"],
        account: { accountId: "same-subscription" },
      };
      first.limitResets =
        count === undefined ? undefined : { ...known, availableCount: count };
      const sibling = {
        ...reading(),
        accountKey: "pi",
        accountKeys: ["pi"],
        account: { accountId: "same-subscription" },
        limitResets: { ...known, availableCount: 4 },
      };
      const distinct = {
        ...reading(),
        accountKey: "other",
        accountKeys: ["other"],
        account: { accountId: "different-subscription" },
        limitResets: { ...known, availableCount: 7 },
      };

      const merged = coalesceVerifiedSubscriptions([first, sibling, distinct]);

      expect(merged).toHaveLength(2);
      expect(merged[0].accountKeys).toEqual(["native", "pi"]);
      expect(merged[0].limitResets).toEqual(
        count === undefined ? undefined : { ...known, availableCount: count },
      );
      expect(merged[1].limitResets).toEqual({ ...known, availableCount: 7 });
    },
  );

  it("reports the observed HTTP count separately from purchased credits", () => {
    expect(reading()).toMatchObject({
      limitResets: known,
      credits: { remaining: 100 },
    });
  });

  it.each([0, 1, 2, Number.MAX_SAFE_INTEGER])(
    "preserves the count %s without substituting applicable count",
    (count) => {
      expect(
        normalizeCodexUsage({
          ...fixture,
          rate_limit_reset_credits: {
            available_count: count,
            applicable_available_count: 0,
          },
        })?.limitResets,
      ).toEqual({ ...known, availableCount: count });
    },
  );

  it.each([undefined, null])(
    "distinguishes unavailable inventory (%s) from zero",
    (inventory) => {
      expect(
        normalizeCodexUsage({ ...fixture, rate_limit_reset_credits: inventory })
          ?.limitResets,
      ).toEqual(unmeasurable);
    },
  );

  it.each([
    -1,
    0.5,
    "2",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
  ])("rejects an invalid count %s without losing valid quota", (count) => {
    const result = normalizeCodexUsage({
      ...fixture,
      rate_limit_reset_credits: { available_count: count },
    });
    expect(result?.limitResets).toEqual({
      status: "unmeasurable",
      reason: "invalid_inventory",
    });
    expect(result?.windows).toHaveLength(2);
  });

  it.each([[], "2", false])(
    "rejects a malformed inventory container %j",
    (inventory) => {
      expect(
        normalizeCodexUsage({ ...fixture, rate_limit_reset_credits: inventory })
          ?.limitResets,
      ).toEqual({ status: "unmeasurable", reason: "invalid_inventory" });
    },
  );

  it("preserves inventory when the RPC account and limits are merged", () => {
    const merged = mergeAccountAndLimits(
      { account: { planType: "pro" } },
      {
        rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300 } },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 90, windowDurationMins: 300 } },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              resetType: "codexRateLimits",
              status: "available",
              expiresAt: 1794427200,
            },
          ],
        },
      },
    );
    expect(normalizeCodexUsage(merged)?.limitResets).toEqual(known);
  });

  it.each([null, [], [{ expiresAt: 1 }], [{ expiresAt: 1999999999 }]])(
    "uses the authoritative RPC count with capped or expired detail rows %j",
    (credits) => {
      const result = normalizeCodexUsage({
        rateLimits: { primary: { usedPercent: 90 } },
        rateLimitResetCredits: { availableCount: 2, credits },
      });
      expect(result?.limitResets).toEqual(known);
    },
  );

  it.each([0, 2])(
    "does not treat inventory %s without a quota window as a reading",
    (count) => {
      expect(
        normalizeCodexUsage({
          rate_limit: null,
          rate_limit_reset_credits: { available_count: count },
        }),
      ).toBeUndefined();
      expect(
        normalizeCodexUsage({
          rateLimitResetCredits: { availableCount: count },
        }),
      ).toBeUndefined();
    },
  );

  it("does not label a reused legacy snapshot as not reported", () => {
    const legacy = reading();
    delete legacy.limitResets;
    legacy.state = { ...legacy.state, reused: true };
    expect(withQuotaSemantics(legacy, NOW)).not.toHaveProperty("limitResets");

    const measured = reading({
      ...fixture,
      rate_limit_reset_credits: { available_count: 0 },
    });
    measured.state = { ...measured.state, reused: true };
    expect(withQuotaSemantics(measured, NOW).limitResets).toEqual({
      ...known,
      availableCount: 0,
    });
  });

  it.each(["session", "weekly"])(
    "keeps the %s bound and economics unchanged for on-demand inventory",
    (binding) => {
      const raw = structuredClone(fixture);
      if (binding === "weekly") {
        raw.rate_limit.primary_window.used_percent = 10;
        raw.rate_limit.secondary_window.used_percent = 99;
      }
      const baseline = response(
        reading({ ...raw, rate_limit_reset_credits: null }),
      ).providers[0].quotaSemantics;
      expect(baseline?.effectiveAvailability[0].runway?.limitingWindowId).toBe(
        binding === "session" ? "five_hour" : "weekly",
      );
      for (const count of [0, 1, 10]) {
        expect(
          response(
            reading({
              ...raw,
              rate_limit_reset_credits: { available_count: count },
            }),
          ).providers[0].quotaSemantics,
        ).toEqual(baseline);
      }
    },
  );

  it("does not infer a Claude inventory from plan, windows or promotional credits", () => {
    const claude = {
      ...reading(),
      provider: "claude" as const,
      plan: "max",
      limitResets: undefined,
    };
    expect(response(claude).providers[0].limitResets).toEqual(unmeasurable);
  });

  it("keeps inventory in both JSON tiers and names it in TOON and TUI", () => {
    const report = response();
    for (const full of [false, true]) {
      expect(quotaJsonReport(report, full).providers[0].limitResets).toEqual(
        known,
      );
      expect(renderQuotaToon(report, "quota-axi", full)).toContain("on demand");
    }
    expect(
      renderQuotaTui(report, { columns: 120, colorDepth: "none" }),
    ).toContain("limit resets: 2 available");
  });

  it("names unmeasurable inventory in output attention without inventing a count", () => {
    const report = response(
      reading({ ...fixture, rate_limit_reset_credits: null }),
    );
    const toon = renderQuotaToon(report, "quota-axi", false);
    expect(toon).toContain("limit_resets,unmeasurable");
    expect(toon).toContain("not reported by supported usage surface");
    expect(
      quotaJsonReport(report, false).providers[0].limitResets,
    ).not.toHaveProperty("availableCount");
  });

  it("preserves the normalized observation through cache without copying vendor fields", () => {
    temp = mkdtempSync(join(tmpdir(), "quota-reset-cache-"));
    vi.stubEnv("HOME", temp);
    vi.stubEnv("XDG_CACHE_HOME", temp);
    const quota = reading();
    quota.limitResets = { ...known, secret: "never-persist" } as typeof known;
    writeCachedProviders([quota]);
    expect(readCachedProvider("codex")?.limitResets).toEqual(known);
    expect(
      readFileSync(join(temp, "quota-axi/quotas.json"), "utf8"),
    ).not.toContain("never-persist");
  });

  it("labels a cached count as last observed when the provider is stale", () => {
    const quota = reading();
    quota.state = {
      ...quota.state,
      status: "stale",
      stale: true,
      ageSeconds: 60,
    };
    const report = response(quota);
    expect(renderQuotaToon(report, "quota-axi", false)).toContain(
      "last observed 2",
    );
    expect(
      report.providers[0].quotaSemantics?.effectiveAvailability[0].status,
    ).toBe("unknown");
  });
});
