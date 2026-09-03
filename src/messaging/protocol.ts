import type { FillSummary, PageInfo, Settings } from "../core/types";

export type Request =
  | { action: "getUserInfo" }
  | { action: "getPageInfo" }
  | { action: "getMissingDays"; settings: Settings }
  | { action: "fillSingleDay"; date: string; settings: Settings }
  | { action: "fillAllDays"; settings: Settings };

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
  | { success: true; summary: FillSummary };

export interface ProgressMessage {
  action: "updateProgress";
  percentage: number;
  date: string;
  status: string;
}

export function isErrorResponse(response: Response): response is ErrorResponse {
  return "error" in response;
}
