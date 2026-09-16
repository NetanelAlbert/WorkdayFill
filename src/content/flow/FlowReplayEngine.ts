import { todayLocalIso } from "../../core/time";
import { computeMissingDays, DEFAULT_FILL_OPTIONS } from "../../core/missing-days";
import type { DeleteResult, DeleteSummary, FillResult, FillSummary, PageInfo, Settings } from "../../core/types";
import { detectPage as detectPageDom } from "../page";
import { scanCalendar } from "../scan";
import type { FillEngine } from "../engine/FillEngine";
import { bootstrapFlowContext, FlowBootstrapError, type FlowContext } from "./bootstrap";
import { WorkdayFlowClient } from "./WorkdayFlowClient";
import { buildSubmitParams, buildValidateParams, hasFlowError, type ModelDay, parseCalendarDays, parseOpenResponse } from "./parse";

/** Error-message marker for a failed dialog open (pre-commit → safe to retry on a fresh context). */
const OPEN_FAILED = "couldn't open the Enter Time dialog";
/** No UI to settle in the headless engine, so cap the inter-day delay well below the DOM default. */
const FLOW_THROTTLE_MAX_MS = 150;

/**
 * Approach B: fills days by replaying Workday's Enter Time flow over `fetch`, never touching the UI —
 * no modal, no typing, no clicks (RESEARCH.md §7.4). It implements the same `FillEngine` contract as
 * `DomFillEngine`, so the two are interchangeable behind the popup.
 *
 * Two deliberate design points:
 *
 *  1. **Day classification comes from the DOM, "already filled" comes from the fresh model.** A headless
 *     write does NOT re-render the calendar, so the rendered DOM's hours go stale the moment we write —
 *     relying on it would re-list a just-filled day and could double-fill it. So we read the *static*
 *     classification (weekend/holiday/time-off/in-month) from the DOM scan (which those writes never
 *     change) but take the *dynamic* "has worked hours" fact from a freshly fetched calendar model.
 *
 *  2. **The open action uri is per-render.** A batch bootstraps the model once and reuses its uris (the
 *     per-day cost is then just the flow POSTs); if a uri has gone stale after earlier writes, the open
 *     fails pre-commit and the batch re-bootstraps once and retries that day. The model's `totalHours`
 *     is the authoritative "is this day already filled?" guard before opening anything.
 *
 * Delete is not implemented headlessly (the delete flow's intermediate steps weren't mapped — see
 * RESEARCH.md §7.5); `content.ts` routes deletes to `DomFillEngine`, and the delete methods here return
 * a clear "not supported" result should they ever be called directly.
 */
