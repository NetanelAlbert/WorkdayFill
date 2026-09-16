import { describe, expect, it } from "vitest";
import {
  buildChangeSummary,
  buildDateToOpenUri,
  buildSubmitParams,
  buildValidateParams,
  extractClientVersion,
  extractSessionSecureToken,
  hasFlowError,
  parseCalendarDays,
  parseFormattedDateFull,
  parseOpenResponse,
} from "../src/content/flow/parse";

describe("extractClientVersion", () => {
  it("pulls the numeric version out of the inline workday.clientVersion assignment", () => {
    const html = `<script>window.workday.clientVersion = 'Workday/2026.37.31 (HTML5)';</script>`;
    expect(extractClientVersion(html)).toBe("2026.37.31");
  });

  it("falls back to any Workday/<version> token", () => {
    expect(extractClientVersion("noise Workday/2026.40.2 more")).toBe("2026.40.2");
  });

  it("returns null when absent", () => {
    expect(extractClientVersion("<html>nothing here</html>")).toBeNull();
  });
});

describe("extractSessionSecureToken", () => {
  it("reads the 36-char token from a Workday JSON response", () => {
    const json = `{"a":1,"sessionSecureToken":"42b29abc-1234-5678-9abc-def012345678","b":2}`;
    expect(extractSessionSecureToken(json)).toBe("42b29abc-1234-5678-9abc-def012345678");
  });

  it("returns null when absent", () => {
    expect(extractSessionSecureToken(`{"no":"token"}`)).toBeNull();
  });
});

describe("parseFormattedDateFull", () => {
  it("parses Workday's long date into ISO", () => {
    expect(parseFormattedDateFull("Thursday, September 24, 2026")).toBe("2026-09-24");
    expect(parseFormattedDateFull("Tuesday, September 1, 2026")).toBe("2026-09-01");
    expect(parseFormattedDateFull("Friday, January 2, 2026")).toBe("2026-01-02");
  });

  it("returns null on unrecognized input", () => {
    expect(parseFormattedDateFull("not a date")).toBeNull();
  });
});

// A minimal model mirroring the real shape (RESEARCH.md §7.2): each day cell has formattedDateFull +
// totalForDay + two nested Enter Time commandButtons (the two calendar layouts) under a per-fetch
// context (`c13`) and mirror groups (450/456). Both URIs open the dialog; the parser takes the first
// and never hard-codes context/group numbers.
const CALENDAR_MODEL = JSON.stringify({
  widget: "root",
  children: [
    {
      widget: "calendarDay",
      formattedDateFull: { widget: "text", value: "Thursday, September 24, 2026" },
      totalForDay: { widget: "number", value: 0 },
      children: [
        {
          widget: "commandButtonList",
          children: [
            { widget: "commandButton", label: "Enter Time", values: [{ label: "data:6305", uri: "/axon/button/c13/450/1316" }] },
            { widget: "commandButton", label: "Enter Time", values: [{ label: "data:6305", uri: "/axon/button/c13/456/1316" }] },
          ],
        },
      ],
    },
    {
      widget: "calendarDay",
      formattedDateFull: { widget: "text", value: "Tuesday, September 1, 2026" },
      totalForDay: { widget: "number", value: 8.6 },
      children: [
        { widget: "commandButton", label: "Enter Time", values: [{ uri: "/axon/button/c13/450/1109" }] },
        { widget: "commandButton", label: "Enter Time", values: [{ uri: "/axon/button/c13/456/1109" }] },
      ],
    },
    {
      // A cell with no Enter Time action (e.g. a locked spillover day).
      widget: "calendarDay",
      formattedDateFull: { widget: "text", value: "Wednesday, September 30, 2026" },
      totalForDay: { widget: "number", value: 0 },
      children: [],
    },
  ],
});

describe("parseCalendarDays", () => {
  it("extracts date, hours, and the first open uri per day (context/group-agnostic)", () => {
    const days = parseCalendarDays(CALENDAR_MODEL);
    expect(days).toEqual([
      { date: "2026-09-24", totalHours: 0, openUri: "/axon/button/c13/450/1316" },
      { date: "2026-09-01", totalHours: 8.6, openUri: "/axon/button/c13/450/1109" },
      { date: "2026-09-30", totalHours: 0, openUri: null },
    ]);
  });

  it("returns [] on malformed JSON instead of throwing", () => {
    expect(parseCalendarDays("not json")).toEqual([]);
  });
});

