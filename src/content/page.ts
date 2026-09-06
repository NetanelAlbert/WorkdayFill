import type { PageInfo } from "../core/types";
import { SELECTORS } from "./selectors";

const MONTH_HEADER_RE = /([A-Za-z]+)\s+(\d{4})/;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Workday's user-menu element nests a secondary action's label inside the same text node as the
 * worker's name (confirmed live: textContent reads "Nati AlbertView Profile"). Strip a known
 * trailing action label so only the name remains.
 */
function cleanWorkerName(raw: string | null): string | null {
  if (!raw) return null;
  let name = raw;
  for (const suffix of ["View Profile", "Related Actions"]) {
    const idx = name.toLowerCase().indexOf(suffix.toLowerCase());
    if (idx > 0) name = name.slice(0, idx);
  }
  name = name.replace(/\s+/g, " ").trim();
  return name || null;
}

/** Detects whether the current page is the Enter Time calendar and extracts worker/month context. */
export function detectPage(doc: Document = document): PageInfo {
  const isEnterTime = doc.querySelector(SELECTORS.enterTimeRoot) !== null;

  const workerName = cleanWorkerName(doc.querySelector(SELECTORS.workerName)?.textContent?.trim() ?? null);

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