export class FlowReplayEngine implements FillEngine {
  constructor(
    private readonly doc: Document = document,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  detectPage(): PageInfo {
    return detectPageDom(this.doc);
  }

  private async bootstrap(): Promise<FlowContext> {
    return bootstrapFlowContext(this.doc, this.fetchImpl);
  }

  /**
   * Missing days = DOM classification says fillable (not weekend/holiday/time-off, in month) AND the
   * fresh model says the day has zero worked hours AND the model exposes an open action for it.
   */
  async getMissingDays(settings: Settings): Promise<string[]> {
    const ctx = await this.bootstrap();
    return this.computeMissing(ctx, settings);
  }

  private computeMissing(ctx: FlowContext, settings: Settings): string[] {
    return this.computeMissingFromDays(ctx.days, settings);
  }

  /**
   * Missing days from a set of model days: DOM classification says fillable (not weekend/holiday/
   * time-off, in month), the model says zero worked hours, and the model exposes an open action.
   */
  private computeMissingFromDays(days: ModelDay[], settings: Settings): string[] {
    const hoursByDate = new Map(days.map((d) => [d.date, d.totalHours]));
    const uriByDate = new Map(days.filter((d) => d.openUri).map((d) => [d.date, d.openUri!]));
    // Override each cell's (stale) DOM hasEntry with the model's authoritative worked-hours fact.
    const cells = scanCalendar(this.doc).map((cell) => ({
      ...cell,
      hasEntry: (hoursByDate.get(cell.date) ?? 0) > 0,
    }));
    return computeMissingDays(cells, { ...DEFAULT_FILL_OPTIONS, today: todayLocalIso() })
      .filter((date) => uriByDate.has(date))
      .filter((date) => !settings.safeTestDate || date === settings.safeTestDate);
  }

  async fillDay(date: string, settings: Settings): Promise<FillResult> {
    if (settings.safeTestDate && date !== settings.safeTestDate) {
      return { date, status: "skipped", message: "not the configured safe test date" };
    }
    if (settings.timeType && settings.timeType !== "Hours Worked") {
      return {
        date,
        status: "error",
        message: `Time Type '${settings.timeType}' isn't supported by the headless engine yet (only 'Hours Worked')`,
      };
    }

    try {
      const ctx = await this.bootstrap();
      return await this.fillDayWith(ctx, date, settings, true);
    } catch (error) {
      if (error instanceof FlowBootstrapError) {
        return { date, status: "error", message: error.message };
      }
      return { date, status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Fills one day using an already-bootstrapped context. `verify` re-reads the model to confirm the
   * write landed — worth it for a single fill, but skipped in a batch (which reconciles once at the
   * end) to avoid a ~250 KB fetch per day.
   */
  private async fillDayWith(
    ctx: FlowContext,
    date: string,
    settings: Settings,
    verify: boolean,
  ): Promise<FillResult> {
    const modelDay = ctx.days.find((d) => d.date === date);
    if (!modelDay) {
      return { date, status: "error", message: "day not present in the calendar model (wrong month shown?)" };
    }
    // Authoritative double-fill guard, from fresh server state rather than the stale DOM.
    if (modelDay.totalHours > 0) {
      return { date, status: "skipped", message: "already has an entry" };
    }
    const openUri = ctx.dateToUri.get(date);
    if (!openUri) {
      return { date, status: "error", message: "no Enter Time action for this day (locked period, or model is stale)" };
    }

    // 0) open the dialog flow
    const open = await ctx.client.openDialog(openUri);
    const flow = parseOpenResponse(open.text);
    if (open.status !== 200 || !flow) {
      // Pre-commit failure — safe to retry on a fresh context (see the batch loop). OPEN_FAILED marks it.
      return { date, status: "error", message: `${OPEN_FAILED} (HTTP ${open.status})` };
    }

    // Dry run stops here: the flow is open server-side but no field has been validated, so — matching
    // DomFillEngine's dry run — nothing commits (Workday only writes once both In and Out validate).
    if (settings.dryRun) {
      return { date, status: "dryRun" };
    }

    // 1) validate In
    const vin = await ctx.client.flowController(flow.flowKey, buildValidateParams(flow.fieldPrefix, "In", settings.inTime));
    if (vin.status !== 200 || hasFlowError(vin.text)) {
      return { date, status: "error", message: "Workday rejected the In time" };
    }

    // 2) validate Out — this is the step that commits the draft
    const vout = await ctx.client.flowController(flow.flowKey, buildValidateParams(flow.fieldPrefix, "Out", settings.outTime));
    if (vout.status !== 200 || hasFlowError(vout.text)) {
      return { date, status: "error", message: "Workday rejected the Out time" };
    }

    // 3) submit (OK) — finalizes the dialog
    const submit = await ctx.client.flowController(flow.flowKey, buildSubmitParams(flow));
    if (submit.status !== 200 || hasFlowError(submit.text)) {
      return { date, status: "error", message: "Workday rejected the save" };
    }

    if (verify) {
      const fresh = await this.freshModel(ctx);
      const committed = ((fresh?.days.find((d) => d.date === date))?.totalHours ?? 0) > 0;
      if (!committed) {
        return { date, status: "error", message: "save did not appear to commit (day still shows no hours)" };
      }
    }

    return { date, status: "filled" };
  }

  /** Re-fetches the calendar model as fresh ModelDays (server truth), or null on failure. */
  private async freshModel(ctx: FlowContext): Promise<{ days: ReturnType<typeof parseCalendarDays> } | null> {
    const fresh = await WorkdayFlowClient.fetchCalendarModel(ctx.source, ctx.clientVersion, this.fetchImpl);
    if (fresh.status !== 200) return null;
    return { days: parseCalendarDays(fresh.text) };
  }

  async fillAllDays(
    settings: Settings,
    onProgress?: (percentage: number, result: FillResult) => void,
  ): Promise<FillSummary> {
    // Bootstrap ONCE and reuse the model + open uris for the whole batch — the per-day round trips are
    // just the flow POSTs, no repeated ~250 KB model fetches. (Throws on bootstrap failure so the popup
    // shows the "reload the page" guidance, same as getMissingDays.)
    let ctx = await this.bootstrap();
    const missing = this.computeMissing(ctx, settings);
    const initialTotal = missing.length;

    const failures: { date: string; message: string }[] = [];
    const filledDates: string[] = [];
    let filled = 0;
    let skipped = 0;
    let done = 0;

    for (const date of missing) {
      if (filled >= settings.maxDaysPerRun) break;

      let result = await this.fillDayWith(ctx, date, settings, false);
      // A day's open uri can go stale after earlier writes; re-bootstrap once (fresh uris) and retry.
      // Only retried for OPEN_FAILED, which is strictly pre-commit, so no double-write risk.
      if (result.status === "error" && result.message?.startsWith(OPEN_FAILED)) {
        ctx = await this.bootstrap();
        result = await this.fillDayWith(ctx, date, settings, false);
      }
      done += 1;

      if (result.status === "filled") {
        filled += 1;
        filledDates.push(date);
      } else if (result.status === "skipped" || result.status === "dryRun") {
        skipped += 1;
      } else {
        failures.push({ date, message: result.message ?? "unknown error" });
      }

      onProgress?.(Math.min(100, Math.round((done / Math.max(initialTotal, done)) * 100)), result);

      // No UI to settle (unlike the DOM engine), so only a light throttle to be gentle on the server.
      if (settings.throttleMs > 0) await sleep(Math.min(settings.throttleMs, FLOW_THROTTLE_MAX_MS));
    }

    // One reconciliation fetch: confirm what actually landed and compute what's left.
    const fresh = await this.freshModel(ctx).catch(() => null);
    let remaining: string[] = [];
    if (fresh) {
      const hoursByDate = new Map(fresh.days.map((d) => [d.date, d.totalHours]));
      for (const date of filledDates) {
        if ((hoursByDate.get(date) ?? 0) === 0) {
          filled -= 1;
          failures.push({ date, message: "save did not appear to commit" });
        }
      }
      remaining = this.computeMissingFromDays(fresh.days, settings);
    }

    return { total: initialTotal, filled, skipped, failed: failures.length, failures, remaining };
  }

  // --- Delete: not supported headlessly; content.ts routes deletes to DomFillEngine. ---

  async getDeletableDays(): Promise<string[]> {
    return [];
  }

  async deleteDay(date: string): Promise<DeleteResult> {
    return { date, status: "error", message: "headless delete isn't implemented; the DOM engine handles deletes" };
  }

  async deleteAllDays(): Promise<DeleteSummary> {
    return { total: 0, deleted: 0, skipped: 0, failed: 0, failures: [], remaining: [] };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
