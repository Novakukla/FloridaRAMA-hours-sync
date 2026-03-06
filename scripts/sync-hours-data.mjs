import { writeFileSync } from "node:fs";

const ICS_URL = process.env.PRIVATE_ICS_URL;

if (!ICS_URL) {
  throw new Error("Missing PRIVATE_ICS_URL environment variable.");
}

const LOOKAHEAD_DAYS = 30;
const NORMAL_HOURS_BY_WEEKDAY = {
  0: { open: "10:00", close: "20:00" },
  1: { open: "12:00", close: "20:00" },
  2: null,
  3: null,
  4: { open: "12:00", close: "20:00" },
  5: { open: "12:00", close: "20:00" },
  6: { open: "10:00", close: "20:00" },
};

function unfoldIcsLines(icsText) {
  return icsText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
}

function parseIcsDate(value) {
  if (!value) {
    return null;
  }

  if (/^\d{8}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    return new Date(year, month, day, 0, 0, 0, 0);
  }

  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    const hours = Number(value.slice(9, 11));
    const minutes = Number(value.slice(11, 13));
    const seconds = Number(value.slice(13, 15));
    return new Date(Date.UTC(year, month, day, hours, minutes, seconds));
  }

  if (/^\d{8}T\d{6}$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    const hours = Number(value.slice(9, 11));
    const minutes = Number(value.slice(11, 13));
    const seconds = Number(value.slice(13, 15));
    return new Date(year, month, day, hours, minutes, seconds);
  }

  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function decodeIcsText(text) {
  return text.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseIcsEvents(icsText) {
  const unfolded = unfoldIcsLines(icsText);
  const lines = unfolded.split("\n");
  const events = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }

    if (line === "END:VEVENT") {
      if (current?.start && current?.end) {
        events.push(current);
      }
      current = null;
      continue;
    }

    if (!current || !line || !line.includes(":")) {
      continue;
    }

    const [left, ...valueParts] = line.split(":");
    const value = valueParts.join(":");
    const fieldName = left.split(";")[0].toUpperCase();

    if (fieldName === "SUMMARY") {
      current.summary = decodeIcsText(value);
    } else if (fieldName === "UID") {
      current.uid = value;
    } else if (fieldName === "RECURRENCE-ID") {
      current.recurrenceId = value;
    } else if (fieldName === "DTSTART") {
      current.start = parseIcsDate(value);
      current.isAllDay = /^\d{8}$/.test(value);
    } else if (fieldName === "DTEND") {
      current.end = parseIcsDate(value);
    } else if (fieldName === "STATUS") {
      current.status = value;
    } else if (fieldName === "RRULE") {
      current.rrule = value;
    }
  }

  return events;
}

function parseRRule(rruleText) {
  const parts = (rruleText || "").split(";");
  const rrule = {};

  for (const part of parts) {
    if (!part.includes("=")) {
      continue;
    }
    const [key, value] = part.split("=");
    rrule[key.toUpperCase()] = value;
  }

  return rrule;
}

function startOfWeek(date) {
  const result = new Date(date);
  const day = result.getDay();
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - day);
  return result;
}

