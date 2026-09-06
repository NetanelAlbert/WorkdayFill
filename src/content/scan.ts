import type { DayCell } from "../core/types";
import { detectPage } from "./page";
import { SELECTORS } from "./selectors";

const CELL_ID_RE = /^calendarDateCell-(\d{1,2})-(\d{1,2})$/;

/**
 * Computes day-of-week from an ISO date without going through local-time parsing.
 * `new Date(\`${iso}T00:00:00\`)` parses as LOCAL time — in a positive UTC-offset zone
 * (e.g. Asia/Jerusalem, UTC+3) `.getUTCDay()` on that then reads back the PREVIOUS day's
 * weekday, silently shifting every date's weekend/weekday classification by one. Confirmed
 * live: this let a real Saturday slip past the weekend check as a "missing" fillable day.
 * Building the Date directly from UTC components sidesteps local-time parsing entirely.
 */
export function dayOfWeek(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

function toIsoDate(year: number, monthIndex0: number, day: number): string {
  const y = String(year).padStart(4, "0");
  const m = String(monthIndex0 + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Resolves the calendar year for a cell's embedded month index, handling the December/January
 * spillover: a cell one or more months "behind" the displayed month while viewing January belongs
 * to the previous year, and a cell "ahead" while viewing December belongs to the next year.
 */
function resolveYear(cellMonthIndex: number, displayedMonthIndex: number, displayedYear: number): number {
  if (displayedMonthIndex === 0 && cellMonthIndex === 11) return displayedYear - 1;
  if (displayedMonthIndex === 11 && cellMonthIndex === 0) return displayedYear + 1;
  return displayedYear;
}

/**
 * Reads one calendar cell element into a plain DayCell using its id (for the date) and its
 * aria-label (for classification — Workday encodes holiday/hours/event info there). Returns null
 * if the id doesn't match the expected shape, so callers can skip it rather than crash the scan.
 */
export function readCell(el: Element, displayedMonthIndex: number, displayedYear: number): DayCell | null {
  const id = el.getAttribute("data-automation-id") ?? "";
  const match = CELL_ID_RE.exec(id);
  if (!match) return null;

  const cellMonthIndex = Number(match[1]);
  const day = Number(match[2]);
  const year = resolveYear(cellMonthIndex, displayedMonthIndex, displayedYear);
  const date = toIsoDate(year, cellMonthIndex, day);
  const dow = dayOfWeek(date);

  const ariaLabel = el.getAttribute("aria-label") ?? "";
  const isHoliday = ariaLabel.startsWith("Holiday ");
  const isTimeOff = SELECTORS.timeOffAriaKeywords.some((keyword) => ariaLabel.includes(keyword));
  // Workday's OWN responsive layouts disagree on what the aria-label contains: the wide
  // ("Large") calendar states worked hours explicitly ("1 event | Hours: 8.6"), but the
  // narrower ("Medium") layout drops the hours entirely and says only "1 event" — confirmed
  // live, this silently broke hasEntry detection for every filled day once the window narrowed
  // (e.g. from docking DevTools). Non-hours markers ("Time Period End") are still named in both
  // layouts, but a "Time Period End" day can ALSO carry a real Hours Worked entry alongside it
  // (confirmed live: "2 events | Time Period End" on a day that has both the boundary marker AND
  // 8.6 real hours — the plain Hours Worked event still isn't named, exactly like the plain
  // single-event case). So "mentions Time Period End" alone is not enough to call a day empty —
  // only a day whose ONLY event is that marker (count === 1) is genuinely still fillable.
  const eventCountMatch = /\|\s*(\d+)\s*events?\b/.exec(ariaLabel);
  const eventCount = eventCountMatch ? Number(eventCountMatch[1]) : 0;
  const isPureTimePeriodEnd = eventCount === 1 && ariaLabel.includes("Time Period End");
  const hasEntry = eventCount > 0 && !isPureTimePeriodEnd;

  return {
    date,
    dow,
    // Friday/Saturday, not Sunday/Saturday — confirmed against the live calendar (Asia/Jerusalem
    // tenant): every Sunday has a real "Hours Worked" entry, Fridays/Saturdays never do.
    isWeekend: dow === 5 || dow === 6,
    isHoliday,
    isTimeOff,
    hasEntry,
    inMonth: cellMonthIndex === displayedMonthIndex,
    eventCount,
  };
}

/**
 * Scans the visible Enter Time calendar into plain data. Never holds element references beyond
 * this call — the calendar re-renders after every save, so callers must re-scan between fills.
 */
export function scanCalendar(doc: Document = document): DayCell[] {
  const { month } = detectPage(doc);
  if (!month || month.monthIndex < 0) return [];

  const cells: DayCell[] = [];
  for (const el of doc.querySelectorAll(SELECTORS.dayCells)) {
    const cell = readCell(el, month.monthIndex, month.year);
    if (cell) cells.push(cell);
  }
  return cells;
}

/**
 * Finds the live cell element for an ISO date. Must be re-queried after every re-render — the
 * calendar rebuilds its DOM on every save, so callers should never cache the returned element.
 */
export function findCellElementForDate(date: string, doc: Document = document): Element | null {
  const { month } = detectPage(doc);
  if (!month || month.monthIndex < 0) return null;

  for (const el of doc.querySelectorAll(SELECTORS.dayCells)) {
    const cell = readCell(el, month.monthIndex, month.year);
    if (cell?.date === date) return el;
  }
  return null;
}
