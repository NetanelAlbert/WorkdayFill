import { describe, expect, it } from "vitest";
import { dayOfWeek, readCell } from "../src/content/scan";

/** Minimal stand-in for the one DOM cell used by readCell: id + aria-label. */
function fakeCell(id: string, ariaLabel: string): Element {
  return {
    getAttribute(name: string) {
      if (name === "data-automation-id") return id;
      if (name === "aria-label") return ariaLabel;
      return null;
    },
  } as unknown as Element;
}

describe("dayOfWeek", () => {
  // Confirmed against the live Workday calendar (aria-labels), which is the ground truth for
  // these dates — this pins the regression where local-time parsing in a positive-UTC-offset
  // zone (e.g. Asia/Jerusalem) shifted every date's weekday back by one, letting a real Saturday
  // slip past the weekend check as a "missing" fillable day.
  it("matches the real calendar regardless of the test runner's local timezone", () => {
    expect(dayOfWeek("2026-09-01")).toBe(2); // Tuesday
    expect(dayOfWeek("2026-09-05")).toBe(6); // Saturday
    expect(dayOfWeek("2026-09-06")).toBe(0); // Sunday
    expect(dayOfWeek("2026-09-08")).toBe(2); // Tuesday
    expect(dayOfWeek("2026-09-16")).toBe(3); // Wednesday
    expect(dayOfWeek("2026-09-27")).toBe(0); // Sunday
  });
});

describe("readCell — hasEntry across Workday's responsive layouts", () => {
  // Confirmed live: the "Large" (wide viewport) layout states hours explicitly; "Medium"
  // (narrower, e.g. DevTools docked) drops the hours from aria-label entirely but still says
  // "N event(s)" and still names non-work markers like "Time Period End". A day counts as
  // hasEntry only when it has an event AND that event isn't just a Time Period End marker —
  // that's the one rule confirmed to hold in both layouts.
  it("detects a worked day under the Large layout (states Hours explicitly)", () => {
    const cell = fakeCell("calendarDateCell-8-1", "Tuesday, September 1, 2026 | 1 event | Hours: 8.6");
    expect(readCell(cell, 8, 2026)?.hasEntry).toBe(true);
  });

  it("detects a worked day under the Medium layout (no Hours in aria-label)", () => {
    const cell = fakeCell("calendarDateCell-8-1", "Tuesday, September 1, 2026 | 1 event");
    expect(readCell(cell, 8, 2026)?.hasEntry).toBe(true);
  });

  it("does not treat a pure Time Period End marker (its only event) as an entry", () => {
    const cell = fakeCell("calendarDateCell-7-31", "Monday, August 31, 2026 | 1 event | Time Period End");
    expect(readCell(cell, 8, 2026)?.hasEntry).toBe(false);
  });

  // Regression: a day can carry the Time Period End boundary marker AND a real Hours Worked
  // entry side by side ("2 events | Time Period End" — the plain hours entry still isn't named,
  // same as the single-event case above). Checking for the substring "Time Period End" alone
  // wrongly called this day empty and sent the fill engine to open it, which timed out because
  // an already-filled day navigates to a detail view instead of the Enter Time modal.
  it("still detects a real entry on a day that also has a Time Period End marker", () => {
    const cell = fakeCell("calendarDateCell-8-30", "Wednesday, September 30, 2026 | 2 events | Time Period End");
    expect(readCell(cell, 8, 2026)?.hasEntry).toBe(true);
  });

  it("treats a genuinely empty day as having no entry", () => {
    const cell = fakeCell("calendarDateCell-8-4", "Friday, September 4, 2026");
    expect(readCell(cell, 8, 2026)?.hasEntry).toBe(false);
  });
});
