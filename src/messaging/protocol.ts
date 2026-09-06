import type { DeleteResult, DeleteSummary, FillSummary, PageInfo, Settings } from "../core/types";

export type Request =
  | { action: "getUserInfo" }
  | { action: "getPageInfo" }
  | { action: "getMissingDays"; settings: Settings }
  | { action: "fillSingleDay"; date: string; settings: Settings }
  | { action: "fillAllDays"; settings: Settings }
  | { action: "getDeletableDays" }
  | { action: "deleteSingleDay"; date: string }
  | { action: "deleteAllDays" };

export interface ErrorResponse {
  error: string;
  code?: "SELECTORS_NOT_FOUND";
  missing?: string[];
}

export type Response =
  | ErrorResponse
  | { user: { displayName: string | null } }
  | PageInfo
  | { missingDays: string[] }
  | { success: true; result: { date: string; status: string; message?: string } }
  | { success: true; summary: FillSummary }
  | { deletableDays: string[] }
  | { success: true; deleteResult: DeleteResult }
  | { success: true; deleteSummary: DeleteSummary };

export interface ProgressMessage {
  action: "updateProgress";
  percentage: number;
  date: string;
  status: string;
}

export function isErrorResponse(response: Response): response is ErrorResponse {
  return "error" in response;
}
