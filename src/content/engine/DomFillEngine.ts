import { computeHours, todayLocalIso } from "../../core/time";
import { computeMissingDays, DEFAULT_FILL_OPTIONS } from "../../core/missing-days";
import type { FillResult, FillSummary, PageInfo, Settings } from "../../core/types";
import {
  fireCellOpen,
  fireCellSelect,
  setTextField,
  setTimeField,
  sleep,
  waitForElement,
  waitForGone,
  waitForText,
} from "../dom";
import { detectPage as detectPageDom } from "../page";
import { findCellElementForDate, scanCalendar } from "../scan";
import { findEnterTimeButton, findOkButton, SELECTORS, TOAST_SAVED_TEXT } from "../selectors";
import type { FillEngine } from "./FillEngine";

/**
 * Opening the "Enter Time" dialog is a two-step interaction: the cell must first be
 * selected/focused (data-automation-selected flips to "true"), then a second interaction opens
 * the modal. Confirmed live, twice: plain `el.click()` doesn't even select the cell (Workday's
 * widget listens lower in the event pipeline than a bare 'click'), and once selected, a second
 * full click alone still isn't enough — an explicit 'dblclick' event is what actually opens it.
 * See fireCellSelect/fireCellOpen in dom.ts. Do not "simplify" this back to `.click()`.
 *
 * The cell is re-queried by date before the second interaction rather than reusing the first
 * click's element reference, since the calendar can re-render between the two and a stale
 * reference could end up targeting the wrong cell. Defense in depth alongside fillDay's post-open
 * empty-field guard below.
 *
 * A cell with ANY existing event — even just the non-hours "Time Period End" boundary marker —
 * navigates to a day-DETAIL page instead of opening the modal directly (confirmed live: deleting
 * a real entry back down to just that marker reproduced it). Only a truly empty cell (zero
 * events) opens the modal straight from the calendar. So after the open interaction, this races
 * the modal against that detail page's own "Enter Time" button and clicks through it if needed.
 */
async function openCell(date: string, doc: Document): Promise<void> {
  const first = findCellElementForDate(date, doc);
  if (!first) throw new Error("day cell element not found");
  fireCellSelect(first);
  await sleep(200);
  const second = findCellElementForDate(date, doc) ?? first;
  fireCellOpen(second);

  try {
    await waitForElement(SELECTORS.modal, { root: doc, timeout: 2000 });
    return;
  } catch {
    // Didn't open directly — check whether we landed on a detail page instead.
  }

  const enterTimeButton = findEnterTimeButton(doc);
  if (!enterTimeButton) {
    throw new Error("modal did not open, and no 'Enter Time' button was found on a detail page");
  }
  enterTimeButton.click();
}

/**
 * Clicks the modal's Cancel button and, if Workday's own "Discard Changes?" confirmation pops up
 * on top of it, confirms that too. Confirmed live: that confirmation only appears once a field
 * has actually been edited (a clean, untouched form's Cancel closes directly) — reusing the same
 * `popUpDialog` automation-id as the Enter Time modal itself, which is why a plain
 * `waitForGone(modal)` right after clicking Cancel would hang: the modal was "gone" in the sense
 * that mattered, replaced by a second dialog under the same id.
 */
