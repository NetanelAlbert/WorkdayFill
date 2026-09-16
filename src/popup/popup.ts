import { computeHours } from "../core/time";
import { DEFAULT_SETTINGS, LEGACY_DEFAULT_THROTTLE_MS, mergeSettings } from "../core/settings";
import type { Settings } from "../core/types";
import { isErrorResponse, type ProgressMessage, type Request, type Response } from "../messaging/protocol";
import { BONUSLY_GIVE_COMMAND, BUY_ME_A_COFFEE_URL, SLACK_URL } from "./support";

const WORKDAY_HOST = "myworkday.com";

async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(["settings", "throttleMigrated"]);
  const merged = mergeSettings(result.settings as Partial<Settings> | undefined);
  // One-time migration: existing users still on the old default delay get the new (lower) default.
  // Gated by a flag so it runs once — anyone who later sets the old value on purpose keeps it.
  if (!result.throttleMigrated) {
    if (merged.throttleMs === LEGACY_DEFAULT_THROTTLE_MS) merged.throttleMs = DEFAULT_SETTINGS.throttleMs;
    await chrome.storage.sync.set({ settings: merged, throttleMigrated: true });
  }
  return merged;
}

async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

/** User-provided bookmark to their own Enter Time page — never hardcoded, since the URL is
 *  tenant- and possibly user-specific. Stored separately from Settings (a fill/delete config, not
 *  a UI preference). */
async function loadEnterTimeUrl(): Promise<string> {
  const result = await chrome.storage.sync.get("enterTimeUrl");
  return typeof result.enterTimeUrl === "string" ? result.enterTimeUrl : "";
}

async function saveEnterTimeUrl(url: string): Promise<void> {
  await chrome.storage.sync.set({ enterTimeUrl: url });
}

/** Wires an (input, Go button) pair — shared by every empty-state that offers the Enter Time
 *  shortcut. All instances read/write the same stored URL, so filling it in from one empty-state
 *  carries over to the others on the next popup open. */
async function wireEnterTimeShortcut(inputId: string, buttonId: string): Promise<void> {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const button = document.getElementById(buttonId) as HTMLButtonElement;

  input.value = await loadEnterTimeUrl();
  button.disabled = input.value.trim() === "";
  input.addEventListener("input", () => {
    button.disabled = input.value.trim() === "";
  });
  input.addEventListener("change", () => {
    void saveEnterTimeUrl(input.value.trim());
  });
  button.addEventListener("click", async () => {
    const url = input.value.trim();
    if (!url) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.update(tab.id, { url });
  });
}

