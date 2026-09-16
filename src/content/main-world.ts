/**
 * MAIN-world helper for the headless flow engine.
 *
 * Runs in the PAGE's world at document_start. Its job: tell the isolated content script which URL
 * returns Workday's Enter Time calendar model. The signed, per-month URL can't be reconstructed and
 * the isolated world can't see the page's network, so we observe it here (RESEARCH.md §7.2/§7.3).
 *
 * Rather than guess URL shapes (which vary: the task launcher `/axon/task/<id>.htmld` on load, the
 * calendar `…/rel-task/2997$9444.htmld` on month navigation, deep-linked `/inst/…` URLs), we recognize
 * the model by its RESPONSE CONTENT — any candidate request whose body looks like the calendar model
 * (has day cells + the session token + Enter Time button uris). That's robust to however the page was
 * entered. The winning URL (query stripped) + HTTP method are written to DOM attributes the isolated
 * content script reads. No chrome.* APIs (none exist here); only same-origin URLs/bodies already
 * accessible to the page are read.
 */

const URL_ATTR = "data-wf-model-url";
const METHOD_ATTR = "data-wf-model-method";
// Limit body inspection to endpoints that can return the model: the task launcher, or any rel-task
// calendar fetch (any prefix). ($ is escaped to a literal in these ids.)
const CANDIDATE = /\/axon\/task\/\d+\$\d+\.htmld|rel-task\/2997\$9444/;

function looksLikeModel(text: unknown): boolean {
  return (
    typeof text === "string" &&
    text.length > 5000 &&
    text.includes('"formattedDateFull"') &&
    text.includes('"sessionSecureToken"') &&
    text.includes("/axon/button/")
  );
}

function store(url: string, method: string): void {
  try {
    const u = new URL(url, location.href);
    u.search = ""; // the engine adds its own clientRequestID
    document.documentElement.setAttribute(URL_ATTR, u.href);
    document.documentElement.setAttribute(METHOD_ATTR, (method || "GET").toUpperCase());
  } catch {
    // non-URL argument — ignore
  }
}

// Immediate best guess from the page path (task launcher), so the attribute exists even before any
// fetch resolves. The content-verified capture below refines/overrides it once a real model arrives.
try {
  const m = /\/task\/(\d+\$\d+)\.htmld/.exec(location.pathname);
  if (m) store(`${location.origin}/axon/task/${m[1]}.htmld`, "GET");
} catch {
  // ignore
}

const originalFetch = window.fetch;
if (typeof originalFetch === "function") {
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method =
      (args[1] && args[1].method) || (input instanceof Request ? input.method : "GET") || "GET";
    const promise = originalFetch.apply(this, args);
    if (CANDIDATE.test(url)) {
      promise
        .then((res) =>
          res
            .clone()
            .text()
            .then((t) => {
              if (looksLikeModel(t)) store(url, method);
            })
            .catch(() => {}),
        )
        .catch(() => {});
    }
    return promise;
  };
}

interface TaggedXHR extends XMLHttpRequest {
  __wfUrl?: string;
  __wfMethod?: string;
}
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (this: TaggedXHR, ...args: unknown[]) {
  this.__wfMethod = typeof args[0] === "string" ? args[0] : "GET";
  this.__wfUrl = typeof args[1] === "string" ? args[1] : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalOpen as any).apply(this, args);
};
XMLHttpRequest.prototype.send = function (this: TaggedXHR, ...args: unknown[]) {
  if (this.__wfUrl && CANDIDATE.test(this.__wfUrl)) {
    this.addEventListener("loadend", () => {
      try {
        if (looksLikeModel(this.responseText)) store(this.__wfUrl!, this.__wfMethod || "GET");
      } catch {
        // responseText not accessible (e.g. non-text responseType) — ignore
      }
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalSend as any).apply(this, args);
};
