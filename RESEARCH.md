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

- ~~**Capture the RESPONSES** (steps 0–2)~~ — **DONE for step 0**, see §7 below. The open‑dialog
  response is JSON and contains everything approach B needs (`flowExecutionKey`, the `1097` field id,
  the `1122/wd:OK` + `1125` submit ids, and even the `sessionSecureToken`). Steps 1–2 (validate) and
  step 3 (submit) responses still require a **real write** to capture and were not captured (a write
  is irreversible per the eager‑commit behavior in §3 / README "Live‑testing safety").
- Confirm the **Time Type** selection request (it defaulted to `Hours Worked`; a non‑default type would
  add its own validate round‑trip and a `wd:Time_Type` field).
- Find the **"which days are missing"** source (calendar task JSON) and the **holiday/time‑off** markers
  to skip, mirroring HibobFill's `needsAttendanceFilling()`. (The DOM scan in `src/content/scan.ts`
  already does this from cell `aria-label`s; a data‑endpoint source was not needed for approach A.)
- Verify behavior for **editing/deleting** an existing entry (opens the same dialog pre‑filled).
- Task/instance ids seen: calendar task `2997$4767`, entry rel‑task `2997$9444`, sidebar `2997$17619`,
  worker instance `6305`.

---

## 7. Response capture (2026‑09‑16) — approach B partially unblocked

Live re‑capture in the logged‑in Axon tenant (Enter Time, September 2026), using the same page‑injected
`fetch`/`XHR` interceptor described in the tooling note above — this pass recorded **request *and*
response bodies**. Opened two empty weekdays' dialogs (Sep 23 & 24) **read‑only** (open → Cancel, no
field edits → nothing committed; verified the calendar's Total Hours stayed 103.2 and both cells stayed
empty). Tenant runtime now reports `omsVersion 2026.37` (was `2026.35.34`), confirming the version token
drifts across the weekly service update.

### 7.1 Step 0 (open dialog) response — the key that unlocks the rest

`POST /axon/button/c0/450/1316.htmld` (Sep 24) returned **32 KB of JSON** (`{"widget":"root",…}`). Every
per‑flow id approach B needs is in it — so approach B does **not** need to hard‑code any of the numeric
ids; it parses them out of this one response:

| Needed value | Where in the step‑0 JSON | Example |
|---|---|---|
| Flow instance key | `…,"flowExecutionKey":"e1s1",…` | `e1s1` (shape `e{exec}s{state}`) |
| Submit endpoint | `…,"requestUri":"/axon/flowController",…` | `/axon/flowController` (no `.htmld`) |
| Session‑secure token | `…,"sessionSecureToken":"<UUID>",…` | present in‑body (also a request header) |
| **In** field | `{"widget":"timeInput","iid":"7356$8","required":true,"label":"In","timePrecision":"MINUTE","id":"1097/wd:In_Time","propertyName":"wd:In_Time","remoteValidate":true}` | field prefix `1097` |
| **Out** field | `{"widget":"timeInput","iid":"7356$9",…,"label":"Out","id":"1097/wd:Out_Time","propertyName":"wd:Out_Time","remoteValidate":true}` | same `1097` prefix |
| **OK** button | `{"widget":"mutexButton",…,"mutex":{"widget":"checkBoxInput","label":"OK","value":false,"id":"1122/wd:OK","propertyName":"wd:OK"}}` | ref `1122/wd:OK` |
| Submit event id | the sequence container wrapping OK: `…}],"id":"1125","propertyName":"nyw:sequence…"` | `_eventId_submit` = `1125` |

So RESEARCH.md §3's field id `1097` and button ids `1122/1125` were **all confirmed** — and, importantly,
they are emitted in the step‑0 response, keyed structurally (`widget`/`label`/`propertyName`), so they can
be located by shape rather than by their tenant‑specific numbers.

### 7.2 The per‑cell open button id IS discoverable — from the calendar model (fully headless unblocked)

