import { describe, expect, it } from "vitest";
import { computeMissingDays, needsFill } from "../src/core/missing-days";
import type { DayCell, FillOptions } from "../src/core/types";

function day(overrides: Partial<DayCell> = {}): DayCell {
  return {
    date: "2026-09-24",
    dow: 4,
    isWeekend: false,
    isHoliday: false,
    isTimeOff: false,
    hasEntry: false,
    inMonth: true,
    eventCount: 0,
    ...overrides,
  };
}

function options(overrides: Partial<FillOptions> = {}): FillOptions {
  return {
    includeWeekends: false,
    includeHolidays: false,
    includeFuture: false,
    fromDate: null,
    toDate: null,
    today: "2026-09-30",
    ...overrides,
  };
}

describe("needsFill", () => {
  it("fills a plain empty past weekday", () => {
    expect(needsFill(day(), options())).toBe(true);
  });

  it("skips spillover days outside the shown month", () => {
    expect(needsFill(day({ inMonth: false }), options())).toBe(false);
  });

  it("skips days that already have an entry", () => {
    expect(needsFill(day({ hasEntry: true }), options())).toBe(false);
  });

  it("skips approved time off", () => {
    expect(needsFill(day({ isTimeOff: true }), options())).toBe(false);
  });

  it("skips holidays by default but includes them when opted in", () => {
    const holiday = day({ isHoliday: true });
    expect(needsFill(holiday, options())).toBe(false);
    expect(needsFill(holiday, options({ includeHolidays: true }))).toBe(true);
  });

  it("skips weekends by default but includes them when opted in", () => {
    const weekend = day({ isWeekend: true, dow: 6 });
    expect(needsFill(weekend, options())).toBe(false);
    expect(needsFill(weekend, options({ includeWeekends: true }))).toBe(true);
  });

  it("skips future days by default but includes them when opted in", () => {
    const future = day({ date: "2026-10-01" });
    expect(needsFill(future, options({ today: "2026-09-30" }))).toBe(false);
    expect(needsFill(future, options({ today: "2026-09-30", includeFuture: true }))).toBe(true);
  });

  it("respects fromDate/toDate bounds", () => {
    const target = day({ date: "2026-09-15" });
    expect(needsFill(target, options({ fromDate: "2026-09-16" }))).toBe(false);
    expect(needsFill(target, options({ toDate: "2026-09-14" }))).toBe(false);
    expect(needsFill(target, options({ fromDate: "2026-09-01", toDate: "2026-09-30" }))).toBe(true);
  });
});

describe("computeMissingDays", () => {
  it("returns an empty array for an empty input", () => {
    expect(computeMissingDays([], options())).toEqual([]);
  });

  it("filters and sorts a realistic month", () => {
    const days: DayCell[] = [
      day({ date: "2026-09-01", isWeekend: true, dow: 2 }),
      day({ date: "2026-09-05", isHoliday: true, dow: 6 }),
      day({ date: "2026-09-10", hasEntry: true, dow: 4 }),
      day({ date: "2026-09-15", isTimeOff: true, dow: 2 }),
      day({ date: "2026-09-24", dow: 4 }),
      day({ date: "2026-09-23", dow: 3 }),
      day({ date: "2026-10-01", inMonth: false, dow: 4 }),
    ];
    expect(computeMissingDays(days, options({ today: "2026-09-30" }))).toEqual([
      "2026-09-23",
      "2026-09-24",
    ]);
  });
});
