import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateAt } from "./generator-helpers.mjs";

function event(uid, start, end, summary, ...properties) {
  return ["BEGIN:VEVENT", `UID:${uid}`, `DTSTART;VALUE=DATE:${start}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${summary}`, ...properties, "END:VEVENT"].join("\n");
}

function calendar(...entries) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...entries, "END:VCALENDAR"].join("\n");
}

function websiteBytes(read) {
  return ["hours", "special-hours"].map((name) => read(name).replace(/^  "generatedAt": .*\n/m, ""));
}

function compareWithHead(calendarText, baselineTime, runTime, check) {
  let baseline;
  generateAt(baselineTime, (read) => { baseline = websiteBytes(read); }, {
    calendar: calendarText, timeZone: "UTC", head: true,
  });
  generateAt(runTime, (read) => {
    assert.deepEqual(websiteBytes(read), baseline);
    check(read);
  }, { calendar: calendarText });
}

test("daily all-day series stays on November 2 across fall DST and matches HEAD in UTC", () => {
  const text = calendar(event("daily", "20261001", "20261002", "Open 12pm-8pm", "RRULE:FREQ=DAILY"));
  for (const runTime of ["2026-11-02T05:15:00Z", "2026-11-03T01:30:00Z"]) {
    compareWithHead(text, "2026-11-02T04:15:00Z", runTime, (read) => {
      assert.deepEqual(JSON.parse(read("hours")).rows[0], { day: "Today", open: "12 pm", close: "8 pm" });
      assert.deepEqual(JSON.parse(read("open-windows")).windows[0], {
        date: "2026-11-02", start: "2026-11-02T12:00:00-05:00", end: "2026-11-02T20:00:00-05:00",
      });
    });
  }
});

