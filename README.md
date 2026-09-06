# WorkdayFill

Unofficial browser extension that auto-fills missing weekdays in Workday's **Enter Time** calendar,
mirroring [HibobFill](https://github.com/NetanelAlbert/HibobFill) for Workday. Not affiliated with or
endorsed by Workday.

See [RESEARCH.md](RESEARCH.md) for the reverse-engineering notes this implementation is built on.

If the extension saves you time, the popup has optional support links: give a Bonusly in the Slack
desktop app (copies `/give +100 @nalbert Thanks for the Workday extension #own-it`), or buy a coffee
once that page is set up.

## How it works (Approach A — DOM automation)

Workday's Enter Time save flow is a stateful, token-guarded Spring-WebFlow sequence (see RESEARCH.md
§3), not a simple REST call. Rather than replaying that flow headlessly, WorkdayFill **drives the real
page**: for each empty weekday it clicks the calendar cell, types In/Out, and clicks OK — Workday's own
JavaScript then emits all the correct flow/token requests. No token or flow-key management needed.

The codebase is split so the decision logic is pure and unit-tested, while all DOM interaction is
isolated behind a `FillEngine` interface (`src/content/engine/`) — leaving room for a future headless
`FlowReplayEngine` (Approach B) once the WebFlow responses are captured (RESEARCH.md §6).

```
src/core/      pure logic — no DOM — unit tested (missing-day rules, time math, settings)
src/content/   the content script: selectors, DOM wait/scan helpers, the DomFillEngine, RPC listener
src/popup/     the extension popup UI
src/messaging/ the typed request/response contract shared by popup ↔ content script
```

## Build & test

```bash
npm install
npm run dev        # Vite + CRXJS dev build with HMR/auto-reload
npm run build       # production build -> dist/
npm run test        # Vitest — pure core logic only, no jsdom
npm run typecheck   # tsc --noEmit
```

