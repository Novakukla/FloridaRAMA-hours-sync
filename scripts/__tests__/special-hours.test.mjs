import assert from "node:assert/strict";
import test from "node:test";

import { buildSevenDayHours, buildSpecialNotes, buildSpecialRows, parseIcsEvents } from "../sync-hours-data.mjs";

const pinnedNow = new Date(2026, 5, 24, 9, 0, 0, 0);

function calendar(...events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR"].join("\n");
}

test("weekly recurring special hours expand across the lookahead window", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:bonus-weekly",
        "DTSTART;TZID=America/New_York:20260630T120000",
        "DTEND;TZID=America/New_York:20260630T200000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804T235959Z",
        "SUMMARY:Bonus Hours 12pm-8pm",
        "END:VEVENT",
      ].join("\n"),
      [
        "BEGIN:VEVENT",
        "UID:bonus-note-weekly",
        "DTSTART;TZID=America/New_York:20260630T120000",
        "DTEND;TZID=America/New_York:20260630T200000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804T235959Z",
        "SUMMARY:NOTE: Bonus Hours are available on Tuesdays.",
        "END:VEVENT",
      ].join("\n")
    )
  );

  assert.deepEqual(buildSpecialRows(events, pinnedNow), [
    { type: "Bonus Hours", date: "6/30", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/7", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/14", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/21", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/28", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "8/4", open: "12 pm", close: "8 pm" },
  ]);

  assert.deepEqual(
    buildSpecialNotes(events, pinnedNow),
    Array.from({ length: 6 }, () => ({ text: "Bonus Hours are available on Tuesdays." }))
  );
});

test("non-recurring special hours still produce one row", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:single-special",
        "DTSTART;TZID=America/New_York:20260704T090000",
        "DTEND;TZID=America/New_York:20260704T220000",
        "SUMMARY:Special Hours 9am-10pm",
        "END:VEVENT",
      ].join("\n")
    )
  );

  assert.deepEqual(buildSpecialRows(events, pinnedNow), [
    { type: "Bonus Hours", date: "7/4", open: "9 am", close: "10 pm" },
  ]);
});

test("recurrence-id override wins over the synthetic master occurrence", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:bonus-weekly",
        "DTSTART;TZID=America/New_York:20260630T120000",
        "DTEND;TZID=America/New_York:20260630T200000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804T235959Z",
        "SUMMARY:Bonus Hours 12pm-8pm",
        "END:VEVENT",
      ].join("\n"),
      [
        "BEGIN:VEVENT",
        "UID:bonus-weekly",
        "RECURRENCE-ID;TZID=America/New_York:20260714T120000",
        "DTSTART;TZID=America/New_York:20260714T140000",
        "DTEND;TZID=America/New_York:20260714T180000",
        "SUMMARY:Bonus Hours 2pm-6pm",
        "END:VEVENT",
      ].join("\n")
    )
  );

  const rows = buildSpecialRows(events, pinnedNow);
  assert.equal(rows.filter((row) => row.date === "7/14").length, 1);
  assert.deepEqual(rows.find((row) => row.date === "7/14"), {
    type: "Bonus Hours",
    date: "7/14",
    open: "2 pm",
    close: "6 pm",
  });
});

test("closed baseline recurrence does not hide Tuesday bonus hours", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:closed-tuesdays",
        "DTSTART;VALUE=DATE:20231025",
        "DTEND;VALUE=DATE:20231026",
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
        "SUMMARY:Closed",
        "END:VEVENT",
      ].join("\n"),
      [
        "BEGIN:VEVENT",
        "UID:exhibit-tuesdays",
        "DTSTART;VALUE=DATE:20260630",
        "DTEND;VALUE=DATE:20260701",
        "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804",
        "SUMMARY:Exhibit 12pm-8pm",
        "END:VEVENT",
      ].join("\n")
    )
  );

  assert.deepEqual(buildSpecialRows(events, pinnedNow), [
    { type: "Bonus Hours", date: "6/30", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/7", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/14", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/21", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "7/28", open: "12 pm", close: "8 pm" },
    { type: "Bonus Hours", date: "8/4", open: "12 pm", close: "8 pm" },
  ]);
});

test("standard hours uses special Tuesday hours instead of the closed baseline", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:closed-tuesday",
        "DTSTART;VALUE=DATE:20260707",
        "DTEND;VALUE=DATE:20260708",
        "SUMMARY:Closed",
        "END:VEVENT",
      ].join("\n"),
      [
        "BEGIN:VEVENT",
        "UID:bonus-tuesday",
        "DTSTART;TZID=America/New_York:20260707T120000",
        "DTEND;TZID=America/New_York:20260707T200000",
        "SUMMARY:Exhibit 12pm-8pm",
        "END:VEVENT",
      ].join("\n")
    )
  );

  assert.deepEqual(buildSevenDayHours(events, new Date(2026, 6, 7, 9, 0, 0, 0))[0], {
    day: "Today",
    open: "12 pm",
    close: "8 pm",
  });
});

test("closed event on a normally-open day wins over a non-differing open recurrence", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:normal-fridays",
        "DTSTART;VALUE=DATE:20260626",
        "DTEND;VALUE=DATE:20260627",
        "RRULE:FREQ=WEEKLY;BYDAY=FR",
        "SUMMARY:Open 12pm-8pm",
        "END:VEVENT",
      ].join("\n"),
      [
        "BEGIN:VEVENT",
        "UID:closed-friday",
        "DTSTART;VALUE=DATE:20260703",
        "DTEND;VALUE=DATE:20260704",
        "SUMMARY:Closed",
        "END:VEVENT",
      ].join("\n")
    )
  );

  assert.deepEqual(buildSpecialRows(events, pinnedNow), [
    { type: "Limited Hours", date: "7/3", open: "Closed", close: "Closed" },
  ]);
});

test("closed recurrence on normally-closed Tuesdays produces no special row by itself", () => {
  const events = parseIcsEvents(
    calendar(
      [
        "BEGIN:VEVENT",
        "UID:closed-tuesdays",
        "DTSTART;VALUE=DATE:20231025",
        "DTEND;VALUE=DATE:20231026",
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
        "SUMMARY:Closed",
        "END:VEVENT",
      ].join("\n")
    )
  );

  assert.deepEqual(buildSpecialRows(events, pinnedNow), []);
});