test("biweekly Sundays keep March 15, March 29 and April 12 across spring DST, matching HEAD", () => {
  const text = calendar(event("biweekly", "20260301", "20260302", "Open 12pm-8pm",
    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;UNTIL=20260412T235959Z"));
  for (const runTime of ["2026-03-15T04:15:00Z", "2026-03-16T00:30:00Z"]) {
    compareWithHead(text, "2026-03-15T04:15:00Z", runTime, (read) => {
      assert.deepEqual(JSON.parse(read("special-hours")).rows.map((row) => row.date), ["3/15", "3/29", "4/12"]);
      assert.deepEqual(JSON.parse(read("hours")).rows[0], { day: "Today", open: "12 pm", close: "8 pm" });
      assert.deepEqual(JSON.parse(read("open-windows")).windows[0], {
        date: "2026-03-15", start: "2026-03-15T12:00:00-04:00", end: "2026-03-15T20:00:00-04:00",
      });
    });
  }
});

test("Friday's overnight window survives Saturday midnight and expires at closing", () => {
  const overnight = { date: "2026-10-30", start: "2026-10-30T21:00:00-04:00", end: "2026-10-31T01:00:00-04:00" };
  generateAt("2026-10-31T04:15:00Z", (read) => {
    assert.deepEqual(JSON.parse(read("open-windows")).windows[0], overnight);
  });
  generateAt("2026-11-01T04:15:00Z", (read) => {
    assert.ok(!JSON.parse(read("open-windows")).windows.some((window) => window.date === overnight.date));
  });
});

const master = event("monday", "20261019", "20261020", "Open 12pm-8pm", "RRULE:FREQ=WEEKLY;BYDAY=MO");
const shortened = event("monday", "20261026", "20261027", "Open 2pm-6pm", "RECURRENCE-ID;VALUE=DATE:20261026");

test("shortened exception replaces its master, while different-UID entries still merge", () => {
  generateAt("2026-10-26T04:15:00Z", (read) => {
    assert.deepEqual(JSON.parse(read("open-windows")).windows.filter((window) => window.date === "2026-10-26"), [
      { date: "2026-10-26", start: "2026-10-26T14:00:00-04:00", end: "2026-10-26T18:00:00-04:00" },
    ]);
  }, { calendar: calendar(master, shortened) });
  generateAt("2026-10-26T04:15:00Z", (read) => {
    assert.deepEqual(JSON.parse(read("open-windows")).windows.filter((window) => window.date === "2026-10-26"), [
      { date: "2026-10-26", start: "2026-10-26T14:00:00-04:00", end: "2026-10-26T19:00:00-04:00" },
    ]);
  }, { calendar: calendar(master, shortened, event("independent", "20261026", "20261027", "Event 5pm-7pm")) });
});

test("cancelled exceptions suppress only their UID, even without event endpoints", () => {
  const cancelled = ["BEGIN:VEVENT", "UID:monday", "RECURRENCE-ID;VALUE=DATE:20261026", "STATUS:CANCELLED", "END:VEVENT"].join("\n");
  for (const independent of [false, true]) {
    generateAt("2026-10-26T04:15:00Z", (read) => {
      assert.deepEqual(JSON.parse(read("open-windows")).windows.filter((window) => window.date === "2026-10-26"), independent ? [
        { date: "2026-10-26", start: "2026-10-26T17:00:00-04:00", end: "2026-10-26T19:00:00-04:00" },
      ] : []);
    }, { calendar: calendar(master, cancelled, ...(independent ? [event("independent", "20261026", "20261027", "Event 5pm-7pm")] : [])) });
  }
});

test("a moved exception suppresses the original recurrence date", () => {
  const moved = event("monday", "20261027", "20261028", "Open 2pm-6pm", "RECURRENCE-ID;VALUE=DATE:20261026");
  generateAt("2026-10-26T04:15:00Z", (read) => {
    const windows = JSON.parse(read("open-windows")).windows;
    assert.ok(!windows.some((window) => window.date === "2026-10-26"));
    assert.deepEqual(windows[0], { date: "2026-10-27", start: "2026-10-27T14:00:00-04:00", end: "2026-10-27T18:00:00-04:00" });
  }, { calendar: calendar(master, moved) });
});

test("nonexistent spring-forward window is dropped without invalidating valid entries", () => {
  generateAt("2026-03-08T05:15:00Z", (read) => {
    assert.deepEqual(JSON.parse(read("open-windows")).windows, [
      { date: "2026-03-08", start: "2026-03-08T12:00:00-04:00", end: "2026-03-08T20:00:00-04:00" },
    ]);
  }, { calendar: calendar(
    event("nonexistent", "20260308", "20260309", "Event 2am-3am"),
    event("valid", "20260308", "20260309", "Open 12pm-8pm"),
  ) });
});

test("72 disjoint windows publish the earliest 64 and log one warning with counts", () => {
  const entries = [];
  const identities = [];
  for (let day = 0; day < 8; day++) {
    const date = new Date(2026, 9, 26 + day);
    const nextDate = new Date(2026, 9, 27 + day);
    const key = (value) => `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, "0")}${String(value.getDate()).padStart(2, "0")}`;
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    for (let hour = 0; hour < 9; hour++) {
      entries.push(event(`dense-${day}-${hour}`, key(date), key(nextDate), `Event ${hour || 12}am-${hour || 12}:30am`));
      identities.push(`${dateKey}T${String(hour).padStart(2, "0")}:00`);
    }
  }
  generateAt("2026-10-26T04:15:00Z", (read, result) => {
    const windows = JSON.parse(read("open-windows")).windows;
    assert.deepEqual(windows.map((window) => window.start.slice(0, 16)), identities.slice(0, 64));
    assert.deepEqual(result.stderr.trim().split(/\r?\n/), ["Open windows: publishing the earliest 64 of 72; omitting 8."]);
  }, { calendar: calendar(...entries) });
});

test("timed website hours remain identical at 00:15 and 12:15 Eastern", () => {
  const text = calendar([
    "BEGIN:VEVENT", "UID:timed", "DTSTART;TZID=America/New_York:20261026T090000",
    "DTEND;TZID=America/New_York:20261026T100000", "SUMMARY:Open 9am-10am", "END:VEVENT",
  ].join("\n"));
  let early;
  generateAt("2026-10-26T04:15:00Z", (read) => { early = websiteBytes(read); }, { calendar: text });
  generateAt("2026-10-26T16:15:00Z", (read) => {
    assert.deepEqual(websiteBytes(read), early);
    assert.deepEqual(JSON.parse(read("hours")).rows[0], { day: "Today", open: "9 am", close: "10 am" });
  }, { calendar: text });
});

test("malformed calendar URL fails without logging its URL or fake token", () => {
  const url = "invalid calendar URL/fake-private-token-review";
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../sync-hours-data.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, TZ: "America/New_York", PRIVATE_ICS_URL: url },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Hours data sync failed.");
  assert.ok(!result.stderr.includes(url));
  assert.ok(!result.stderr.includes("fake-private-token-review"));
});

test("HTTP failures log only fixed text and the status", () => {
  const script = fileURLToPath(new URL("../sync-hours-data.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { pathToFileURL } from 'node:url';
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'fake-token' });
    process.argv[1] = ${JSON.stringify(script)};
    await import(pathToFileURL(process.argv[1]));
  `], { encoding: "utf8", env: { ...process.env, PRIVATE_ICS_URL: "https://synthetic.invalid/fake-token" } });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Hours data sync failed (HTTP 503).");
});