The open request body is only `sessionSecureToken=<UUID>&clientRequestID=<HEX32>` — **it carries no
date**. The day is bound entirely by the button URL's last segment, which is **per‑cell and regenerated
on every calendar render** (e.g. across two renders Sep 24 was `…/450/1316`, then `…/454/1320`; Sep 23
`…/450/1307`). It is **not** in the cell DOM and **not** in the cell's React props (walked 12 fiber
levels: only layout props).

**But it *is* in the calendar model response.** The month grid is rendered from a JSON model fetched at:

```
POST /axon/calendar/c0/inst/6305!<base64-blob>*<sig>~/rel-task/2997$9444.htmld
```

(`6305` = worker instance; the `<blob>*<sig>~` encodes the month range and is server‑signed, so it must
be *obtained*, not reconstructed — see §7.3.) That response (~114–250 KB JSON, `{"widget":"root",…}`)
contains one day‑cell object per grid cell (35 for a 5‑week grid), each with:

- `formattedDateFull.value` — plaintext date, e.g. `"Thursday, September 24, 2026"` (→ parse to ISO).
- `totalForDay.value` — worked hours for the day (`8.6`, or `0`/absent when empty).
- a `commandButton` with `label:"Enter Time"` whose `values[0].uri` is that day's **open URI**, under
  two mirror groups (`/c0/454/<id>` and `/c0/460/<id>`, same `<id>`). **Group `454` is the one that
  opens the Enter Time dialog** (verified: `POST /axon/button/c0/454/1320.htmld` returned the dialog).

So: fetch the model → walk to each `formattedDateFull` cell → read its `.../454/<id>` Enter Time uri →
`date → openUri` map. **Fully headless (zero‑DOM, pure `fetch`) is feasible and was verified live** (§7.7).
The model also carries the `sessionSecureToken` (§7.3) and enough per‑day data (`totalForDay`, events) to
classify days without the DOM, though reusing the DOM `scanCalendar` for missing‑day detection (a read,
not UI‑driving) is simpler and already battle‑tested.

### 7.3 MV3 isolated‑world constraint & how the extension bootstraps

A content script runs in an **isolated world** and cannot read the page's `window` globals
(`window.wdapi`/`WDApi` hold the secure token; `window.workday.flow` exposes
`updateValue`/`addInstance(s)`/`removeInstance(s)`; `window.workday.clientVersion` etc.). It turns out
the flow‑replay needs **none** of those page globals — everything is obtainable from the isolated world:

- **`X-Workday-Client`** header value (e.g. `2026.37.31`): the page HTML contains an inline
  `workday.clientVersion = 'Workday/2026.37.31 (HTML5)'`; a content script reads it with a regex over the
  script text (`/clientVersion\s*=\s*'Workday\/([\d.]+)/`). (The runtime `window.workday.clientVersion`
  is the *short* `2026.37.31`, which is what the header actually sends — extract the `\d{4}\.\d+\.\d+`.)
- **`sessionSecureToken`**: the calendar‑model fetch (§7.2) works **cookie‑only** (no token needed to
  *read* it — verified 200 with the token absent from header and body); its response body contains
  `"sessionSecureToken":"<UUID>"`. Parse it there, then reuse it for all writes.
- **Calendar‑model URL** (the signed blob): the one thing not trivially available from a cold isolated
  world. Obtain it via a tiny **MAIN‑world** fetch/XHR interceptor (`world:"MAIN"`) that records the
  page's own `…/axon/calendar/…/rel-task/2997$9444.htmld` request URL and `postMessage`s it across, or
  via a `chrome.webRequest` URL observer in the background. (Reconstruction is out — the blob is signed.)

### 7.4 Consequence for the engine design (`FlowReplayEngine`, fully headless)

Implements the same `FillEngine` interface as `DomFillEngine`. Per fill:

1. Bootstrap once: get calendar‑model URL (§7.3) + `X-Workday-Client`; `fetch` the model (cookie‑only) →
   parse `sessionSecureToken` and the `date → openUri` map.
