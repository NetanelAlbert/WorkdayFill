/**
 * Thin network layer for the headless flow-replay engine. Every state-changing Workday request is a
 * same-origin `application/x-www-form-urlencoded` POST that carries the session cookie automatically
 * (`credentials:"include"`), plus the app-level `X-Workday-Client` / `Session-Secure-Token` headers and
 * the `sessionSecureToken` + a fresh `clientRequestID` in the body (RESEARCH.md §2/§7.5).
 *
 * This is deliberately the ONLY place that talks to the network, so the parsing (parse.ts) and the
 * orchestration (FlowReplayEngine) stay testable without mocking `fetch`.
 */

export interface FlowResponse {
  status: number;
  text: string;
}

export class WorkdayFlowClient {
  constructor(
    private readonly token: string,
    private readonly clientVersion: string,
    private readonly origin: string = location.origin,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** 32-char hex, unique per request — Workday rejects reused ids on writes (RESEARCH.md §2). */
  private newClientRequestId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private encode(params: Record<string, string>): string {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  }

  /** POSTs a write request (adds token + fresh clientRequestID + auth headers). `path` is origin-relative. */
  async post(path: string, params: Record<string, string> = {}): Promise<FlowResponse> {
    const body = this.encode({
      ...params,
      sessionSecureToken: this.token,
      clientRequestID: this.newClientRequestId(),
    });
    const res = await this.fetchImpl(this.origin + path, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Workday-Client": this.clientVersion,
        "Session-Secure-Token": this.token,
      },
      body,
    });
    return { status: res.status, text: await res.text() };
  }

  /** Opens the Enter Time dialog for a day: `openUri` is the model's action uri; `.htmld` is appended. */
  openDialog(openUri: string): Promise<FlowResponse> {
    return this.post(`${openUri}.htmld`);
  }

  /** Fires a flowController step (validate or submit) for an already-open flow. */
  flowController(flowKey: string, params: Record<string, string>): Promise<FlowResponse> {
    return this.post("/axon/flowController.htmld", { _flowExecutionKey: flowKey, ...params });
  }

  /**
   * Fetches the calendar model. This is a read: it succeeds on the session cookie alone (no
   * session-secure token — RESEARCH.md §7.3), which is how the engine bootstraps the token before it
   * has one. The task launcher is a GET; the month-navigation calendar endpoint is a POST — the
   * MAIN-world helper reports which, so we honor it. A fresh `clientRequestID` is included either way.
   */
  static async fetchCalendarModel(
    source: { url: string; method: string },
    clientVersion: string,
    fetchImpl: typeof fetch = (...args) => fetch(...args),
  ): Promise<FlowResponse> {
    const clientRequestID = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const isPost = source.method.toUpperCase() === "POST";
    const url = isPost
      ? source.url
      : source.url + (source.url.includes("?") ? "&" : "?") + `clientRequestID=${clientRequestID}`;
    const res = await fetchImpl(url, {
      method: isPost ? "POST" : "GET",
      credentials: "include",
      headers: {
        ...(isPost ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        "X-Workday-Client": clientVersion,
      },
      body: isPost ? `clientRequestID=${clientRequestID}` : undefined,
    });
    return { status: res.status, text: await res.text() };
  }
}
