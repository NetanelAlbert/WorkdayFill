import { todayLocalIso } from "./time";
import type { DayCell, FillOptions } from "./types";

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  includeWeekends: false,
  includeHolidays: false,
  // Workday's Enter Time is routinely pre-filled for the whole visible month ahead of time
  // (confirmed live: every weekday in the sampled month already had entries, including ones
  // well after the current date) — unlike a "log what you worked today" tool, future days
  // within the shown month are the normal case here, not an edge case to gate behind a flag.
  includeFuture: true,
  fromDate: null,
  toDate: null,
  today: todayLocalIso(),
};

/**
 * Pure predicate deciding whether a single day should be filled.
 * Mirrors HibobFill's needsAttendanceFilling: skip weekends, holidays, time off,
 * days that already have an entry, and spillover days outside the shown month.
 */
export function needsFill(day: DayCell, opts: FillOptions = DEFAULT_FILL_OPTIONS): boolean {
  if (!day.inMonth) return false;
  if (day.hasEntry) return false;
  if (day.isTimeOff) return false;
  if (day.isHoliday && !opts.includeHolidays) return false;
  if (day.isWeekend && !opts.includeWeekends) return false;
  if (!opts.includeFuture && day.date > opts.today) return false;
  if (opts.fromDate && day.date < opts.fromDate) return false;
  if (opts.toDate && day.date > opts.toDate) return false;
  return true;
}

/** Pure — filters a day list down to the dates that need filling, sorted ascending. */
export function computeMissingDays(
  days: DayCell[],
  opts: FillOptions = DEFAULT_FILL_OPTIONS,
): string[] {
  return days
    .filter((day) => needsFill(day, opts))
    .map((day) => day.date)
    .sort();
}
