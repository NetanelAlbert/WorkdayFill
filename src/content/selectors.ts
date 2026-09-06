/**
 * Central map of Workday `data-automation-id` hooks used by the DOM automation engine.
 *
 * Discovered live against a real Enter Time page (September 2026, Axon tenant), then the full
 * fill flow (open -> set In/Out -> validate -> OK -> commit) was verified end-to-end with one real
 * save on Sep 28, 2026: the entry landed correctly (8.6h, "Not Submitted") and the month summary's
 * Total Hours/Regular/error count all updated as expected. Workday's automation-ids are more stable
 * than its obfuscated CSS classes, but they still vary by tenant/version. This file is the single
 * place to patch when Workday's markup changes; entries marked UNVERIFIED were not confirmed
 * against a live example (e.g. no Time Off day existed in the sampled month) and may need adjustment.
 */
export const SELECTORS = {
  // Page detection. Workday swaps the month-grid container by viewport width — confirmed live:
  // "calendarMonthLarge" at wide viewports, "calendarMonthMedium" once the window narrows (e.g.
  // DevTools docked to the side), presumably "calendarMonthSmall" narrower still. The day cells
  // underneath (calendarDateCell-*) are identical across all of them, so match by prefix instead
  // of a single exact size to avoid re-breaking every time the window is resized.
  enterTimeRoot: '[data-automation-id^="calendarMonth"]',
  workerName: '[data-automation-id="hammy_current_user_item"]',
  monthHeader: '[data-automation-id="dateRangeTitle"]',
  calendarGrid: '[data-automation-id^="calendarMonth"]',

  // Day cells: id is 'calendarDateCell-{monthIndex0Based}-{day}' — the date is parsed from the id
  // itself (see scan.ts), not from a separate attribute. Classification comes entirely from the
  // cell's aria-label, e.g.:
  //   "Friday, September 4, 2026"                                    -> empty weekday
  //   "Monday, September 14, 2026 | 1 event | Hours: 8.6"            -> has a worked-hours entry
  //   "Holiday Sunday, September 20, 2026 | 2 events | Yom Kippur | Hours: 8.6" -> holiday
  //   "Wednesday, September 30, 2026 | 1 event | Time Period End"    -> boundary marker, still fillable
  dayCells: '[data-automation-id^="calendarDateCell-"]',
  cellIdPrefix: "calendarDateCell-",
  /** UNVERIFIED — no Time Off day existed in the sampled month; adjust once a real example is seen. */
  timeOffAriaKeywords: ["Time Off", "PTO", "Vacation", "Personal Time", "Sick"],

  // "Enter Time" modal
  modal: '[data-automation-id="popUpDialog"]',
  modalTimeType: '[data-automation-id="multiSelectContainer"] [data-automation-id="selectedItem"]',
  /** Both In and Out share this automation-id; DOM order distinguishes them (index 0 = In, 1 = Out). */
  modalTimeInputs: '[data-automation-id="standaloneTimeWidget"] input',
  modalHours: '[data-automation-id="numericText"]',
  modalComment: '[data-automation-id="textArea"] textarea',
  /** Shares an automation-id with icon-only buttons inside the time widgets; filter by text "OK". */
  modalCommandButtons: '[data-automation-id="wd-CommandButton"]',
  modalCancel: '[data-automation-id="wd-CommandButton_uic_cancelButton"]',
  modalClose: '[data-automation-id="closeButton"]',
  /**
   * Confirmed live: cancelling a dirty form (fields typed but not saved) pops a SECOND "Discard
   * Changes?" confirmation on top of the modal — it reuses the same `popUpDialog` automation-id
   * as the Enter Time modal itself, so `[data-automation-id="popUpDialog"]` can momentarily match
   * two stacked elements. This is the "Discard" button's distinct id.
   */
  discardChangesYes: '[data-automation-id="wd-CommandButton_uic_genericYesButton"]',
  /**
   * Confirmed live: opening a cell that has ANY existing event — even just the non-hours
   * "Time Period End" boundary marker, with no real entry at all — navigates to a day-DETAIL
   * page instead of opening the Enter Time modal directly. Only a truly empty cell (zero events)
   * opens the modal straight from the calendar. The detail page has its own "Enter Time" button
   * (same shared `wd-CommandButton` id as everything else; filter by text) that opens the modal
   * from there.
   */
  detailPageCommandButtons: '[data-automation-id="wd-CommandButton"]',

  /**
   * Delete flow, confirmed live end-to-end with zero real (trusted) clicks required — every step
   * responds to a synthetic pointerdown/mousedown/pointerup/mouseup/click sequence. A cell with an
   * existing entry shows this "more" chevron; clicking it opens a small popover listing that day's
   * events (holiday markers, Time Period End, and/or a real "Hours Worked" entry). Shares its
   * automation-id across every day cell — must be matched to the target cell by position.
   */
  dayChevron: '[data-automation-id="calendarMoreLink"]',
  /** The popover's own close (X) button — its parent element is the popover's scope. */
  popoverCloseButton: '[data-automation-id="closeButton"]',
  /**
   * An entry row inside an open popover. CRITICAL: this automation-id is shared by EVERY entry
   * chip across the entire calendar grid, not just the open popover's — `document.querySelector`
   * on this alone silently grabs an unrelated entry elsewhere on the page. Always scope the query
   * to the popover container (see findPopoverEntries) before matching, never search document-wide.
   */
  popoverEntry: '[data-automation-id="calendarevent"]',

  // Feedback
  /** UNVERIFIED — a real save (Sep 28, 2026 test) completed and dismissed before this could be
   *  captured. Not load-bearing: modal-gone + re-scanned cell.hasEntry is the CONFIRMED primary
   *  commit signal (verified live — see README "Live-testing safety" / verification log). This
   *  stays a best-effort secondary check only. */
  toast: '[data-automation-id="wd-ToastNotification"], [data-automation-id="successBanner"]',
  validationError: '[data-automation-id="wd-ValidationErrorMessage"], [data-automation-id="errorPanel"]',
  /** CONFIRMED live during the Sep 28, 2026 real-save test — this element appears during the
   *  post-OK page refresh. */
  busySpinner: '[data-automation-id="wd-LoadingPanel"]',
} as const;

