# WorkdayFill — Workday "Enter Time" Reverse‑Engineering Notes

Goal: replicate [HibobFill](https://github.com/NetanelAlbert/HibobFill) (auto‑fill missing attendance
days) but for **Workday** time tracking. This doc captures the network flow observed while manually
filling an empty day, so a browser extension can reproduce it programmatically.

Investigation done live in the logged‑in Axon Workday tenant on the **Enter Time** task, filling two
empty weekdays (Sep 23 & 24, 2026) with the standard pattern **Time Type "Hours Worked", In 09:00,
Out 17:36 → 8.6h** (matches every other weekday in the month).

> ⚠️ **Tooling note:** the browser MCP `read_network_requests` only lists URL/method/status — it
> captures **neither request headers nor request bodies**. Everything below (headers, payloads,
> tokens) was captured by injecting a `fetch` + `XMLHttpRequest` interceptor into the page (the
> DevTools‑equivalent). Any future re‑capture must use the interceptor or DevTools HAR, not that tool.

---

## 1. The page

- URL: `https://www.myworkday.com/axon/d/task/2997$4767.htmld` → title **"Enter Time"**, a monthly
  calendar per employee (worker "Nati Albert").
- Clicking an empty weekday cell opens an **"Enter Time"** modal with fields:
  - **Time Type** (defaults to `Hours Worked`)
  - **In** \* / **Out** \* (clock in/out, `h:mm AM/PM`)
  - **Out Reason** (defaults to `Out`)
  - **Hours** (computed from In/Out; e.g. 09:00→17:36 = 8.6)
  - **Comment** (optional)
- On save, a toast **"Your changes have been saved"** appears; the entry state is **"Not Submitted"**
  (saved as draft, not yet submitted for approval — same as all existing entries).

---

## 2. Auth model

Workday is authenticated by the **browser session cookie**, which is **httpOnly** (not readable from
JS — good). A same‑origin `fetch`/`XHR` with `credentials: "include"` carries it automatically, exactly
like HibobFill. In addition, **two app‑level tokens** are required on every write request:

| What | Where | Value shape | Notes |
|------|-------|-------------|-------|
| Session cookie | `Cookie:` header (browser‑managed, httpOnly) | — | Not visible to JS. Sent automatically. |
| **`Session-Secure-Token`** | **request header** AND body param `sessionSecureToken` | 36‑char UUID | Same value in both places. This is the CSRF/session‑secure token. |
| **`X-Workday-Client`** | request header | `2026.35.34` | Workday UI/app version. |
| **`clientRequestID`** | body param (also `?clientRequestID=` on GETs) | 32‑char hex (UUID, no dashes) | **Unique per request** — generate a fresh one each call. |
| **`_flowExecutionKey`** | body param | e.g. `e6s1` | Spring‑WebFlow style `e{exec}s{state}`. Identifies the live dialog flow instance. **Same across all steps of one dialog**; obtained from the dialog‑open response. |

JS‑visible (non‑secret, diagnostic) cookies only: `sessionLoggingInfo`, `UserSignedIn`,
`LastUserActivity`, `SessionTimeoutMS`. No usable auth token is exposed in the page HTML —
`Session-Secure-Token` comes from the app runtime (`window.workday` / `WorkdayApp`), not a `<meta>`.

---

## 3. Request sequence for filling one day

Workday uses a **stateful, multi‑step flow** (NOT a single REST POST like HibobFill). Every field edit
round‑trips to the server; the final OK just fires a submit event against the already‑updated flow.

| # | Method | Endpoint | Purpose | Key body params |
|---|--------|----------|---------|-----------------|
| 0 | POST | `/axon/button/c9/454/1290.htmld` | **Open the dialog** for the clicked day. Returns flow instance + field IDs. | `sessionSecureToken`, `clientRequestID` |
| 1 | POST | `/axon/flowController.htmld` | **Validate In** (on blur). | `_flowExecutionKey`, `1097/wd:In_Time_{m,H,D,M,Y}`, `_eventId_validate`, `sessionSecureToken`, `clientRequestID` |
| 2 | POST | `/axon/flowController.htmld` | **Validate Out** (on blur). | `_flowExecutionKey`, `1097/wd:Out_Time_{m,H,D,M,Y}`, `_eventId_validate`, `sessionSecureToken`, `clientRequestID` |
| 3 | POST | `/axon/flowController.htmld` | **Submit / commit (OK click) — THE SAVE.** | `_flowExecutionKey`, `_eventId_submit` (=`1125`), `change-summary` (XML), `sessionSecureToken`, `clientRequestID` |
| 4–8 | GET/DELETE/POST | `/axon/inst/…/rel-task/2997$9444.htmld` (×2), `/axon/clear-page-context/c5.htmld` (DELETE), `/axon/calendar/sidebar/task/2997$17619.htmld` (POST), toast JS asset | Post‑save UI refresh (reload calendar/summary, clear stale page context, redraw sidebar, show toast). Not required for the write itself. |

