import { describe, expect, it } from "vitest";
import { computeHours, formatHM, parseHM, splitTimeParts, to12Hour } from "../src/core/time";

describe("parseHM", () => {
  it("parses a valid 24h time", () => {
    expect(parseHM("09:00")).toEqual({ h: 9, m: 0 });
    expect(parseHM("23:59")).toEqual({ h: 23, m: 59 });
    expect(parseHM("00:00")).toEqual({ h: 0, m: 0 });
  });

  it("throws on malformed input", () => {
    expect(() => parseHM("24:00")).toThrow();
    expect(() => parseHM("9:0")).toThrow();
    expect(() => parseHM("not-a-time")).toThrow();
  });
});

describe("formatHM", () => {
  it("pads to two digits", () => {
    expect(formatHM({ h: 9, m: 0 })).toBe("09:00");
    expect(formatHM({ h: 17, m: 36 })).toBe("17:36");
  });
});

describe("to12Hour", () => {
  it("converts morning times", () => {
    expect(to12Hour("09:00")).toBe("9:00 AM");
  });

  it("converts afternoon/evening times", () => {
    expect(to12Hour("17:36")).toBe("5:36 PM");
  });

  it("handles noon and midnight edges", () => {
    expect(to12Hour("12:00")).toBe("12:00 PM");
    expect(to12Hour("00:00")).toBe("12:00 AM");
  });
});

describe("computeHours", () => {
  it("computes the standard workday pattern", () => {
    expect(computeHours("09:00", "17:36")).toBe(8.6);
  });

  it("rounds to one decimal place", () => {
    expect(computeHours("09:00", "17:35")).toBe(8.6);
  });

  it("throws when out is not after in", () => {
    expect(() => computeHours("17:00", "09:00")).toThrow();
    expect(() => computeHours("09:00", "09:00")).toThrow();
  });
});

describe("splitTimeParts", () => {
  it("splits time-of-day and date into Workday's field shape", () => {
    expect(splitTimeParts("09:00", "2026-09-24")).toEqual({
      m: "00",
      H: "09",
      D: "24",
      M: "09",
      Y: "2026",
    });
  });

  it("throws on a malformed ISO date", () => {
    expect(() => splitTimeParts("09:00", "not-a-date")).toThrow();
  });
});