function getNextRecurringOccurrence(event, now) {
  if (!event.rrule || !event.start || !event.end) {
    return null;
  }

  const rrule = parseRRule(event.rrule);
  const freq = (rrule.FREQ || "").toUpperCase();
  const interval = Math.max(1, Number(rrule.INTERVAL || 1));
  const until = parseIcsDate(rrule.UNTIL || "");
  const durationMs = event.end.getTime() - event.start.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (durationMs <= 0) {
    return null;
  }

  const isWithinUntil = (startDate) => {
    if (!until) {
      return true;
    }
    return startDate.getTime() <= until.getTime();
  };

  if (freq === "DAILY") {
    let startDate = new Date(event.start);

    if (startDate.getTime() < now.getTime()) {
      const diffDays = Math.floor((now.getTime() - startDate.getTime()) / dayMs);
      const jumps = Math.floor(diffDays / interval);
      startDate = new Date(startDate.getTime() + jumps * interval * dayMs);

      while (startDate.getTime() + durationMs < now.getTime()) {
        startDate = new Date(startDate.getTime() + interval * dayMs);
      }
    }

    if (!isWithinUntil(startDate)) {
      return null;
    }

    return {
      ...event,
      synthetic: true,
      start: startDate,
      end: new Date(startDate.getTime() + durationMs),
    };
  }

  if (freq === "WEEKLY") {
    const byDayMap = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const byDays = (rrule.BYDAY || "")
      .split(",")
      .map((value) => byDayMap[value])
      .filter((value) => value !== undefined);

    const allowedDays = byDays.length ? byDays : [event.start.getDay()];
    const originWeek = startOfWeek(event.start);
    const searchStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    for (let offset = 0; offset <= 370; offset++) {
      const probeDate = new Date(searchStart.getTime() + offset * dayMs);
      if (!allowedDays.includes(probeDate.getDay())) {
        continue;
      }

      const probeWeek = startOfWeek(probeDate);
      const weekDiff = Math.floor((probeWeek.getTime() - originWeek.getTime()) / (7 * dayMs));
      if (weekDiff < 0 || weekDiff % interval !== 0) {
        continue;
      }

      const occurrenceStart = new Date(probeDate);
      occurrenceStart.setHours(
        event.start.getHours(),
        event.start.getMinutes(),
        event.start.getSeconds(),
        event.start.getMilliseconds()
      );

      if (occurrenceStart.getTime() + durationMs < now.getTime()) {
        continue;
      }

      if (!isWithinUntil(occurrenceStart)) {
        return null;
      }

      return {
        ...event,
        synthetic: true,
        start: occurrenceStart,
        end: new Date(occurrenceStart.getTime() + durationMs),
      };
    }
  }

  return null;
}

function getDisplayEvents(events, now) {
  const displayEvents = [];

  for (const event of events) {
    if (!event.start || !event.end) {
      continue;
    }

    if (event.end.getTime() >= now.getTime()) {
      displayEvents.push(event);
      continue;
    }

    const recurringOccurrence = getNextRecurringOccurrence(event, now);
    if (recurringOccurrence) {
      displayEvents.push(recurringOccurrence);
    }
  }

  return displayEvents;
}

function formatDayLabel(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatScrapedTime(timeText) {
  const value = (timeText || "").trim().toLowerCase();
  if (!value) {
    return "";
  }

  const normalized = value
    .replace(/\s+/g, "")
    .replace(/a\.m\./g, "am")
    .replace(/p\.m\./g, "pm")
    .replace(/a\.m/g, "am")
    .replace(/p\.m/g, "pm");

  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
  if (!match) {
    return timeText;
  }

  const hour = Number(match[1]);
  const minutes = match[2];
  const meridiem = match[3] ? ` ${match[3].toLowerCase()}` : "";
  return `${hour}${minutes ? `:${minutes}` : ""}${meridiem}`;
}

function parseHoursFromSummary(summary) {
  const text = (summary || "").trim();
  if (!text) {
    return { open: "", close: "", special: "" };
  }

  if (/\bclosed\b/i.test(text)) {
    return { open: "Closed", close: "Closed", special: "" };
  }

  const rangeRegex = /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i;
  const rangeMatch = text.match(rangeRegex);

  if (!rangeMatch) {
    return { open: "", close: "", special: text };
  }

  const open = formatScrapedTime(rangeMatch[1]);
  const close = formatScrapedTime(rangeMatch[2]);
  const special = text
    .replace(rangeRegex, "")
    .replace(/\b(open|exhibit|hours?)\b/gi, "")
    .replace(/[-–:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { open, close, special };
}

function buildSevenDayHours(events) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const eventsByDate = new Map();

  function scoreEventForDay(event) {
    const summary = (event.summary || "").toLowerCase();
    let score = 0;

    if (!event.synthetic) {
      score += 3;
    }
    if (event.recurrenceId) {
      score += 4;
    }
    if (/\b(limited|special|bonus|closed)\b/.test(summary)) {
      score += 2;
    }
    return score;
  }

  function choosePreferredEvent(existing, candidate) {
    if (!existing) {
      return candidate;
    }

    const existingScore = scoreEventForDay(existing);
    const candidateScore = scoreEventForDay(candidate);

    if (candidateScore !== existingScore) {
      return candidateScore > existingScore ? candidate : existing;
    }

    return candidate.start.getTime() >= existing.start.getTime() ? candidate : existing;
  }

  for (const event of events) {
    const key = toDateKey(event.start);
    const existing = eventsByDate.get(key);
    eventsByDate.set(key, choosePreferredEvent(existing, event));
  }

  const rows = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);
    const key = toDateKey(date);
    const event = eventsByDate.get(key);

    if (!event) {
      rows.push({
        day: formatDayLabel(date),
        open: "Closed",
        close: "Closed",
      });
      continue;
    }

    const parsed = parseHoursFromSummary(event.summary);
    rows.push({
      day: formatDayLabel(date),
      open: parsed.open || "Closed",
      close: parsed.close || "Closed",
    });
  }

  return rows;
}