2. `POST <openUri>.htmld` (open) → parse `flowExecutionKey`, field prefix (`\d+/wd:In_Time`), OK ref
   (`\d+/wd:OK`), and the submit event id (the `nyw:sequence` container's `id`) from the response.
3. `POST /axon/flowController.htmld` validate‑In, then validate‑Out (§7.5).
4. `POST /axon/flowController.htmld` submit with the `change-summary` XML (§7.5).

No modal, no typing, no clicks. See §7.5 for exact payloads and §7.7 for the live verification.

### 7.5 Exact request payloads (captured verbatim, 2026‑09‑16, real UI fill of Sep 24)

All are `POST` with headers `Content-Type: application/x-www-form-urlencoded`, `X-Workday-Client`,
`Session-Secure-Token`, `stats-perf` (perf telemetry — non‑essential), and `credentials:"include"`.
Every body also carries `sessionSecureToken=<UUID>` and a **fresh** `clientRequestID=<HEX32>` (32‑char
hex, unique per request). The four write steps share one `_flowExecutionKey` obtained from the open.

**0 — Open** `POST /axon/button/c0/454/<perCellId>.htmld` — body: just `sessionSecureToken` +
`clientRequestID`. Response = 32 KB dialog JSON (§7.1).

**1 — Validate In** `POST /axon/flowController.htmld`
```
_flowExecutionKey=e6s1
1097/wd:In_Time_m=00
1097/wd:In_Time_H=09
1097/wd:In_Time_D=16          ← D/M/Y are TODAY, not the entry date. Only H:m matter; the entry's
1097/wd:In_Time_M=09            date is bound to the flow instance (opened for that cell), so the
1097/wd:In_Time_Y=2026          date parts here are ignored.
_eventId_validate=1097/wd:In_Time   ← the event value is the field id being validated
```

**2 — Validate Out** — identical shape with `Out_Time` and `_eventId_validate=1097/wd:Out_Time`
(`_m=36 _H=17` for 17:36). Per README, the draft **commits once both In and Out validate** — the OK
submit only finalizes; Cancel after this does NOT undo it.

**3 — Submit (OK)** `POST /axon/flowController.htmld`
```
_flowExecutionKey=e6s1
_eventId_submit=1125
change-summary=<wml:Change_Summary xmlns:wml="http://www.workday.com/ns/model/1.0"
  xmlns:wd="urn:com.workday/bsvc" xmlns:nyw="urn:com.netyourwork/aod">
  <wd:OK Ref="1122/wd:OK" Replaced=""><V>1</V></wd:OK></wml:Change_Summary>
```
(`1125` = the submit sequence container id; `1122/wd:OK` = the OK button ref; both from the open
response.) After submit, the calendar cell's `totalForDay`/summary update and the error count drops.

**Delete (bonus, for a future headless delete)** — the final confirm of the "Delete Time Block?" dialog
is `POST /axon/flowController.htmld` with just `_flowExecutionKey=<key>` + `_eventId_submit=108` (no
change‑summary). The steps before it (open the entry's edit dialog, click Delete to raise the confirm)
were not fully mapped for a pure‑fetch delete; `DomFillEngine.deleteDay` remains the delete path for now.

### 7.7 Live verification (2026‑09‑16)

- **Real UI fill of Sep 24** (the authorized write) succeeded end‑to‑end and gave the ground truth in
  §7.5: cell showed `Hours: 8.6` / "Not Submitted", Total Hours 103.2 → 111.8, Regular 77.4 → 86,
  errors 11 → 10. Then **deleted** it (capturing §7.5's delete confirm), returning to 103.2 / 11 errors.
- **Headless open confirmed:** `POST /axon/button/c0/454/1320.htmld` via `fetch` (no click) returned the
  32 KB dialog JSON with a live `flowExecutionKey` — repeatedly (`e5s1`, `e10s1`).
- **Headless pipeline confirmed (non‑committing):** from a cold `fetch` — calendar model (200, cookie‑only)
  → parse Sep 24 openUri → open (200, `flowExecutionKey`, field `1097`) → **validate‑In (200, no error)**.
  Stopped before validate‑Out + submit (those commit; the automated write was blocked by a client‑side
  safety classifier). validate‑Out is byte‑for‑byte the same shape as validate‑In, and the submit payload
  is the verbatim §7.5 capture from the successful UI write, so the remaining two steps are known‑good
  requests fired over the already‑proven `fetch` path. Sep 24 was left empty (that flow abandoned).
