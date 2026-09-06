import { computeHours } from "../core/time";
import { DEFAULT_SETTINGS, mergeSettings } from "../core/settings";
import type { Settings } from "../core/types";
import { isErrorResponse, type ProgressMessage, type Request, type Response } from "../messaging/protocol";
import { BONUSLY_GIVE_COMMAND, BUY_ME_A_COFFEE_URL, SLACK_URL } from "./support";

const WORKDAY_HOST = "myworkday.com";

async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get("settings");
  return mergeSettings(result.settings as Partial<Settings> | undefined);
}

async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

function readSettingsFromForm(): Settings {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const throttleRaw = el<HTMLInputElement>("throttleMs").value;
  return mergeSettings({
    inTime: el<HTMLInputElement>("inTime").value || DEFAULT_SETTINGS.inTime,
    outTime: el<HTMLInputElement>("outTime").value || DEFAULT_SETTINGS.outTime,
    comment: el<HTMLInputElement>("comment").value,
    dryRun: el<HTMLInputElement>("dryRun").checked,
    safeTestDate: el<HTMLInputElement>("safeTestDate").value || null,
    throttleMs: throttleRaw ? Number(throttleRaw) : DEFAULT_SETTINGS.throttleMs,
  });
}

function writeSettingsToForm(settings: Settings): void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  el<HTMLInputElement>("inTime").value = settings.inTime;
  el<HTMLInputElement>("outTime").value = settings.outTime;
  el<HTMLInputElement>("comment").value = settings.comment;
  el<HTMLInputElement>("dryRun").checked = settings.dryRun;
  el<HTMLInputElement>("safeTestDate").value = settings.safeTestDate ?? "";
  el<HTMLInputElement>("throttleMs").value = String(settings.throttleMs);
}

async function isWorkdayTab(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return Boolean(tab?.url?.includes(WORKDAY_HOST));
}

async function sendToContentScript(request: Request): Promise<Response> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return chrome.tabs.sendMessage(tab.id, request);
}

function showStatus(message: string, isError = false): void {
  const statusEl = document.getElementById("status")!;
  statusEl.textContent = message;
  statusEl.className = "status " + (isError ? "error" : "success");
  setTimeout(() => {
    statusEl.className = "status";
  }, 3000);
}

function updateProgressBar(percentage: number): void {
  const bar = document.getElementById("progressBar")!;
  bar.style.width = `${percentage}%`;
}

function updateHoursPreview(settings: Settings): void {
  const preview = document.getElementById("hoursPreview")!;
  try {
    preview.textContent = String(computeHours(settings.inTime, settings.outTime));
  } catch {
    preview.textContent = "–";
  }
}

function dayStatusLabel(status: string): { text: string; className: string } {
  switch (status) {
    case "filled":
      return { text: "filled", className: "filled" };
    case "dryRun":
      return { text: "dry-run ok", className: "" };
    case "skipped":
      return { text: "skipped", className: "" };
    case "error":
      return { text: "failed", className: "error" };
    default:
      return { text: status, className: "" };
  }
}

function createDayItem(date: string, settings: Settings, onDone: () => void): HTMLElement {
  const item = document.createElement("div");
  item.className = "day-item";

  const dateSpan = document.createElement("span");
  dateSpan.className = "day-date";
  dateSpan.textContent = date;
  item.appendChild(dateSpan);

  const fillButton = document.createElement("button");
  fillButton.textContent = "Fill";
  fillButton.onclick = async () => {
    fillButton.disabled = true;
    try {
      const response = await sendToContentScript({ action: "fillSingleDay", date, settings });
      if (isErrorResponse(response)) throw new Error(response.error);
      if (!("result" in response)) throw new Error("Unexpected response");

      const { text, className } = dayStatusLabel(response.result.status);
      const label = document.createElement("span");
      label.className = `day-status ${className}`;
      label.textContent = text;
      item.replaceChild(label, fillButton);

      if (response.result.status === "filled") {
        showStatus(`Filled ${date}`);
        onDone();
      } else if (response.result.status === "error") {
        showStatus(`Failed to fill ${date}: ${response.result.message}`, true);
      }
    } catch (error) {
      showStatus(`Failed to fill ${date}: ${(error as Error).message}`, true);
      fillButton.disabled = false;
    }
  };
  item.appendChild(fillButton);

  return item;
}

function showSupportStatus(message: string): void {
  const statusEl = document.getElementById("supportStatus");
  if (!statusEl) return;
  statusEl.hidden = false;
  statusEl.textContent = message;
}

