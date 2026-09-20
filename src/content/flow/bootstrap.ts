/**
 * Bootstraps everything the headless flow engine needs, from the isolated content-script world:
 *
 *  - calendar-model URL + method: recorded by the MAIN-world helper (src/content/main-world.ts) onto
 *    DOM attributes — the task launcher (GET) on load, or the calendar rel-task endpoint (POST) after
 *    month navigation. The signed URL can't be reconstructed, so it must be observed this way.
 *  - X-Workday-Client: parsed from the page HTML (`workday.clientVersion = 'Workday/…'`).
 *  - session-secure token: the calendar model is readable cookie-only, and its JSON embeds the token.
 */

import { WorkdayFlowClient } from "./WorkdayFlowClient";
import {
  buildDateToOpenUri,
  extractClientVersion,
  extractSessionSecureToken,
  modelHoursUnreadable,
  parseCalendarDays,
  type ModelDay,
} from "./parse";

const URL_ATTR = "data-wf-model-url";
const METHOD_ATTR = "data-wf-model-method";

export interface CalendarSource {
  url: string;
  method: string;
}

export interface FlowContext {
  client: WorkdayFlowClient;
  /** Freshly parsed model days for the currently displayed month. */
  days: ModelDay[];
  /** date -> open action uri, from the same model fetch (uris are only valid within one fetch). */
  dateToUri: Map<string, string>;
  clientVersion: string;
  source: CalendarSource;
}

export class FlowBootstrapError extends Error {}

/** Reads the calendar-model URL + method the MAIN-world helper recorded, if present. */
export function findCalendarSource(doc: Document = document): CalendarSource | null {
  const url = doc.documentElement.getAttribute(URL_ATTR);
  if (!url) return null;
  const method = doc.documentElement.getAttribute(METHOD_ATTR) || "GET";
  return { url, method };
}

/** Reads the `X-Workday-Client` version from the live page HTML (RESEARCH.md §7.3). */
export function readClientVersion(doc: Document = document): string | null {
  return extractClientVersion(doc.documentElement.outerHTML);
}

/**
 * Resolves a full FlowContext: find the model URL (from the MAIN-world helper), read the client
 * version, fetch the model and parse the token + day map, then build an authenticated client. Throws
 * FlowBootstrapError with a user-facing message on any missing piece.
 */
export async function bootstrapFlowContext(
  doc: Document = document,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<FlowContext> {
  // The helper records the URL as the page loads (from its content-verified network capture); give it
  // a few seconds in case we run before that request resolves.
  let source = findCalendarSource(doc);
  for (let i = 0; !source && i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    source = findCalendarSource(doc);
  }
  if (!source) {
    // Include a short diagnostic so a failure report pinpoints the cause (path shape / helper missing).
    const path = (() => {
      try {
        return location.pathname;
      } catch {
        return "?";
      }
    })();
    throw new FlowBootstrapError(
      `Couldn't find Workday's calendar data — do a full reload of the Enter Time page (⌘/Ctrl+R) and try again. ` +
        `If it persists, the page may have loaded before the extension. [path: ${path}]`,
    );
  }

  const clientVersion = readClientVersion(doc);
  if (!clientVersion) {
    throw new FlowBootstrapError("Couldn't read the Workday client version from the page.");
  }

  const model = await WorkdayFlowClient.fetchCalendarModel(source, clientVersion, fetchImpl);
  if (model.status !== 200) {
    throw new FlowBootstrapError(`Workday calendar request failed (HTTP ${model.status}).`);
  }

  const token = extractSessionSecureToken(model.text);
  if (!token) {
    throw new FlowBootstrapError("Couldn't read the Workday session token from the calendar data.");
  }

  const days = parseCalendarDays(model.text);
  // Model-side equivalent of validateSelectors(): if Workday reshaped the payload, every day reads as
  // "no hours", which is indistinguishable from "every day is empty" — and acting on that would
  // duplicate entries across the whole month. Refuse to run instead.
  if (modelHoursUnreadable(days)) {
    throw new FlowBootstrapError(
      "Workday's calendar data format changed — WorkdayFill can't tell which days are already filled, " +
        "so it stopped rather than risk duplicate entries. Use Visible mode, or update the extension.",
    );
  }
  const dateToUri = buildDateToOpenUri(days);
  const client = new WorkdayFlowClient(token, clientVersion, location.origin, fetchImpl);

  return { client, days, dateToUri, clientVersion, source };
}
