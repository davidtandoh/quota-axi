import type { LimitResetInventory } from "./types.js";

/** Allowlist the inventory contract at both provider and cache boundaries. */
export function normalizeLimitResetInventory(
  raw: unknown,
): LimitResetInventory {
  if (raw === undefined || raw === null) {
    return { status: "unmeasurable", reason: "not_reported" };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const data = raw as Record<string, unknown>;
    if (
      data.status === "known" &&
      data.application === "on_demand" &&
      typeof data.availableCount === "number" &&
      Number.isSafeInteger(data.availableCount) &&
      data.availableCount >= 0
    ) {
      return {
        status: "known",
        availableCount: data.availableCount,
        application: "on_demand",
      };
    }
    if (
      data.status === "unmeasurable" &&
      (data.reason === "not_reported" || data.reason === "invalid_inventory")
    ) {
      return { status: "unmeasurable", reason: data.reason };
    }
  }
  return { status: "unmeasurable", reason: "invalid_inventory" };
}
