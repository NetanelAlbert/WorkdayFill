import type { Settings } from "./types";

/**
 * The throttle default shipped before the delay was reduced. Existing users still sitting on this
 * (i.e. never changed it from the old default) are migrated once to the new default on load; anyone
 * who deliberately set a value keeps it. See the one-time migration in popup.ts.
 */
export const LEGACY_DEFAULT_THROTTLE_MS = 800;

export const DEFAULT_SETTINGS: Settings = {
  inTime: "09:00",
  outTime: "17:36",
  timeType: "Hours Worked",
  comment: "",
  // Default to the headless "flow" engine (no page automation — RESEARCH.md §7); users can fall back
  // to the visible DOM engine if headless can't reach Workday's data.
  engine: "flow",
  dryRun: false,
  safeTestDate: null,
  // Small gap between days — enough to be gentle on the server; the flow engine has no UI to settle
  // and paces itself on network round-trips, so it doesn't need more. Users can raise or zero it.
  throttleMs: 100,
  modalTimeoutMs: 8000,
  validateTimeoutMs: 6000,
  maxDaysPerRun: 40,
};

function clampNumber(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

/** Merges partial/stored settings over the defaults, coercing and clamping numeric fields. */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const s = stored ?? {};
  return {
    inTime: typeof s.inTime === "string" ? s.inTime : DEFAULT_SETTINGS.inTime,
    outTime: typeof s.outTime === "string" ? s.outTime : DEFAULT_SETTINGS.outTime,
    timeType: typeof s.timeType === "string" ? s.timeType : DEFAULT_SETTINGS.timeType,
    comment: typeof s.comment === "string" ? s.comment : DEFAULT_SETTINGS.comment,
    engine: s.engine === "flow" || s.engine === "dom" ? s.engine : DEFAULT_SETTINGS.engine,
    dryRun: typeof s.dryRun === "boolean" ? s.dryRun : DEFAULT_SETTINGS.dryRun,
    safeTestDate: typeof s.safeTestDate === "string" ? s.safeTestDate : null,
    throttleMs: clampNumber(s.throttleMs, DEFAULT_SETTINGS.throttleMs, 0),
    modalTimeoutMs: clampNumber(s.modalTimeoutMs, DEFAULT_SETTINGS.modalTimeoutMs, 1000),
    validateTimeoutMs: clampNumber(s.validateTimeoutMs, DEFAULT_SETTINGS.validateTimeoutMs, 500),
    maxDaysPerRun: clampNumber(s.maxDaysPerRun, DEFAULT_SETTINGS.maxDaysPerRun, 1),
  };
}
