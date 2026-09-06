import type { ErrorResponse, ProgressMessage, Request, Response } from "../messaging/protocol";
import { DomFillEngine } from "./engine/DomFillEngine";
import { validateSelectors } from "./selectors";

console.log("[WorkdayFill] content script loading...");

const engine = new DomFillEngine();

function selectorsNotFoundResponse(missing: string[]): ErrorResponse {
  return {
    error:
      "WorkdayFill couldn't find the Enter Time calendar. Workday may have changed — selectors need updating.",
    code: "SELECTORS_NOT_FOUND",
    missing,
  };
}

async function handleRequest(request: Request): Promise<Response> {
  // Page-detection actions must work everywhere on myworkday.com, including pages that are
  // legitimately not Enter Time (e.g. the Workday home page) — detectPage() already reports
  // isEnterTime: false gracefully in that case. Only actions that operate on the calendar itself
  // need the CRITICAL selectors to actually resolve.
  if (request.action === "getUserInfo") {
    const { workerName } = engine.detectPage();
    return { user: { displayName: workerName } };
  }
  if (request.action === "getPageInfo") {
    return engine.detectPage();
  }

  const validation = validateSelectors();
  if (!validation.ok) {
    return selectorsNotFoundResponse(validation.missing);
  }

  switch (request.action) {
    case "getMissingDays": {
      const missingDays = await engine.getMissingDays(request.settings);
      return { missingDays };
    }

    case "fillSingleDay": {
      const result = await engine.fillDay(request.date, request.settings);
      if (result.status === "error") {
        console.error("[WorkdayFill] fillSingleDay failed:", result.date, result.message);
      } else {
        console.log("[WorkdayFill] fillSingleDay:", result.date, result.status);
      }
      return { success: true, result };
    }

    case "fillAllDays": {
      const summary = await engine.fillAllDays(request.settings, (percentage, result) => {
        if (result.status === "error") {
          console.error("[WorkdayFill] fillAllDays step failed:", result.date, result.message);
        } else {
          console.log("[WorkdayFill] fillAllDays step:", result.date, result.status);
        }
        const progress: ProgressMessage = {
          action: "updateProgress",
          percentage,
          date: result.date,
          status: result.status,
        };
        chrome.runtime.sendMessage(progress).catch(() => {
          // The popup may be closed — progress updates are best-effort.
        });
      });
      console.log("[WorkdayFill] fillAllDays summary:", summary);
      return { success: true, summary };
    }

    case "getDeletableDays": {
      const deletableDays = await engine.getDeletableDays();
      return { deletableDays };
    }

    case "deleteSingleDay": {
      const result = await engine.deleteDay(request.date);
      if (result.status === "error") {
        console.error("[WorkdayFill] deleteSingleDay failed:", result.date, result.message);
      } else {
        console.log("[WorkdayFill] deleteSingleDay:", result.date, result.status);
      }
      return { success: true, deleteResult: result };
    }

    case "deleteAllDays": {
      const summary = await engine.deleteAllDays((percentage, result) => {
        if (result.status === "error") {
          console.error("[WorkdayFill] deleteAllDays step failed:", result.date, result.message);
        } else {
          console.log("[WorkdayFill] deleteAllDays step:", result.date, result.status);
        }
        const progress: ProgressMessage = {
          action: "updateProgress",
          percentage,
          date: result.date,
          status: result.status,
        };
        chrome.runtime.sendMessage(progress).catch(() => {
          // The popup may be closed — progress updates are best-effort.
        });
      });
      console.log("[WorkdayFill] deleteAllDays summary:", summary);
      return { success: true, deleteSummary: summary };
    }

    default: {
      const exhaustive: never = request;
      return { error: `Unknown action: ${JSON.stringify(exhaustive)}` };
    }
  }
}

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handleRequest(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error("[WorkdayFill] request failed:", request, error);
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

console.log("[WorkdayFill] content script loaded, listener registered.");
