/** Parsed hour/minute pair. */
export interface HM {
  h: number;
  m: number;
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Parses a 24h 'HH:mm' string. Throws on malformed input. */
export function parseHM(hhmm: string): HM {
  const match = HHMM_RE.exec(hhmm.trim());
  if (!match) {
    throw new Error(`Invalid time '${hhmm}', expected 'HH:mm'`);
  }
  return { h: Number(match[1]), m: Number(match[2]) };
}

/** Formats an {h,m} pair back to 24h 'HH:mm'. */
export function formatHM({ h, m }: HM): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Converts 24h 'HH:mm' to the 12h 'h:mm AM/PM' shape Workday's time fields expect. */
export function to12Hour(hhmm: string): string {
  const { h, m } = parseHM(hhmm);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Today's date as LOCAL 'YYYY-MM-DD'. `new Date().toISOString()` reads the UTC calendar date,
 * which lags a full day behind local date during early-morning hours in positive-UTC-offset
 * zones (e.g. Asia/Jerusalem) — use this instead wherever "today" means the user's own calendar.
 */
export function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Computes worked hours between two 24h 'HH:mm' times, rounded to 1 decimal place. */
export function computeHours(inHHMM: string, outHHMM: string): number {
  const start = parseHM(inHHMM);
  const end = parseHM(outHHMM);
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;
  const diff = endMinutes - startMinutes;
  if (diff <= 0) {
    throw new Error(`Out time '${outHHMM}' must be after In time '${inHHMM}'`);
  }
  return Math.round((diff / 60) * 10) / 10;
}

/** Splits a time-of-day + ISO date into Workday's per-field {m,H,D,M,Y} form fields (Approach B). */
export function splitTimeParts(
  hhmm: string,
  isoDate: string,
): { m: string; H: string; D: string; M: string; Y: string } {
  const { h, m } = parseHM(hhmm);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) {
    throw new Error(`Invalid ISO date '${isoDate}', expected 'YYYY-MM-DD'`);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return {
    m: String(m).padStart(2, "0"),
    H: String(h).padStart(2, "0"),
    D: day,
    M: month,
    Y: year,
  };
}
