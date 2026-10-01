import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function assertOpenWindowsDocument(document) {
  const offsetTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
  assert.match(document.generatedAt, offsetTimestamp);
  assert.ok(Number.isFinite(Date.parse(document.generatedAt)));
  assert.equal(document.timeZone, "America/New_York");
  assert.ok(Array.isArray(document.windows));
  assert.ok(document.windows.length <= 64);
  for (const window of document.windows) {
    assert.match(window.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(window.start, offsetTimestamp);
    assert.match(window.end, offsetTimestamp);
    assert.ok(Date.parse(window.start) < Date.parse(window.end));
  }
}

export function generateAt(now, check, {
  calendar = readFileSync(new URL("./fixtures/open-windows.ics", import.meta.url), "utf8"),
  timeZone = "America/New_York", head = false,
} = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "hours-sync-test-"));
  mkdirSync(join(scratch, "data"));
  try {
    const script = fileURLToPath(new URL("../sync-hours-data.mjs", import.meta.url));
    let entrypoint = `process.argv[1] = ${JSON.stringify(script)}; await import(pathToFileURL(process.argv[1]));`;
    if (head) {
      const source = execFileSync("git", ["show", "HEAD:scripts/sync-hours-data.mjs"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
      });
      const entryIndex = source.lastIndexOf("const isEntrypoint =");
      assert.ok(entryIndex > 0);
      const moduleUrl = "data:text/javascript;base64," + Buffer.from(source.slice(0, entryIndex) + "\nawait main();").toString("base64");
      entrypoint = `await import(${JSON.stringify(moduleUrl)});`;
    }
    const harness = `
      import { pathToFileURL } from 'node:url';
      const Clock = Date;
      globalThis.Date = class extends Clock {
        constructor(...args) { super(...(args.length ? args : [${JSON.stringify(now)}])); }
        static now() { return new Clock(${JSON.stringify(now)}).getTime(); }
      };
      globalThis.fetch = async (url) => {
        if (url !== 'https://synthetic.invalid/calendar.ics') throw new Error('Unexpected feed');
        return { ok: true, text: async () => ${JSON.stringify(calendar)} };
      };
      ${entrypoint}
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", harness], {
      cwd: scratch, encoding: "utf8",
      env: { ...process.env, TZ: timeZone, PRIVATE_ICS_URL: "https://synthetic.invalid/calendar.ics" },
    });
    assert.equal(result.status, 0, result.stderr);
    const read = (name) => readFileSync(join(scratch, "data", `${name}.json`), "utf8");
    if (!head) {
      assertOpenWindowsDocument(JSON.parse(read("open-windows")));
    }
    check(read, result);
  } finally {
    assert.ok(resolve(scratch).startsWith(resolve(tmpdir()) + sep));
    assert.ok(scratch.includes("hours-sync-test-"));
    rmSync(scratch, { recursive: true, force: true });
  }
}
