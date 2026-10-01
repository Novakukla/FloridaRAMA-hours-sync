import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildOpenWindows as generateOpenWindows, parseIcsEvents } from "../sync-hours-data.mjs";
import { prepareGeneratedFile } from "../prepare-hours-commit.mjs";
import { assertOpenWindowsDocument, generateAt } from "./generator-helpers.mjs";

process.env.TZ = "America/New_York";
const fixtureText = readFileSync(new URL("./fixtures/open-windows.ics", import.meta.url), "utf8");
const events = parseIcsEvents(fixtureText);
const pinnedNow = new Date("2026-10-26T04:15:00Z");
function buildOpenWindows(events, now) {
  const windows = generateOpenWindows(events, now);
  assertOpenWindowsDocument({ generatedAt: now.toISOString(), timeZone: "America/New_York", windows });
  return windows;
}
const expectedWindows = [
  { date: "2026-10-26", start: "2026-10-26T12:00:00-04:00", end: "2026-10-26T22:00:00-04:00" },
  { date: "2026-10-27", start: "2026-10-27T12:00:00-04:00", end: "2026-10-27T20:00:00-04:00" },
  { date: "2026-10-28", start: "2026-10-28T16:00:00-04:00", end: "2026-10-28T23:00:00-04:00" },
  { date: "2026-10-30", start: "2026-10-30T21:00:00-04:00", end: "2026-10-31T01:00:00-04:00" },
  { date: "2026-10-31", start: "2026-10-31T12:00:00-04:00", end: "2026-10-31T19:30:00-04:00" },
  { date: "2026-10-31", start: "2026-10-31T21:00:00-04:00", end: "2026-10-31T23:00:00-04:00" },
  { date: "2026-11-01", start: "2026-11-01T00:00:00-04:00", end: "2026-11-01T04:00:00-05:00" },
  { date: "2026-11-02", start: "2026-11-02T12:00:00-05:00", end: "2026-11-02T19:30:00-05:00" },
];

test("synthetic ICS produces all eight days' windows with merging, closures, filters, and DST offsets", () => {
  assert.deepEqual(buildOpenWindows(events, pinnedNow), expectedWindows);
  assert.deepEqual(buildOpenWindows([...events].reverse(), pinnedNow), expectedWindows);
});

test("recurring Closed does not suppress recurring bonus hours", () => {
  const bonus = events.find((event) => event.uid === "tuesday-bonus");
  const closed = events.find((event) => event.uid === "legacy-closed-tuesdays");
  assert.deepEqual(buildOpenWindows([closed, { ...bonus, rrule: "FREQ=WEEKLY;BYDAY=TU" }], pinnedNow), [expectedWindows[1]]);
});

test("spring DST uses each endpoint's actual Eastern offset", () => {
  const windows = buildOpenWindows(events, new Date("2026-03-08T05:15:00Z"));
  assert.deepEqual(windows.find((window) => window.date === "2026-03-08"), {
    date: "2026-03-08", start: "2026-03-08T00:00:00-05:00", end: "2026-03-08T04:00:00-04:00",
  });
});

function singleEvent(summary) {
  return [{ summary, start: new Date(2026, 9, 26), end: new Date(2026, 9, 27) }];
}

test("missing opening meridiem chooses the earlier interpretation", () => {
  assert.equal(buildOpenWindows(singleEvent("Event 11-2pm"), pinnedNow)[0].start, "2026-10-26T11:00:00-04:00");
  assert.equal(buildOpenWindows(singleEvent("Event 10-2am"), pinnedNow)[0].start, "2026-10-26T22:00:00-04:00");
});

test("equal close and open means the next day; invalid and absent ranges are ignored", () => {
  assert.deepEqual(buildOpenWindows(singleEvent("Event 12pm to 12pm"), pinnedNow), [
    { date: "2026-10-26", start: "2026-10-26T12:00:00-04:00", end: "2026-10-27T12:00:00-04:00" },
  ]);
  for (const summary of ["Event 13pm-2pm", "Event 4:99pm-8pm", "Closed", "Zack_OOO"]) {
    assert.deepEqual(buildOpenWindows(singleEvent(summary), pinnedNow), []);
  }
});

test("generator preserves website file bytes against baselines from the original code at 04:15 UTC", () => {
  generateAt(pinnedNow.toISOString(), (read) => {
    const omitGeneratedAt = (text) => text.replace(/^  "generatedAt": .*\n/m, "");
    for (const name of ["hours", "special-hours"]) {
      const baseline = readFileSync(new URL(`./fixtures/${name}-before.json`, import.meta.url), "utf8");
      assert.equal(omitGeneratedAt(read(name)), omitGeneratedAt(baseline));
    }
    assert.deepEqual(JSON.parse(read("open-windows")), {
      generatedAt: pinnedNow.toISOString(), timeZone: "America/New_York", windows: expectedWindows,
    });
  });
});

test("hourly generator at 20:30 Eastern keeps Today on the Eastern date", () => {
  generateAt("2026-10-29T00:30:00Z", (read) => {
    // Wednesday has a buyout; Thursday has Closed. Website selection remains the original code's.
    assert.deepEqual(JSON.parse(read("hours")).rows[0], { day: "Today", open: "4", close: "11 pm" });
    assert.deepEqual(JSON.parse(read("open-windows")).windows[0], expectedWindows[2]);
  });
});

test("timestamp-only hourly updates preserve bytes until the Eastern date changes", () => {
  const payload = (generatedAt, extra = {}) => JSON.stringify({ generatedAt, rows: [{ open: "12 pm" }], ...extra }, null, 2) + "\n";
  const committed = payload("2026-10-26T04:15:00Z");
  assert.equal(prepareGeneratedFile(payload("2026-10-27T00:30:00Z"), committed), committed);
  const nextDay = payload("2026-10-27T04:15:00Z");
  assert.equal(prepareGeneratedFile(nextDay, committed), nextDay);
  const changed = payload("2026-10-26T05:15:00Z", { rows: [{ open: "1 pm" }] });
  assert.equal(prepareGeneratedFile(changed, committed), changed);
  const windows = payload("2026-10-26T05:15:00Z", { windows: expectedWindows, timeZone: "America/New_York" });
  assert.equal(prepareGeneratedFile(windows, committed), windows);
});