describe("buildDateToOpenUri", () => {
  it("maps dates to uris and skips days without an action", () => {
    const map = buildDateToOpenUri(parseCalendarDays(CALENDAR_MODEL));
    expect(map.get("2026-09-24")).toBe("/axon/button/c13/450/1316");
    expect(map.get("2026-09-01")).toBe("/axon/button/c13/450/1109");
    expect(map.has("2026-09-30")).toBe(false);
  });
});

// Mirrors the real open-dialog response fragments (RESEARCH.md §7.1): the In field, the OK checkbox,
// its wrapping nyw:sequence container (whose id is the submit event id), and the flow key.
const OPEN_RESPONSE =
  `{"widget":"root",` +
  `"children":[{"widget":"timeInput","iid":"7356$8","required":true,"label":"In","timePrecision":"MINUTE","id":"1097/wd:In_Time","propertyName":"wd:In_Time","remoteValidate":true},` +
  `{"widget":"timeInput","iid":"7356$9","label":"Out","id":"1097/wd:Out_Time","propertyName":"wd:Out_Time","remoteValidate":true},` +
  `{"widget":"mutexButtonBar","children":[{"widget":"mutexButton","id":"mutextButtonId","mutex":{"widget":"checkBoxInput","label":"OK","value":false,"text":"","id":"1122/wd:OK","propertyName":"wd:OK"}}],"checkBox":true,"layoutInstanceId":"3011$1021"}],"id":"1125","propertyName":"nyw:sequence"}],` +
  `"flowExecutionKey":"e5s1","requestUri":"/axon/flowController","sessionSecureToken":"42b29abc-1234-5678-9abc-def012345678"}`;

describe("parseOpenResponse", () => {
  it("extracts the flow key, field prefix, OK ref, and submit id by structural shape", () => {
    expect(parseOpenResponse(OPEN_RESPONSE)).toEqual({
      flowKey: "e5s1",
      fieldPrefix: "1097",
      okRef: "1122/wd:OK",
      submitId: "1125",
    });
  });

  it("returns null when the response isn't a recognizable Enter Time dialog", () => {
    expect(parseOpenResponse(`{"widget":"root","error":"nope"}`)).toBeNull();
  });
});

describe("buildValidateParams", () => {
  it("splits the time into Workday's per-field params with the field-id event", () => {
    const params = buildValidateParams("1097", "In", "09:00", "2026-09-16");
    expect(params).toEqual({
      "1097/wd:In_Time_m": "00",
      "1097/wd:In_Time_H": "09",
      "1097/wd:In_Time_D": "16",
      "1097/wd:In_Time_M": "09",
      "1097/wd:In_Time_Y": "2026",
      _eventId_validate: "1097/wd:In_Time",
    });
  });

  it("handles the Out field and afternoon times", () => {
    const params = buildValidateParams("1097", "Out", "17:36", "2026-09-16");
    expect(params["1097/wd:Out_Time_H"]).toBe("17");
    expect(params["1097/wd:Out_Time_m"]).toBe("36");
    expect(params._eventId_validate).toBe("1097/wd:Out_Time");
  });
});

describe("buildChangeSummary / buildSubmitParams", () => {
  it("builds the OK change-summary XML with the given ref", () => {
    const xml = buildChangeSummary("1122/wd:OK");
    expect(xml).toContain(`<wd:OK Ref="1122/wd:OK" Replaced=""><V>1</V></wd:OK>`);
    expect(xml).toContain("wml:Change_Summary");
  });

  it("builds submit params from an OpenFlow", () => {
    const params = buildSubmitParams({ flowKey: "e5s1", fieldPrefix: "1097", okRef: "1122/wd:OK", submitId: "1125" });
    expect(params._eventId_submit).toBe("1125");
    expect(params["change-summary"]).toContain(`Ref="1122/wd:OK"`);
  });
});

describe("hasFlowError", () => {
  it("flags Workday error responses", () => {
    expect(hasFlowError(`{"messageType":"ERROR","text":"bad"}`)).toBe(true);
    expect(hasFlowError(`{"widget":"validationError"}`)).toBe(true);
  });

  it("does not flag a clean response", () => {
    expect(hasFlowError(`{"widget":"root","ok":true}`)).toBe(false);
  });
});
