import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/core/settings";

describe("mergeSettings", () => {
  it("returns defaults when given nothing", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("overrides individual fields", () => {
    const merged = mergeSettings({ inTime: "08:00", dryRun: false });
    expect(merged.inTime).toBe("08:00");
    expect(merged.dryRun).toBe(false);
    expect(merged.outTime).toBe(DEFAULT_SETTINGS.outTime);
  });

  it("coerces numeric fields and falls back on invalid values", () => {
    expect(mergeSettings({ throttleMs: "1200" as unknown as number }).throttleMs).toBe(1200);
    expect(mergeSettings({ throttleMs: NaN }).throttleMs).toBe(DEFAULT_SETTINGS.throttleMs);
  });

  it("clamps numeric fields to their minimums", () => {
    expect(mergeSettings({ throttleMs: -500 }).throttleMs).toBe(0);
    expect(mergeSettings({ maxDaysPerRun: 0 }).maxDaysPerRun).toBe(1);
    expect(mergeSettings({ modalTimeoutMs: 10 }).modalTimeoutMs).toBe(1000);
  });

  it("ignores unknown keys", () => {
    const merged = mergeSettings({ notAField: "x" } as unknown as Record<string, unknown>);
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it("normalizes safeTestDate to null when not a string", () => {
    expect(mergeSettings({ safeTestDate: "2026-09-24" }).safeTestDate).toBe("2026-09-24");
    expect(mergeSettings({ safeTestDate: undefined }).safeTestDate).toBeNull();
  });
});
