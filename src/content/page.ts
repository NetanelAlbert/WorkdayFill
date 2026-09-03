import type { PageInfo } from "../core/types";
import { SELECTORS } from "./selectors";

const MONTH_HEADER_RE = /([A-Za-z]+)\s+(\d{4})/;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Detects whether the current page is the Enter Time calendar and extracts worker/month context. */
export function detectPage(doc: Document = document): PageInfo {
  const isEnterTime = doc.querySelector(SELECTORS.enterTimeRoot) !== null;

  const workerName = doc.querySelector(SELECTORS.workerName)?.textContent?.trim() ?? null;

  const headerText = doc.querySelector(SELECTORS.monthHeader)?.textContent?.trim() ?? "";
  const match = MONTH_HEADER_RE.exec(headerText);
  const month = match
    ? {
        label: headerText,
        year: Number(match[2]),
        monthIndex: MONTH_NAMES.findIndex(
          (name) => name.toLowerCase() === match[1]!.toLowerCase(),
        ),
      }
    : null;

  return { isEnterTime, workerName, month };
}