function buyMeACoffeeHref(): string | null {
  if (!BUY_ME_A_COFFEE_URL) return null;
  try {
    const parsed = new URL(BUY_ME_A_COFFEE_URL);
    if (parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function slackDesktopHref(): string | null {
  try {
    const parsed = new URL(SLACK_URL);
    if (parsed.protocol !== "slack:") return null;
    return SLACK_URL;
  } catch {
    return null;
  }
}

function wireSupportLinks(): void {
  const coffeeHref = buyMeACoffeeHref();
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a.bmc-support")) {
    if (!coffeeHref) {
      link.hidden = true;
      continue;
    }
    link.href = coffeeHref;
    link.hidden = false;
  }

  const slackHref = slackDesktopHref();
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a.bonusly-support")) {
    if (!slackHref) {
      link.removeAttribute("href");
      continue;
    }
    link.href = slackHref;
    link.addEventListener("click", () => {
      void navigator.clipboard.writeText(BONUSLY_GIVE_COMMAND).then(
        () => showSupportStatus("Copied the /give command — paste it in Slack and send."),
        () => showSupportStatus(`In Slack, send: ${BONUSLY_GIVE_COMMAND}`),
      );
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const mainContent = document.getElementById("mainContent")!;
  const wrongSiteMessage = document.getElementById("wrongSiteMessage")!;
  const selectorsStaleMessage = document.getElementById("selectorsStaleMessage")!;
  const pageStatus = document.getElementById("pageStatus")!;
  const pageStatusText = document.getElementById("pageStatusText")!;
  const missingCount = document.getElementById("missingCount")!;
  const missingDaysContainer = document.getElementById("missingDays")!;
  const loadingEl = document.getElementById("loading")!;
  const fillAllButton = document.getElementById("fillAll") as HTMLButtonElement;
  const toggleAdvancedButton = document.getElementById("toggleAdvanced")!;
  const advancedPanel = document.getElementById("advancedPanel")!;
  const toggleDaysButton = document.getElementById("toggleDays")!;
  const aboutButton = document.getElementById("aboutButton")!;
  const aboutInfo = document.getElementById("aboutInfo")!;
  const versionEl = document.getElementById("version")!;
  const userChip = document.getElementById("userChip")!;
  const progressContainer = document.getElementById("progressContainer")!;
  const toggleDangerButton = document.getElementById("toggleDanger")!;
  const dangerPanel = document.getElementById("dangerPanel")!;
  const deletableCountText = document.getElementById("deletableCountText")!;
  const deleteConfirmInput = document.getElementById("deleteConfirmInput") as HTMLInputElement;
  const deleteAllButton = document.getElementById("deleteAllButton") as HTMLButtonElement;

  versionEl.textContent = chrome.runtime.getManifest().version;
  wireSupportLinks();

  let settings = await loadSettings();
  writeSettingsToForm(settings);
  updateHoursPreview(settings);

  const persistAndRefreshPreview = async () => {
    settings = readSettingsFromForm();
    await saveSettings(settings);
    updateHoursPreview(settings);
  };
  ["inTime", "outTime", "comment", "dryRun", "safeTestDate", "throttleMs"].forEach((id) => {
    document.getElementById(id)!.addEventListener("change", persistAndRefreshPreview);
  });

  toggleAdvancedButton.addEventListener("click", () => {
    const hidden = advancedPanel.style.display === "none";
    advancedPanel.style.display = hidden ? "flex" : "none";
    toggleAdvancedButton.textContent = hidden ? "Hide advanced settings" : "Show advanced settings";
  });

  toggleDaysButton.addEventListener("click", () => {
    const hidden = missingDaysContainer.style.display === "none";
    missingDaysContainer.style.display = hidden ? "flex" : "none";
    toggleDaysButton.textContent = hidden ? "Hide days" : "Show days";
  });

  aboutButton.addEventListener("click", () => {
    const hidden = aboutInfo.style.display === "none";
    aboutInfo.style.display = hidden ? "block" : "none";
    aboutButton.textContent = hidden ? "Hide about" : "About";
  });

  toggleDangerButton.addEventListener("click", () => {
    const hidden = dangerPanel.style.display === "none";
    dangerPanel.style.display = hidden ? "flex" : "none";
    toggleDangerButton.textContent = hidden ? "Hide danger zone" : "Show danger zone";
  });

  deleteConfirmInput.addEventListener("input", () => {
    deleteAllButton.disabled = deleteConfirmInput.value !== "DELETE";
  });

  chrome.runtime.onMessage.addListener((message: ProgressMessage) => {
    if (message.action === "updateProgress") {
      updateProgressBar(message.percentage);
    }
  });

  if (!(await isWorkdayTab())) {
    wrongSiteMessage.style.display = "flex";
    return;
  }
  wrongSiteMessage.style.display = "none";

  async function loadMissingDays(): Promise<void> {
    loadingEl.style.display = "block";
    missingDaysContainer.innerHTML = "";
    missingDaysContainer.appendChild(loadingEl);
    fillAllButton.disabled = true;

    const pageInfoResponse = await sendToContentScript({ action: "getPageInfo" });
    if (isErrorResponse(pageInfoResponse)) {
      if (pageInfoResponse.code === "SELECTORS_NOT_FOUND") {
        selectorsStaleMessage.style.display = "flex";
        pageStatus.style.display = "none";
        loadingEl.style.display = "none";
        return;
      }
      throw new Error(pageInfoResponse.error);
    }
    if ("isEnterTime" in pageInfoResponse) {
      if (!pageInfoResponse.isEnterTime) {
        pageStatus.className = "notice notice-neutral";
        pageStatusText.textContent = "Open the Enter Time calendar to get started.";
        loadingEl.style.display = "none";
        return;
      }
      const monthLabel = pageInfoResponse.month?.label ?? "the current month";
      pageStatusText.textContent = `Enter Time detected — ${monthLabel}`;
      if (pageInfoResponse.workerName) {
        userChip.textContent = pageInfoResponse.workerName;
        userChip.style.display = "inline-block";
      }
    }

    const response = await sendToContentScript({ action: "getMissingDays", settings });
    loadingEl.style.display = "none";
    if (isErrorResponse(response)) throw new Error(response.error);
    if (!("missingDays" in response)) return;

    const days = response.missingDays;
    missingCount.textContent = String(days.length);
    missingDaysContainer.innerHTML = "";

    if (days.length === 0) {
      missingDaysContainer.innerHTML =
        '<div style="text-align:center;padding:8px;color:var(--success-dark);">No missing days found</div>';
      fillAllButton.disabled = true;
      return;
    }

    days.forEach((date) => {
      missingDaysContainer.appendChild(createDayItem(date, settings, loadMissingDays));
    });
    fillAllButton.disabled = false;
  }

  async function loadDeletableCount(): Promise<void> {
    const response = await sendToContentScript({ action: "getDeletableDays" });
    if (isErrorResponse(response) || !("deletableDays" in response)) {
      deletableCountText.textContent = "Couldn't check for deletable days.";
      return;
    }
    const count = response.deletableDays.length;
    deletableCountText.textContent =
      count === 0
        ? "No Hours Worked entries found this month."
        : `${count} day${count === 1 ? "" : "s"} with an Hours Worked entry this month.`;
  }

  deleteAllButton.addEventListener("click", async () => {
    deleteAllButton.disabled = true;
    const originalText = deleteAllButton.textContent;
    deleteAllButton.textContent = "Deleting…";
    progressContainer.style.display = "block";
    updateProgressBar(0);

    try {
      const response = await sendToContentScript({ action: "deleteAllDays" });
      if (isErrorResponse(response)) throw new Error(response.error);
      if ("deleteSummary" in response) {
        const { deleteSummary } = response;
        showStatus(
          `Deleted ${deleteSummary.deleted}, skipped ${deleteSummary.skipped}, failed ${deleteSummary.failed}`,
          deleteSummary.failed > 0,
        );
      }
      deleteConfirmInput.value = "";
      await loadDeletableCount();
      await loadMissingDays();
    } catch (error) {
      showStatus(`Failed to delete entries: ${(error as Error).message}`, true);
    } finally {
      deleteAllButton.textContent = originalText;
      deleteAllButton.disabled = deleteConfirmInput.value !== "DELETE";
      progressContainer.style.display = "none";
    }
  });

  fillAllButton.addEventListener("click", async () => {
    fillAllButton.disabled = true;
    const originalText = fillAllButton.textContent;
    fillAllButton.textContent = "Filling…";
    progressContainer.style.display = "block";
    updateProgressBar(0);

    try {
      settings = readSettingsFromForm();
      await saveSettings(settings);
      const response = await sendToContentScript({ action: "fillAllDays", settings });
      if (isErrorResponse(response)) throw new Error(response.error);
      if ("summary" in response) {
        const { summary } = response;
        showStatus(
          `Filled ${summary.filled}, skipped ${summary.skipped}, failed ${summary.failed}`,
          summary.failed > 0,
        );
      }
      await loadMissingDays();
    } catch (error) {
      showStatus(`Failed to fill all missing days: ${(error as Error).message}`, true);
    } finally {
      fillAllButton.textContent = originalText;
      progressContainer.style.display = "none";
    }
  });

  try {
    mainContent.style.display = "flex";
    await loadMissingDays();
    await loadDeletableCount();
  } catch (error) {
    showStatus(`Failed to load: ${(error as Error).message}`, true);
  }
});
