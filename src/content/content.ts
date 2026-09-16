import type { Settings } from "../core/types";
import type { ErrorResponse, ProgressMessage, Request, Response } from "../messaging/protocol";
import { DomFillEngine } from "./engine/DomFillEngine";
import type { FillEngine } from "./engine/FillEngine";
import { FlowReplayEngine } from "./flow/FlowReplayEngine";
import { validateSelectors } from "./selectors";

console.log("[WorkdayFill] content script loading...");

const domEngine = new DomFillEngine();
const flowEngine = new FlowReplayEngine();

/** Picks the fill engine from settings. Deletes and page detection always use the DOM engine. */
function fillEngineFor(settings: Settings): FillEngine {
  return settings.engine === "flow" ? flowEngine : domEngine;
}

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
    const { workerName } = domEngine.detectPage();
    return { user: { displayName: workerName } };
  }
  if (request.action === "getPageInfo") {
    return domEngine.detectPage();
  }

  const validation = validateSelectors();
  if (!validation.ok) {
    return selectorsNotFoundResponse(validation.missing);
  }

  switch (request.action) {
    case "getMissingDays": {
      const missingDays = await fillEngineFor(request.settings).getMissingDays(request.settings);
      return { missingDays };
    }

    case "fillSingleDay": {
      const result = await fillEngineFor(request.settings).fillDay(request.date, request.settings);
      if (result.status === "error") {
        console.error("[WorkdayFill] fillSingleDay failed:", result.date, result.message);
      } else {
        console.log("[WorkdayFill] fillSingleDay:", result.date, result.status);
      }
      return { success: true, result };
    }

    case "fillAllDays": {
      const summary = await fillEngineFor(request.settings).fillAllDays(request.settings, (percentage, result) => {
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
      const deletableDays = await domEngine.getDeletableDays();
      return { deletableDays };
    }

    case "deleteSingleDay": {
      const result = await domEngine.deleteDay(request.date);
      if (result.status === "error") {
        console.error("[WorkdayFill] deleteSingleDay failed:", result.date, result.message);
      } else {
        console.log("[WorkdayFill] deleteSingleDay:", result.date, result.status);
      }
      return { success: true, deleteResult: result };
    }

    case "deleteAllDays": {
      const summary = await domEngine.deleteAllDays((percentage, result) => {
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