function readSettingsFromForm(): Settings {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const throttleRaw = el<HTMLInputElement>("throttleMs").value;
  return mergeSettings({
    inTime: el<HTMLInputElement>("inTime").value || DEFAULT_SETTINGS.inTime,
    outTime: el<HTMLInputElement>("outTime").value || DEFAULT_SETTINGS.outTime,
    comment: el<HTMLInputElement>("comment").value,
    engine: el<HTMLInputElement>("visibleMode").checked ? "dom" : "flow",
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
  el<HTMLInputElement>("visibleMode").checked = settings.engine === "dom";
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

function createDayItem(
  date: string,
  settings: Settings,
  onDone: () => void,
  onHeadlessFailure?: (reason: string) => void,
): HTMLElement {
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
        onHeadlessFailure?.(`Headless mode couldn't fill ${date}.`);
      }
    } catch (error) {
      showStatus(`Failed to fill ${date}: ${(error as Error).message}`, true);
      onHeadlessFailure?.(`Headless mode couldn't fill ${date}.`);
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

function pasteShortcutLabel(): string {
  const platform = navigator.platform || "";
  return /mac/i.test(platform) ? "⌘V" : "Ctrl+V";
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
    const divider = link.previousElementSibling;
    const dividerEl = divider instanceof HTMLElement && divider.classList.contains("support-divider")
      ? divider
      : null;
    if (!coffeeHref) {
      link.hidden = true;
      if (dividerEl) dividerEl.hidden = true;
      continue;
    }
    link.href = coffeeHref;
    link.hidden = false;
    if (dividerEl) dividerEl.hidden = false;
  }

  const commandEl = document.getElementById("bonuslyCommand")!;
  commandEl.textContent = BONUSLY_GIVE_COMMAND;

  const pasteKey = pasteShortcutLabel();
  const hintEl = document.getElementById("supportHint")!;
  hintEl.textContent = `Then paste (${pasteKey}) in the chat and hit Enter.`;

  const slackLink = document.getElementById("bonuslySupportLink") as HTMLAnchorElement;
  const slackHref = slackDesktopHref();
  if (!slackHref) {
    slackLink.removeAttribute("href");
    return;
  }
  slackLink.href = slackHref;
  slackLink.addEventListener("click", () => {
    void navigator.clipboard.writeText(BONUSLY_GIVE_COMMAND).then(
      () => showSupportStatus(`✓ Copied! Paste (${pasteKey}) in the chat and send.`),
      () => showSupportStatus(`Message me in Slack: ${BONUSLY_GIVE_COMMAND}`),
    );
  });
}

function wireDisclosure(toggleId: string, panelId: string, shownDisplay = "flex"): void {
  const toggle = document.getElementById(toggleId) as HTMLButtonElement;
  const panel = document.getElementById(panelId)!;
  toggle.addEventListener("click", () => {
    const hidden = panel.style.display === "none";
    panel.style.display = hidden ? shownDisplay : "none";
    toggle.setAttribute("aria-expanded", String(hidden));
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const mainContent = document.getElementById("mainContent")!;
  const wrongSiteMessage = document.getElementById("wrongSiteMessage")!;
  const notEnterTimeMessage = document.getElementById("notEnterTimeMessage")!;
  const selectorsStaleMessage = document.getElementById("selectorsStaleMessage")!;
  const pageStatusText = document.getElementById("pageStatusText")!;
  const missingCount = document.getElementById("missingCount")!;
  const missingDaysContainer = document.getElementById("missingDays")!;
  const loadingEl = document.getElementById("loading")!;
  const fillAllButton = document.getElementById("fillAll") as HTMLButtonElement;
  const versionEl = document.getElementById("version")!;
  const userChip = document.getElementById("userChip")!;
  const progressContainer = document.getElementById("progressContainer")!;
  const deletableCountText = document.getElementById("deletableCountText")!;
  const deleteConfirmInput = document.getElementById("deleteConfirmInput") as HTMLInputElement;
  const deleteAllButton = document.getElementById("deleteAllButton") as HTMLButtonElement;
  const headlessFallback = document.getElementById("headlessFallback")!;
  const headlessFallbackText = document.getElementById("headlessFallbackText")!;
  const switchToVisibleButton = document.getElementById("switchToVisibleButton") as HTMLButtonElement;

  /** Shows the "switch to Visible mode" prompt — only relevant while the headless engine is active. */
  function suggestVisibleFallback(reason: string): void {
    if (settings.engine !== "flow") return;
    headlessFallbackText.textContent = `${reason} You can switch to Visible mode (drive the on-screen calendar) and try again.`;
    headlessFallback.style.display = "flex";
  }
  function hideVisibleFallback(): void {
    headlessFallback.style.display = "none";
  }

  versionEl.textContent = chrome.runtime.getManifest().version;
  wireSupportLinks();

  await wireEnterTimeShortcut("enterTimeUrlInput", "openEnterTimeButton");
  await wireEnterTimeShortcut("wrongSiteEnterTimeUrlInput", "wrongSiteOpenEnterTimeButton");

  let settings = await loadSettings();
  writeSettingsToForm(settings);
  updateHoursPreview(settings);

  const persistAndRefreshPreview = async () => {
    settings = readSettingsFromForm();
    await saveSettings(settings);
    updateHoursPreview(settings);
  };
  ["inTime", "outTime", "comment", "visibleMode", "dryRun", "safeTestDate", "throttleMs"].forEach((id) => {
    document.getElementById(id)!.addEventListener("change", persistAndRefreshPreview);
  });

  wireDisclosure("toggleAdvanced", "advancedPanel");
  wireDisclosure("toggleDays", "missingDays");
  wireDisclosure("aboutButton", "aboutInfo", "block");
  wireDisclosure("toggleDanger", "dangerPanel");

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

  async function loadMissingDays(): Promise<boolean> {
    hideVisibleFallback();
    loadingEl.style.display = "block";
    missingDaysContainer.innerHTML = "";
    missingDaysContainer.appendChild(loadingEl);
    fillAllButton.disabled = true;

    const pageInfoResponse = await sendToContentScript({ action: "getPageInfo" });
    if (isErrorResponse(pageInfoResponse)) {
      if (pageInfoResponse.code === "SELECTORS_NOT_FOUND") {
        selectorsStaleMessage.style.display = "flex";
        mainContent.style.display = "none";
        loadingEl.style.display = "none";
        return false;
      }
      throw new Error(pageInfoResponse.error);
    }
    if ("isEnterTime" in pageInfoResponse) {
      if (!pageInfoResponse.isEnterTime) {
        notEnterTimeMessage.style.display = "flex";
        mainContent.style.display = "none";
        loadingEl.style.display = "none";
        return false;
      }
      notEnterTimeMessage.style.display = "none";
      mainContent.style.display = "flex";
      const monthLabel = pageInfoResponse.month?.label ?? "the current month";
      pageStatusText.textContent = `Enter Time detected — ${monthLabel}`;
      if (pageInfoResponse.workerName) {
        userChip.textContent = pageInfoResponse.workerName;
        userChip.style.display = "inline-block";
      }
    }

    const response = await sendToContentScript({ action: "getMissingDays", settings });
    loadingEl.style.display = "none";
    if (isErrorResponse(response)) {
      suggestVisibleFallback("Headless mode couldn't load your calendar.");
      throw new Error(response.error);
    }
    if (!("missingDays" in response)) return true;

    const days = response.missingDays;
    missingCount.textContent = String(days.length);
    missingDaysContainer.innerHTML = "";

    if (days.length === 0) {
      missingDaysContainer.innerHTML =
        '<div style="text-align:center;padding:8px;color:var(--success-dark);">No missing days found</div>';
      fillAllButton.disabled = true;
      return true;
    }

    days.forEach((date) => {
      missingDaysContainer.appendChild(createDayItem(date, settings, loadMissingDays, suggestVisibleFallback));
    });
    fillAllButton.disabled = false;
    return true;
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
      // Nothing filled but failures — headless likely can't reach Workday; offer the fallback.
      const allFailed =
        "summary" in response && response.summary.filled === 0 && response.summary.failed > 0;
      if ("summary" in response) {
        const { summary } = response;
        showStatus(
          `Filled ${summary.filled}, skipped ${summary.skipped}, failed ${summary.failed}`,
          summary.failed > 0,
        );
      }
      await loadMissingDays(); // hides any prior fallback, then re-scans
      if (allFailed) suggestVisibleFallback("Headless mode couldn't fill your days.");
    } catch (error) {
      showStatus(`Failed to fill all missing days: ${(error as Error).message}`, true);
      suggestVisibleFallback("Headless mode couldn't fill your days.");
    } finally {
      fillAllButton.textContent = originalText;
      progressContainer.style.display = "none";
    }
  });

  // Switching engines changes how missing days are detected (the headless engine reads worked hours
  // from a fresh server fetch, the DOM engine from the rendered page), so re-scan on toggle. Runs
  // after persistAndRefreshPreview has already updated `settings` from the form.
  document.getElementById("visibleMode")!.addEventListener("change", () => {
    void loadMissingDays().catch((error) => showStatus(`Failed to reload: ${(error as Error).message}`, true));
  });

  // The fallback banner's one-click action: turn on Visible mode, persist, and re-scan.
  switchToVisibleButton.addEventListener("click", async () => {
    (document.getElementById("visibleMode") as HTMLInputElement).checked = true;
    settings = readSettingsFromForm();
    await saveSettings(settings);
    updateHoursPreview(settings);
    hideVisibleFallback();
    showStatus("Switched to Visible mode.");
    try {
      await loadMissingDays();
      await loadDeletableCount();
    } catch (error) {
      showStatus(`Failed to reload: ${(error as Error).message}`, true);
    }
  });

  try {
    const isReady = await loadMissingDays();
    if (isReady) await loadDeletableCount();
  } catch (error) {
    showStatus(`Failed to load: ${(error as Error).message}`, true);
  }
});