function formatDay(date) {
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

function formatMonthDay(date) {
  return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

function formatLabelTime(minutes) {
  const h24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const suffix = h24 >= 12 ? "pm" : "am";
  if (mins === 0) {
    return `${h12} ${suffix}`;
  }
  return `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function normalizeTimeToken(value) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/a\.m\./g, "am")
    .replace(/p\.m\./g, "pm")
    .replace(/a\.m/g, "am")
    .replace(/p\.m/g, "pm");
}

function parseTimeToMinutes(value) {
  const token = normalizeTimeToken(value);
  const match = token.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3].toLowerCase();

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem === "pm" && hour !== 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  return hour * 60 + minute;
}

function parseMinutesFrom24hText(value) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return null;
  }
  const [h, m] = value.split(":").map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

function parseSpecialHoursFromSummary(summary) {
  const text = (summary || "").trim();
  if (!text) {
    return { isClosed: true, openMinutes: null, closeMinutes: null };
  }

  if (/\bclosed\b/i.test(text)) {
    return { isClosed: true, openMinutes: null, closeMinutes: null };
  }

  const rangeRegex = /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/i;
  const rangeMatch = text.match(rangeRegex);

  if (!rangeMatch) {
    return { isClosed: true, openMinutes: null, closeMinutes: null };
  }

  const openMinutes = parseTimeToMinutes(rangeMatch[1]);
  const closeMinutes = parseTimeToMinutes(rangeMatch[2]);

  if (openMinutes === null || closeMinutes === null || closeMinutes <= openMinutes) {
    return { isClosed: true, openMinutes: null, closeMinutes: null };
  }

  return { isClosed: false, openMinutes, closeMinutes };
}

function scoreSpecialEventForDay(event) {
  const summary = (event.summary || "").toLowerCase();
  let score = 0;

  if (event.recurrenceId) {
    score += 4;
  }
  if (/\b(limited|special|bonus|closed)\b/.test(summary)) {
    score += 2;
  }
  score += 1;

  return score;
}

function choosePreferredSpecialEvent(existing, candidate) {
  if (!existing) {
    return candidate;
  }

  const existingScore = scoreSpecialEventForDay(existing);
  const candidateScore = scoreSpecialEventForDay(candidate);

  if (candidateScore !== existingScore) {
    return candidateScore > existingScore ? candidate : existing;
  }

  return candidate.start.getTime() >= existing.start.getTime() ? candidate : existing;
}

function getOverlapMinutes(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start);
}

function classifyDifference(normal, actual) {
  if (!normal && actual && !actual.isClosed) {
    return "Bonus Hours";
  }

  if (!normal && (!actual || actual.isClosed)) {
    return null;
  }

  if (normal && (!actual || actual.isClosed)) {
    return "Limited Hours";
  }

  if (!normal || !actual || actual.isClosed) {
    return null;
  }

  const normalOpen = parseMinutesFrom24hText(normal.open);
  const normalClose = parseMinutesFrom24hText(normal.close);
  if (normalOpen === null || normalClose === null || normalClose <= normalOpen) {
    return null;
  }

  const normalDuration = normalClose - normalOpen;
  const actualDuration = actual.closeMinutes - actual.openMinutes;

  const overlap = getOverlapMinutes(normalOpen, normalClose, actual.openMinutes, actual.closeMinutes);
  const reduced = Math.max(0, normalDuration - overlap);
  const extra = Math.max(0, actualDuration - overlap);

  if (reduced === 0 && extra === 0) {
    return null;
  }

  if (extra > 0 && reduced === 0) {
    return "Bonus Hours";
  }

  if (reduced > 0 && extra === 0) {
    return "Limited Hours";
  }

  return actualDuration >= normalDuration ? "Bonus Hours" : "Limited Hours";
}

function buildSpecialRows(events) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(today);
  end.setDate(today.getDate() + LOOKAHEAD_DAYS - 1);
  end.setHours(23, 59, 59, 999);

  const futureEvents = events
    .filter((event) => event.status !== "CANCELLED")
    .filter((event) => event.start && event.end)
    .filter((event) => event.start >= today && event.start <= end)
    .sort((a, b) => a.start - b.start);

  const eventsByDate = new Map();
  for (const event of futureEvents) {
    const key = toDateKey(event.start);
    const existing = eventsByDate.get(key);
    eventsByDate.set(key, choosePreferredSpecialEvent(existing, event));
  }

  const rows = [];

  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
    const date = new Date(today);
    date.setDate(today.getDate() + offset);

    const weekday = date.getDay();
    const normal = NORMAL_HOURS_BY_WEEKDAY[weekday] || null;
    const dayEvent = eventsByDate.get(toDateKey(date));

    if (!dayEvent) {
      continue;
    }

    const actual = parseSpecialHoursFromSummary(dayEvent.summary || "");
    const type = classifyDifference(normal, actual);

    if (!type) {
      continue;
    }

    let openText = "Closed";
    let closeText = "Closed";
    if (!actual.isClosed && actual.openMinutes !== null && actual.closeMinutes !== null) {
      openText = formatLabelTime(actual.openMinutes);
      closeText = formatLabelTime(actual.closeMinutes);
    }

    rows.push({
      type,
      date: formatMonthDay(date),
      open: openText,
      close: closeText,
      sortTime: date.getTime(),
    });
  }

  return rows.sort((a, b) => a.sortTime - b.sortTime).map((row) => ({
    type: row.type,
    date: row.date,
    open: row.open,
    close: row.close,
  }));
}

async function main() {
  const response = await fetch(ICS_URL, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to download ICS feed (${response.status})`);
  }

  const icsText = await response.text();
  const now = new Date();

  const parsedEvents = parseIcsEvents(icsText)
    .filter((event) => event.status !== "CANCELLED")
    .filter((event) => event.start && event.end);

  const directUpcomingEvents = parsedEvents
    .filter((event) => event.end >= now)
    .sort((a, b) => a.start - b.start);

  const resolvedEvents = directUpcomingEvents.length >= 7
    ? directUpcomingEvents
    : parsedEvents
        .flatMap((event) => getDisplayEvents([event], now))
        .sort((a, b) => a.start - b.start);

  const hoursRows = buildSevenDayHours(resolvedEvents.slice(0, 120));
  const specialRows = buildSpecialRows(parsedEvents);

  const hoursPayload = {
    generatedAt: new Date().toISOString(),
    rows: hoursRows,
  };

  const specialPayload = {
    generatedAt: new Date().toISOString(),
    rows: specialRows,
  };

  writeFileSync("data/hours.json", `${JSON.stringify(hoursPayload, null, 2)}\n`, "utf8");
  writeFileSync("data/special-hours.json", `${JSON.stringify(specialPayload, null, 2)}\n`, "utf8");

  console.log(`Generated ${hoursRows.length} standard-hour rows and ${specialRows.length} special-hour rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
