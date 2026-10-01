import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const easternDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

// Preserve the committed bytes for timestamp-only updates within the same Eastern day.
export function prepareGeneratedFile(currentText, committedText) {
  const { generatedAt: currentTime, ...currentData } = JSON.parse(currentText);
  const { generatedAt: committedTime, ...committedData } = JSON.parse(committedText);
  if (isDeepStrictEqual(currentData, committedData) &&
      easternDate.format(new Date(currentTime)) === easternDate.format(new Date(committedTime))) {
    return committedText;
  }
  return currentText;
}

function main() {
  const files = ["data/hours.json", "data/special-hours.json", "data/open-windows.json"];
  const committedFiles = new Set(execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", ...files], {
    encoding: "utf8",
  }).trim().split("\n"));
  for (const file of files) {
    // A newly introduced feed has no committed copy yet.
    if (!committedFiles.has(file)) {
      continue;
    }
    const committedText = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" });
    const currentText = readFileSync(file, "utf8");
    const preparedText = prepareGeneratedFile(currentText, committedText);
    if (preparedText !== currentText) {
      writeFileSync(file, preparedText, "utf8");
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
