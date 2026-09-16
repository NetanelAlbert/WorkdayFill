/** One calendar cell on the Enter Time page, reduced to plain data. */
export interface DayCell {
  /** ISO date, e.g. '2026-09-24'. */
  date: string;
  /** 0=Sun .. 6=Sat, derived from `date`. */
  dow: number;
  isWeekend: boolean;
  isHoliday: boolean;
  isTimeOff: boolean;
  /** Already has a "Hours Worked" (or equivalent) entry. */
  hasEntry: boolean;
  /** False for spillover days from adjacent months shown on the calendar grid. */
  inMonth: boolean;
  /**
   * Raw event count parsed from the cell's aria-label (e.g. "2 events" -> 2). Used to verify a
   * delete actually removed something on days that carry more than one event (e.g. a holiday
   * marker alongside a real Hours Worked entry) — `hasEntry` alone can't tell, since it stays
   * true as long as any non-boundary event remains.
   */
  eventCount: number;
}

export interface FillOptions {
  includeWeekends: boolean;
  includeHolidays: boolean;
  includeFuture: boolean;
  fromDate: string | null;
  toDate: string | null;
  /** ISO date treated as "today"; injected for deterministic tests. */
  today: string;
}

/**
 * Which fill strategy to use:
 *  - "dom":  drive the real Enter Time page (DomFillEngine, Approach A) — proven, but UI-coupled.
 *  - "flow": headless flowController replay (FlowReplayEngine, Approach B) — no UI, see RESEARCH.md §7.
 * Deletes always use the DOM engine regardless (headless delete isn't implemented).
 */
export type EngineKind = "dom" | "flow";

export interface Settings {
  inTime: string;
  outTime: string;
  timeType: string;
  comment: string;
  engine: EngineKind;
  dryRun: boolean;
  /** When set, only this date may be written to — a development safety rail. */
  safeTestDate: string | null;
  throttleMs: number;
  modalTimeoutMs: number;
  validateTimeoutMs: number;
  maxDaysPerRun: number;
}

export type FillStatus = "filled" | "skipped" | "dryRun" | "error";
export type DeleteStatus = "deleted" | "skipped" | "error";

export interface FillResult {
  date: string;
  status: FillStatus;
  message?: string;
}

export interface FillSummary {
  total: number;
  filled: number;
  skipped: number;
  failed: number;
  failures: { date: string; message: string }[];
  remaining: string[];
}

export interface DeleteResult {
  date: string;
  status: DeleteStatus;
  message?: string;
}

export interface DeleteSummary {
  total: number;
  deleted: number;
  skipped: number;
  failed: number;
  failures: { date: string; message: string }[];
  remaining: string[];
}

export interface PageInfo {
  isEnterTime: boolean;
  workerName: string | null;
  month: { label: string; year: number; monthIndex: number } | null;
}
