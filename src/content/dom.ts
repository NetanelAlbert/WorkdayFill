import { to12Hour } from "../core/time";
import { SELECTORS } from "./selectors";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fires a full pointerdown/mousedown/pointerup/mouseup/click sequence, confirmed live to be
 * necessary for Workday's calendar cell: a plain `el.click()` (a single synthetic 'click' event
 * with no preceding pointer/mouse events) does NOT trigger its selection state at all — the
 * widget must be listening lower in the event pipeline than 'click' alone.
 */
function fireMouseSequence(el: Element, detail: number): void {
  const base: MouseEventInit = { bubbles: true, cancelable: true, view: window, detail };
  el.dispatchEvent(new PointerEvent("pointerdown", base));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", base));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
}

/** Selects/focuses a calendar cell — confirmed live: the first step toward opening its dialog. */
export function fireCellSelect(el: Element): void {
  fireMouseSequence(el, 1);
}

/**
 * Opens an already-selected calendar cell's dialog. Confirmed live: a second full click sequence
 * alone is NOT enough — an explicit 'dblclick' event (detail 2) is what actually opens it.
 */
export function fireCellOpen(el: Element): void {
  fireMouseSequence(el, 2);
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2 }));
}

function isInteractable(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  const disabled = (el as HTMLInputElement).disabled === true;
  return htmlEl.offsetParent !== null && !disabled;
}

export interface WaitOptions {
  root?: ParentNode;
  timeout?: number;
  /** Require the matched element to be visible/interactable, not just present. Default true. */
  visible?: boolean;
}

/** Polls (via MutationObserver + an immediate check) until `selector` matches, or rejects on timeout. */
export function waitForElement<T extends Element = Element>(
  selector: string,
  { root = document, timeout = 8000, visible = true }: WaitOptions = {},
): Promise<T> {
  const check = (): T | null => {
    const el = root.querySelector<T>(selector);
    if (!el) return null;
    if (visible && !isInteractable(el)) return null;
    return el;
  };

  const existing = check();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const found = check();
      if (found) {
        cleanup();
        resolve(found);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for '${selector}' after ${timeout}ms`));
    }, timeout);
    function cleanup() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(root instanceof Document ? root.body : (root as Node), {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

/** Resolves once `selector` no longer matches anything under `root`, or rejects on timeout. */
export function waitForGone(
  selector: string,
  { root = document, timeout = 8000 }: WaitOptions = {},
): Promise<void> {
  if (!root.querySelector(selector)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!root.querySelector(selector)) {
        cleanup();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for '${selector}' to disappear after ${timeout}ms`));
    }, timeout);
    function cleanup() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(root instanceof Document ? root.body : (root as Node), {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

/** Resolves once an element matching `selector` contains `substring`, or rejects on timeout. */
export function waitForText(
  selector: string,
  substring: string,
  { root = document, timeout = 8000 }: WaitOptions = {},
): Promise<Element> {
  const check = (): Element | null => {
    for (const el of root.querySelectorAll(selector)) {
      if (el.textContent?.includes(substring)) return el;
    }
    return null;
  };

  const existing = check();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const found = check();
      if (found) {
        cleanup();
        resolve(found);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for '${selector}' to contain '${substring}' after ${timeout}ms`));
    }, timeout);
    function cleanup() {
      observer.disconnect();
      clearTimeout(timer);
    }
    observer.observe(root instanceof Document ? root.body : (root as Node), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

/**
 * Sets a form element's value through its native property setter so frameworks that track value
 * changes via a wrapped setter (React-style) still observe the update.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  descriptor?.set?.call(el, value);
}

/** Types a 24h 'HH:mm' value into a Workday time field and fires the events that trigger its on-blur validate. */
export async function setTimeField(
  el: HTMLInputElement | HTMLTextAreaElement,
  hhmm: string,
): Promise<void> {
  el.focus();
  el.select();
  setNativeValue(el, to12Hour(hhmm));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

/** Sets a free-text field (e.g. the comment textarea) without the time-of-day conversion. */
export async function setTextField(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  el.focus();
  el.select();
  setNativeValue(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

/**
 * Waits for Workday's on-blur server validate (triggered by setTimeField) to settle: the busy
 * spinner disappears if it ever appeared, and the modal subtree goes quiet for a short window.
 */
export async function waitForValidation(
  { root = document, timeout = 6000 }: WaitOptions = {},
): Promise<void> {
  const spinner = root.querySelector(SELECTORS.busySpinner);
  if (spinner) {
    await waitForGone(SELECTORS.busySpinner, { root, timeout });
  }
  await waitForQuiescence(root, { timeout, quietMs: 350 });
}

function waitForQuiescence(
  root: ParentNode,
  { timeout, quietMs }: { timeout: number; quietMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let quietTimer: ReturnType<typeof setTimeout>;
    const overallTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for DOM to settle after ${timeout}ms`));
    }, timeout);

    const observer = new MutationObserver(resetQuietTimer);

    function resetQuietTimer() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, quietMs);
    }

    function cleanup() {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(overallTimer);
    }

    observer.observe(root instanceof Document ? root.body : (root as Node), {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    resetQuietTimer();
  });
}