- `Content-Type: application/x-www-form-urlencoded` on all POSTs; also send `stats-perf` header
  (perf telemetry, non‑essential).
- The `c9` / `c5` and numeric segments (`454/1290`, field id `1097`, button ids `1122/1125`) are
  **page/flow‑context‑specific**, not stable constants — they must be discovered at runtime.

### Time encoding (In/Out)

Each time is split into 5 form fields under the field prefix (`1097/wd:In_Time_*`, `1097/wd:Out_Time_*`):

```
In  09:00 → In_Time_m=00  In_Time_H=09  In_Time_D=02  In_Time_M=09  In_Time_Y=2026
Out 17:36 → Out_Time_m=36 Out_Time_H=17 Out_Time_D=02 Out_Time_M=09 Out_Time_Y=2026
```

- `m`=minute, `H`=hour(24h), `D`=day, `M`=month, `Y`=year.
- **Only the time‑of‑day (H:m) matters.** The date part (`D/M/Y`) came out as **today** (2026‑09‑02),
  NOT the entry's date (Sep 24). The entry's actual calendar date is bound by the flow instance
  (opened for that day in step 0), not by these fields.

### The submit payload (`change-summary`)

The commit body's `change-summary` is XML that only records the **OK button press** — the field values
were already applied server‑side by steps 1–2:

```xml
<wml:Change_Summary xmlns:wml="http://www.workday.com/ns/model/1.0"
                    xmlns:wd="urn:com.workday/bsvc"
                    xmlns:nyw="urn:com.netyourwork/aod">
  <wd:OK Ref="1122/wd:OK" Replaced=""><V>1</V></wd:OK>
</wml:Change_Summary>
```

---

## 4. HibobFill vs Workday — why this is harder

| | HibobFill | Workday |
|---|---|---|
| API style | Clean REST, single stateless `POST /api/attendance/.../entries` with JSON body | Stateful Spring‑WebFlow: open → validate → validate → submit, shared `_flowExecutionKey` |
| Auth | Session cookie + `x-requested-with` header | Session cookie (httpOnly) + `Session-Secure-Token` (header & body) + `X-Workday-Client` + per‑request `clientRequestID` |
| Field values | Sent directly in the save body | Applied incrementally via `_eventId_validate` round‑trips; save body just fires OK |
| IDs | Stable REST paths | Per‑flow context ids (`c9/454/1290`, field `1097`, buttons `1122/1125`) discovered at runtime |
| "Missing days" | Dedicated `views/search` endpoint returns them | Not yet investigated — likely parse the calendar task response for cells without a `Hours Worked` event |

---

## 5. Recommended implementation strategy

Two viable approaches for the WorkdayFill extension (MV3, content‑script in `*.myworkday.com`, same
pattern as HibobFill):

- **A. DOM automation (recommended first cut, robust):** drive the real page — for each empty day,
  click the cell, set In/Out fields, click OK; let Workday's own JS emit the correct flow requests.
  No token/flow‑key management. Downside: tied to UI, needs the calendar page open.

- **B. Flow replay via `fetch` (headless, fragile):** replicate steps 0→3 with `credentials:"include"`,
  scraping `_flowExecutionKey` + the numeric field/button ids from each response, minting a fresh
  `clientRequestID` per call and reusing the page's `Session-Secure-Token`/`X-Workday-Client`.
  More like HibobFill but must parse Workday's WebFlow responses.

Either way, detect empty weekdays from the calendar (cells with no "Hours Worked" event, skipping
weekends/holidays/time‑off), and reuse a configurable default (In `09:00`, Out `17:36` → 8.6h).

---

## 6. Open questions / next steps

- **Capture the RESPONSES** (steps 0–2) to map exactly where `_flowExecutionKey`, the field id `1097`,
  and button ids `1122/1125` are emitted — needed for approach B. (This pass captured requests only.)
- Confirm the **Time Type** selection request (it defaulted to `Hours Worked`; a non‑default type would
  add its own validate round‑trip and a `wd:Time_Type` field).
- Find the **"which days are missing"** source (calendar task JSON) and the **holiday/time‑off** markers
  to skip, mirroring HibobFill's `needsAttendanceFilling()`.
- Verify behavior for **editing/deleting** an existing entry (opens the same dialog pre‑filled).
- Task/instance ids seen: calendar task `2997$4767`, entry rel‑task `2997$9444`, sidebar `2997$17619`,
  worker instance `6305`.