async function cancelModal(doc: Document, timeout: number): Promise<void> {
  const cancel = doc.querySelector<HTMLElement>(SELECTORS.modalCancel);
  if (cancel) {
    cancel.click();
  } else {
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  try {
    const discardYes = await waitForElement<HTMLElement>(SELECTORS.discardChangesYes, {
      root: doc,
      timeout: 1500,
    });
    discardYes.click();
  } catch {
    // No discard confirmation appeared — the form had no unsaved edits, so the cancel above
    // already closed it.
  }

  await waitForGone(SELECTORS.modal, { root: doc, timeout });
}

/** Best-effort cleanup so a stuck modal doesn't poison the next day's attempt. */
async function cleanupModal(doc: Document): Promise<void> {
  try {
    await cancelModal(doc, 5000);
  } catch {
    // Best-effort only — a failed cleanup shouldn't mask the original error.
  }
}

export class DomFillEngine implements FillEngine {
  constructor(private readonly doc: Document = document) {}

  detectPage(): PageInfo {
    return detectPageDom(this.doc);
  }

  async getMissingDays(settings: Settings): Promise<string[]> {
    const days = scanCalendar(this.doc);
    return computeMissingDays(days, {
      ...DEFAULT_FILL_OPTIONS,
      today: todayLocalIso(),
    }).filter((date) => !settings.safeTestDate || date === settings.safeTestDate);
  }

  async fillDay(date: string, settings: Settings): Promise<FillResult> {
    const { doc } = this;

    if (settings.safeTestDate && date !== settings.safeTestDate) {
      return { date, status: "skipped", message: "not the configured safe test date" };
    }

    const cellData = scanCalendar(doc).find((d) => d.date === date);
    if (!cellData) {
      return { date, status: "error", message: "day cell not found on the calendar" };
    }
    if (cellData.hasEntry) {
      return { date, status: "skipped", message: "already has an entry" };
    }

    try {
      await openCell(date, doc);

      const modal = await waitForElement(SELECTORS.modal, { root: doc, timeout: settings.modalTimeoutMs });
      const timeInputs = await waitForTimeInputs(modal, settings.modalTimeoutMs);
      const [inEl, outEl] = timeInputs;

      // Safety gate: nothing previously checked the modal's own state before typing into it.
      // Workday round-trips every field edit to the server on blur (not a local draft — see
      // RESEARCH.md §3), so even "dry run" (type, then Cancel) writes through before Cancel is
      // ever clicked. If the fields aren't blank, this isn't a fresh/empty day by the modal's own
      // account — abort before touching anything, regardless of what our own scan believed.
      if (inEl.value.trim() !== "" || outEl.value.trim() !== "") {
        await cleanupModal(doc);
        return {
          date,
          status: "error",
          message:
            "modal opened with non-empty In/Out fields — this looks like an existing entry; aborted before making any changes",
        };
      }

      // UNCONFIRMED theory, not yet reproduced in isolation: Workday's selected-item chip may
      // duplicate its label for screen readers (a sibling dump showed "Hours WorkedHours Worked"
      // for the parent container), which would false-positive an exact-equality check on every
      // attempt. `includes` tolerates that without needing to pin down the exact markup — revisit
      // if fills still fail here after this change.
      const currentTimeType = modal.querySelector(SELECTORS.modalTimeType)?.textContent?.trim();
      if (currentTimeType && !currentTimeType.includes(settings.timeType)) {
        await cleanupModal(doc);
        return {
          date,
          status: "error",
          message: `modal defaulted to Time Type '${currentTimeType}', expected '${settings.timeType}' — setting a non-default type isn't supported yet`,
        };
      }

      // Dry run stops HERE, before typing into In/Out at all. Confirmed live (a real incident,
      // not a theory this time): Workday's flow commits the entry as soon as both fields validate
      // — clicking Cancel afterward does NOT undo it. There is no "type it and then safely cancel"
      // for this app; the only thing dry run can honestly verify without writing anything is that
      // the day is genuinely empty and the modal opens on the right Time Type. The hours preview
      // shown in the popup is computed client-side (core/time.ts) and never touches this modal.
      if (settings.dryRun) {
        await cancelModal(doc, settings.modalTimeoutMs);
        return { date, status: "dryRun" };
      }

      await setTimeField(inEl, settings.inTime);
      await sleep(400);

      if (modal.querySelector(SELECTORS.validationError)) {
        const message = modal.querySelector(SELECTORS.validationError)?.textContent?.trim();
        await cleanupModal(doc);
        return { date, status: "error", message: message || "Workday reported a validation error on In" };
      }

      await setTimeField(outEl, settings.outTime);

      const expectedHours = computeHours(settings.inTime, settings.outTime);
      try {
        await waitForText(SELECTORS.modalHours, String(expectedHours), {
          root: modal,
          timeout: settings.validateTimeoutMs,
        });
      } catch {
        const hoursText = modal.querySelector(SELECTORS.modalHours)?.textContent?.trim();
        await cleanupModal(doc);
        return {
          date,
          status: "error",
          message: `expected ${expectedHours}h but modal shows '${hoursText ?? "unknown"}'`,
        };
      }

      if (modal.querySelector(SELECTORS.validationError)) {
        const message = modal.querySelector(SELECTORS.validationError)?.textContent?.trim();
        await cleanupModal(doc);
        return { date, status: "error", message: message || "Workday reported a validation error" };
      }

      if (settings.comment) {
        const commentEl = modal.querySelector<HTMLTextAreaElement>(SELECTORS.modalComment);
        if (commentEl) await setTextField(commentEl, settings.comment);
      }

      const ok = findOkButton(modal);
      if (!ok) {
        await cleanupModal(doc);
        return { date, status: "error", message: "OK button not found in modal" };
      }
      ok.click();

      await Promise.race([
        waitForText(SELECTORS.toast, TOAST_SAVED_TEXT, { root: doc, timeout: settings.modalTimeoutMs }).catch(
          () => undefined,
        ),
        waitForGone(SELECTORS.modal, { root: doc, timeout: settings.modalTimeoutMs }),
      ]);

      // A single immediate check here raced the real post-save refresh and false-negatived on a
      // genuinely successful save: the modal closing doesn't mean the calendar has re-rendered
      // yet — Workday fires a whole follow-up chain after OK (RESEARCH.md §3: reload calendar,
      // clear stale page context, redraw sidebar) before the cell's aria-label actually updates.
      // Poll for a few seconds instead of checking once.
      const committed = await pollUntil(
        () => scanCalendar(doc).find((d) => d.date === date)?.hasEntry ?? false,
        { timeout: 5000, intervalMs: 300 },
      );
      if (!committed) {
        return { date, status: "error", message: "save did not appear to commit — cell still shows no entry" };
      }

      return { date, status: "filled" };
    } catch (error) {
      await cleanupModal(doc);
      return { date, status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async fillAllDays(
    settings: Settings,
    onProgress?: (percentage: number, result: FillResult) => void,
  ): Promise<FillSummary> {
    const processed = new Set<string>();
    const failures: { date: string; message: string }[] = [];
    let filled = 0;
    let skipped = 0;

    const initialTotal = (await this.getMissingDays(settings)).length;
    let done = 0;

    while (true) {
      const remaining = (await this.getMissingDays(settings)).filter((d) => !processed.has(d));
      const date = remaining[0];
      if (!date) break;
      if (filled >= settings.maxDaysPerRun) break;

      const result = await this.fillDay(date, settings);
      processed.add(date);
      done += 1;

      if (result.status === "filled") filled += 1;
      else if (result.status === "skipped" || result.status === "dryRun") skipped += 1;
      else failures.push({ date, message: result.message ?? "unknown error" });

      onProgress?.(Math.min(100, Math.round((done / Math.max(initialTotal, done)) * 100)), result);

      await sleep(settings.throttleMs);
    }

    const remaining = await this.getMissingDays(settings);
    return {
      total: initialTotal,
      filled,
      skipped,
      failed: failures.length,
      failures,
      remaining,
    };
  }
}

/** Polls `check` on an interval until it returns true, or gives up (returning false) after `timeout`. */
async function pollUntil(
  check: () => boolean,
  { timeout, intervalMs }: { timeout: number; intervalMs: number },
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

/** Waits for both the In and Out time inputs to be present and returns them in DOM order. */
async function waitForTimeInputs(modal: Element, timeout: number): Promise<[HTMLInputElement, HTMLInputElement]> {
  await waitForElement(SELECTORS.modalTimeInputs, { root: modal, timeout });
  const inputs = [...modal.querySelectorAll<HTMLInputElement>(SELECTORS.modalTimeInputs)];
  const [inEl, outEl] = inputs;
  if (!inEl || !outEl) {
    throw new Error(`expected 2 time inputs (In, Out), found ${inputs.length}`);
  }
  return [inEl, outEl];
}
