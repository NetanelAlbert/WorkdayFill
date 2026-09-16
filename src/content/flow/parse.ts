/**
 * Pure parsing/encoding helpers for the headless "flow replay" engine (Approach B).
 *
 * None of these touch the DOM, the network, or `window` — they take strings (Workday's JSON/HTML
 * responses) and produce plain data, so they are unit-tested in isolation (see test/flow-parse.test.ts),
 * exactly like the `src/core/` logic. Every Workday-specific shape here was captured live and is
 * documented in RESEARCH.md §7; keep this file and §7 in sync when Workday's payloads change.
 */

import { splitTimeParts, todayLocalIso } from "../../core/time";

/** One calendar-model day cell reduced to what the flow engine needs. */
export interface ModelDay {
  /** ISO date, e.g. '2026-09-24'. */
  date: string;
  /** Worked hours the model reports for the day (0 when empty). Used to confirm a write committed. */
  totalHours: number;
  /**
   * The per-cell "Enter Time" open action URI (no `.htmld` suffix), e.g. `/axon/button/c0/454/1320`.
   * Regenerated on every calendar render, so it is only valid for the model fetch it came from.
   * Null if the cell has no Enter Time action (spillover/locked days).
   */
  openUri: string | null;
}

/** The dynamic ids the write steps need, all parsed from the open-dialog response (RESEARCH.md §7.1). */
export interface OpenFlow {
  /** Spring-WebFlow instance key, e.g. `e5s1`. Shared across validate/submit for this dialog. */
  flowKey: string;
  /** Time-field id prefix, e.g. `1097` (fields are `1097/wd:In_Time`, `1097/wd:Out_Time`). */
  fieldPrefix: string;
  /** OK button ref, e.g. `1122/wd:OK`. */
  okRef: string;
  /** `_eventId_submit` value — the sequence container id wrapping OK, e.g. `1125`. */
  submitId: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Extracts the `X-Workday-Client` version (e.g. `2026.37.31`) from the page HTML. Workday sets an
 * inline `workday.clientVersion = 'Workday/2026.37.31 (HTML5)'`; the request header uses just the
 * numeric version. Readable from the isolated content-script world (it's in the DOM), so no
 * MAIN-world access to `window.workday` is needed (RESEARCH.md §7.3).
 */
export function extractClientVersion(pageHtml: string): string | null {
  const explicit = /clientVersion\s*=\s*['"]Workday\/(\d{4}\.\d+(?:\.\d+)?)/.exec(pageHtml);
  if (explicit) return explicit[1]!;
  const loose = /Workday\/(\d{4}\.\d+\.\d+)/.exec(pageHtml);
  return loose ? loose[1]! : null;
}

/** Extracts the 36-char `sessionSecureToken` from any Workday JSON response (RESEARCH.md §7.3). */
export function extractSessionSecureToken(json: string): string | null {
  const m = /"sessionSecureToken":"([0-9a-f-]{36})"/i.exec(json);
  return m ? m[1]! : null;
}

/** Parses 'Weekday, Month D, YYYY' (Workday's `formattedDateFull`) into an ISO 'YYYY-MM-DD' date. */
export function parseFormattedDateFull(full: string): string | null {
  const m = /([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(full);
  if (!m) return null;
  const monthIndex = MONTH_NAMES.findIndex((name) => name === m[1]);
  if (monthIndex < 0) return null;
  return `${m[3]}-${String(monthIndex + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}

/**
 * Walks the calendar-model JSON into a per-day list. Each grid cell is an object carrying a
 * `formattedDateFull` (the date), a `totalForDay` (worked hours), and — nested in its children — a
 * `commandButton` whose `label` is "Enter Time" and whose `values[0].uri` is the day's open action.
 *
 * The action appears twice per cell under two mirror groups (the two calendar layouts), e.g.
 * `/axon/button/c13/450/1298` and `/axon/button/c13/456/1298`. The context (`c13`) and group numbers
 * vary per model fetch and tenant, and **both URIs open the same dialog** (verified live), so we take
 * the first one and never hard-code the numbers (RESEARCH.md §7.2).
 */
export function parseCalendarDays(modelJson: string): ModelDay[] {
  let model: unknown;
  try {
    model = JSON.parse(modelJson);
  } catch {
    return [];
  }

  const days: ModelDay[] = [];
  const seen = new Set<string>();

  const firstEnterTimeUri = (cell: Record<string, unknown>): string | null => {
    let found: string | null = null;
    const inner = (node: unknown): void => {
      if (found || node == null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(inner);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (obj.label === "Enter Time" && Array.isArray(obj.values)) {
        const uri = (obj.values[0] as { uri?: unknown } | undefined)?.uri;
        if (typeof uri === "string" && /\/axon\/button\//.test(uri)) {
          found = uri;
          return;
        }
      }
      for (const key of Object.keys(obj)) {
        if (found) return;
        if (key !== "formattedDateFull") inner(obj[key]);
      }
    };
    inner(cell);
    return found;
  };

  const walk = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    const formatted = obj.formattedDateFull as { value?: unknown } | undefined;
    if (formatted && typeof formatted.value === "string") {
      const date = parseFormattedDateFull(formatted.value);
      if (date && !seen.has(date)) {
        seen.add(date);
        const total = (obj.totalForDay as { value?: unknown } | undefined)?.value;
        days.push({
          date,
          totalHours: typeof total === "number" ? total : Number(total) || 0,
          openUri: firstEnterTimeUri(obj),
        });
      }
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };

  walk(model);
  return days;
}

/** Builds a `date -> openUri` map from parsed model days, skipping days without an open action. */
export function buildDateToOpenUri(days: ModelDay[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const day of days) {
    if (day.openUri && !map.has(day.date)) map.set(day.date, day.openUri);
  }
  return map;
}

/**
 * Pulls the dynamic flow ids out of the open-dialog response JSON (RESEARCH.md §7.1). Located by
 * structural shape (`wd:In_Time`, `wd:OK`, the `nyw:sequence` container), not by their tenant-specific
 * numbers, so a tenant/version change that renumbers them still resolves. Returns null if the response
 * isn't a recognizable Enter Time dialog (e.g. Workday returned an error page instead).
 */
export function parseOpenResponse(json: string): OpenFlow | null {
  const flowKey = /"flowExecutionKey":"([^"]+)"/.exec(json)?.[1];
  const fieldPrefix = /"id":"(\d+)\/wd:In_Time"/.exec(json)?.[1];
  const okRef = /"id":"(\d+\/wd:OK)"/.exec(json)?.[1];
  if (!flowKey || !fieldPrefix || !okRef) return null;

  // The submit event id is the id of the sequence container that wraps the OK button bar: the first
  // `}],"id":"<n>","propertyName":"nyw:sequen…"` after the OK ref. Matched positionally (nearest after
  // OK) rather than by an exact propertyName so a minor suffix change still resolves.
  const escaped = okRef.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const submitId = new RegExp(`${escaped}"[\\s\\S]*?\\}\\],"id":"(\\d+)","propertyName":"nyw:sequen`).exec(json)?.[1];
  if (!submitId) return null;

  return { flowKey, fieldPrefix, okRef, submitId };
}

/**
 * Builds the per-field params for a validate step (RESEARCH.md §7.5). The event value is the field id
 * itself (`_eventId_validate=1097/wd:In_Time`). Only the time-of-day matters; the D/M/Y come out as
 * "today" in the real UI and are ignored server-side (the entry's date is bound to the flow instance),
 * so we send today's parts to match observed traffic exactly.
 */
export function buildValidateParams(
  fieldPrefix: string,
  field: "In" | "Out",
  hhmm: string,
  today: string = todayLocalIso(),
): Record<string, string> {
  const parts = splitTimeParts(hhmm, today);
  const key = `${fieldPrefix}/wd:${field}_Time`;
  return {
    [`${key}_m`]: parts.m,
    [`${key}_H`]: parts.H,
    [`${key}_D`]: parts.D,
    [`${key}_M`]: parts.M,
    [`${key}_Y`]: parts.Y,
    _eventId_validate: key,
  };
}

/** The submit `change-summary` XML — records only the OK press; field values were applied by validate. */
export function buildChangeSummary(okRef: string): string {
  return (
    '<wml:Change_Summary xmlns:wml="http://www.workday.com/ns/model/1.0" ' +
    'xmlns:wd="urn:com.workday/bsvc" xmlns:nyw="urn:com.netyourwork/aod">' +
    `<wd:OK Ref="${okRef}" Replaced=""><V>1</V></wd:OK></wml:Change_Summary>`
  );
}

/** Builds the submit (OK) params (RESEARCH.md §7.5). */
export function buildSubmitParams(flow: OpenFlow): Record<string, string> {
  return {
    _eventId_submit: flow.submitId,
    "change-summary": buildChangeSummary(flow.okRef),
  };
}

/**
 * Heuristic: does a flowController response report a validation error? Workday returns errors as
 * `messageType:"ERROR"` / `errorLevel` / a `validationError` widget. A clean validate does not. Kept
 * conservative (only clear error markers) so a normal response is never misread as a failure.
 */
export function hasFlowError(responseText: string): boolean {
  return /"messageType":"ERROR"|"errorLevel"|"widget":"validationError"/i.test(responseText);
}