export const TOAST_SAVED_TEXT = "Your changes have been saved";

/** Selectors that MUST resolve for the engine to operate at all. */
const CRITICAL: readonly [key: string, selector: string][] = [
  ["enterTimeRoot", SELECTORS.enterTimeRoot],
  ["calendarGrid", SELECTORS.calendarGrid],
  ["dayCells", SELECTORS.dayCells],
];

export interface SelectorValidation {
  ok: boolean;
  missing: string[];
}

/**
 * Checks that the critical selectors resolve against the live DOM. Called before any RPC handler
 * runs so a Workday UI change surfaces as a clear "needs updating" error instead of a silent no-op.
 */
export function validateSelectors(doc: Document = document): SelectorValidation {
  const missing = CRITICAL.filter(([, selector]) => {
    try {
      return doc.querySelector(selector) === null;
    } catch {
      return true;
    }
  }).map(([key]) => key);
  return { ok: missing.length === 0, missing };
}

/** Finds the OK button among the shared-id command buttons by its visible text. */
export function findOkButton(root: ParentNode): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(SELECTORS.modalCommandButtons)) {
    if (el.textContent?.trim() === "OK") return el;
  }
  return null;
}

/** Finds a day-detail page's "Enter Time" button, if one is present (see detailPageCommandButtons). */
export function findEnterTimeButton(doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>(SELECTORS.detailPageCommandButtons)) {
    if (el.textContent?.trim() === "Enter Time") return el;
  }
  return null;
}

/** Finds a button by its exact visible text, anywhere under `root`. */
export function findButtonByText(root: ParentNode, text: string): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>("button")) {
    if (el.textContent?.trim() === text) return el;
  }
  return null;
}

/**
 * Finds the "more" chevron for a specific day cell by position (matched by horizontal overlap
 * with the cell and vertical proximity below it) — confirmed live, `dayChevron`'s automation-id is
 * shared by every cell, so there is no direct id-based way to target one day's chevron.
 */
export function findChevronForCell(cellEl: Element, doc: Document): HTMLElement | null {
  const r = cellEl.getBoundingClientRect();
  for (const el of doc.querySelectorAll<HTMLElement>(SELECTORS.dayChevron)) {
    const er = el.getBoundingClientRect();
    const cx = er.left + er.width / 2;
    if (cx >= r.left && cx <= r.right && er.top >= r.top && er.top <= r.bottom + 40) {
      return el;
    }
  }
  return null;
}

/**
 * Returns the entry rows inside a currently-open popover, scoped via the popover's own close
 * button — never search `popoverEntry` document-wide (see its comment above).
 */
export function findPopoverEntries(doc: Document): HTMLElement[] {
  const closeBtn = doc.querySelector<HTMLElement>(SELECTORS.popoverCloseButton);
  const popover = closeBtn?.parentElement;
  if (!popover) return [];
  return [...popover.querySelectorAll<HTMLElement>(SELECTORS.popoverEntry)];
}
