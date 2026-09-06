import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  inTime: "09:00",
  outTime: "17:36",
  timeType: "Hours Worked",
  comment: "",
  dryRun: true,
  safeTestDate: null,
  throttleMs: 800,
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
    dryRun: typeof s.dryRun === "boolean" ? s.dryRun : DEFAULT_SETTINGS.dryRun,
    safeTestDate: typeof s.safeTestDate === "string" ? s.safeTestDate : null,
    throttleMs: clampNumber(s.throttleMs, DEFAULT_SETTINGS.throttleMs, 0),
    modalTimeoutMs: clampNumber(s.modalTimeoutMs, DEFAULT_SETTINGS.modalTimeoutMs, 1000),
    validateTimeoutMs: clampNumber(s.validateTimeoutMs, DEFAULT_SETTINGS.validateTimeoutMs, 500),
    maxDaysPerRun: clampNumber(s.maxDaysPerRun, DEFAULT_SETTINGS.maxDaysPerRun, 1),
  };
}