Load the extension in Chrome via `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `dist/` folder. After `npm run build`, reload the extension from that page to pick up changes.

## Selectors — live-verified

`src/content/selectors.ts` holds real `data-automation-id` values discovered against a live, logged-in
Enter Time page (September 2026, Axon tenant), and the full fill flow was verified end-to-end with one
real save (see "Verification log" below). This is the **one file to patch** when Workday's UI changes:

1. Open the Enter Time task in Chrome with the extension loaded, DevTools open.
2. List every automation id on the page: `[...document.querySelectorAll('[data-automation-id]')].map(e => e.getAttribute('data-automation-id'))`.
3. Identify the ids for: an empty day cell, a cell with an existing "Hours Worked" entry, a holiday
   cell, a time-off cell, the "Enter Time" modal, its In/Out inputs, the Hours readout, the OK/Cancel
   buttons, and the save toast. Update `SELECTORS` accordingly.
4. Rebuild (`npm run build`) and reload the unpacked extension.

If a selector is wrong, the popup shows a **"WorkdayFill needs an update"** banner instead of failing
silently or writing something unexpected.

Two behaviors worth knowing when re-verifying: (1) day classification (holiday / has-entry / weekend)
is read entirely from each cell's `aria-label` text, not from child elements — Workday puts everything
needed there (e.g. `"Holiday Sunday, September 20, 2026 | 2 events | Yom Kippur | Hours: 8.6"`). (2)
Opening the "Enter Time" modal takes **two clicks**, not one: the first click only selects/focuses the
cell, and a second click on the now-selected cell opens the dialog. A lone click, or a synthetic
double-click on an unselected cell, does not reliably open it (`DomFillEngine.openCell`).

### Verification log

- **2026-09-02**: read-only DOM discovery of all selectors above; typed real values into In/Out and
  confirmed Hours computed to `8.6` client-side, then cancelled — no entry written.
- **2026-09-02**: one real save on **September 28, 2026** (a designated safe test day) completed the
  full flow — modal opened, fields validated, OK committed. Confirmed via the calendar: the cell's
  `aria-label` became `"...| 1 event | Hours: 8.6"`, and the month summary's Total Hours moved
  `159.6 -> 168.2` and Regular `133.8 -> 142.4`, with the error count dropping by one. This also
  confirmed `SELECTORS.busySpinner` (`wd-LoadingPanel`, appears during the post-save refresh). The
  save toast itself dismissed before it could be captured, so `SELECTORS.toast` remains a best-effort,
  unconfirmed secondary signal — not load-bearing, since modal-gone + re-scanned `hasEntry` (now
  proven live) is the primary commit check `fillDay` relies on.
- **2026-09-03**: bulk-deleted a full month of test entries by hand to reset the tenant for further
  testing, which mapped out the delete flow: a cell with an existing entry shows a "more" chevron
  (`calendarMoreLink`, shared across every cell — must be matched to the target cell by position, see
  `findChevronForCell`); clicking it opens a small popover listing that day's events, scoped via the
  popover's own close button (`popoverEntry`'s automation-id is shared by every entry chip on the whole
  page, so it must never be queried document-wide — see `findPopoverEntries`); the popover's own entry
  row opens an edit dialog with a `Delete` button, which pops Workday's own `Delete Time Block?`
  confirmation. Initially concluded the popover's entry row needed a genuine trusted click (two separate
  synthetic-event attempts did nothing) — that conclusion was wrong: both attempts queried the shared
  `popoverEntry` selector document-wide and fired events on an unrelated entry elsewhere on the page.
  Once scoped correctly, the entire flow (chevron → entry → Delete → confirm OK) works with a fully
  synthetic pointerdown/mousedown/pointerup/mouseup/click sequence — no real click ever required. A day
  with a holiday marker alongside a real entry still reports `hasEntry: true` after that entry is
  deleted (the holiday's own accrual remains), so delete verification compares the cell's raw event
  count before/after rather than the `hasEntry` flag.

## Live-testing safety

Every fill against the real Enter Time page writes a **real, "Not Submitted" draft attendance entry** to
your account. **There is no way to preview a fill without writing it.** Confirmed live, the hard way:
Workday's flow commits the entry as soon as both In and Out validate — clicking Cancel afterward does
NOT undo it. So dry run does **not** do what its name once implied here; it stops before touching the
real In/Out fields at all, and can only verify the day is genuinely empty and the modal opens on the
expected Time Type. If you turn it off, the very next attempt writes real data — there's no dry-run
rehearsal of that specific write.

1. **Use a safe test date.** The advanced settings panel has a "safe test date" field — when set, every
   other missing day is skipped, so a single-day test can't accidentally touch the rest of the month.
2. **Verify one real fill** on that safe test date with dry run off: confirm the cell now shows 8.6h and
   "Not Submitted". If it was only a test, the popup's danger zone (below) can remove it again.
3. Only then try **Fill all missing days**, for real — `maxDaysPerRun` (in `core/settings.ts`, default
   40) caps a single run.

## Deleting entries (danger zone)

The popup's collapsed "danger zone" section permanently deletes every real "Hours Worked" entry for the
visible month — the same mechanism validated in the verification log below, now behind a type-`DELETE`-
to-confirm gate. Holiday markers and the "Time Period End" boundary are never touched (only entries whose
own popover row says "Hours Worked" are matched); a day that turns out to have nothing deletable is
skipped, not errored. There is no dry run for delete — Workday's own "Delete Time Block?" confirmation is
the only checkpoint, and the action is irreversible from WorkdayFill's side (re-entering the hours is a
normal fill, done through the same popup). Use `deleteDay`/`getDeletableDays` directly if you need finer
control than the bulk button.

## Testing strategy

- **Unit tests** (`npm run test`) cover the pure `src/core/` logic — which days need filling, time
  parsing/formatting/hour computation, and settings merging — with zero DOM dependencies.
- **DOM automation is validated live**, not against a fixture: Workday's markup is the thing most likely
  to change, so a hand-built or captured HTML snapshot would go stale exactly where it matters and give
  false confidence. See "Selectors need live discovery" and "Live-testing safety" above for that loop.
