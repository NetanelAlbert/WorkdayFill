import type { DeleteResult, DeleteSummary, FillResult, FillSummary, PageInfo, Settings } from "../../core/types";

/**
 * Strategy interface for filling attendance days. `DomFillEngine` (Approach A) implements this by
 * driving the real page; a future `FlowReplayEngine` (Approach B, headless flowController replay)
 * can implement the same contract once the WebFlow responses in RESEARCH.md §6 are captured.
 */
export interface FillEngine {
  detectPage(): PageInfo;
  getMissingDays(settings: Settings): Promise<string[]>;
  fillDay(date: string, settings: Settings): Promise<FillResult>;
  fillAllDays(
    settings: Settings,
    onProgress?: (percentage: number, result: FillResult) => void,
  ): Promise<FillSummary>;
  /**
   * Days with at least one real "Hours Worked" entry that can be deleted — a cheap pre-filter;
   * deleteDay does the authoritative per-day check, mirroring getMissingDays/fillDay.
   */
  getDeletableDays(): Promise<string[]>;
  deleteDay(date: string): Promise<DeleteResult>;
  deleteAllDays(
    onProgress?: (percentage: number, result: DeleteResult) => void,
  ): Promise<DeleteSummary>;
}
