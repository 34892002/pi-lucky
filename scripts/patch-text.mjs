/**
 * Exact-text replacement for files whose line endings are CRLF.
 *
 * The repo keeps pi-gui's CRLF files, and `edit` matches raw bytes, so a patch written
 * with LF silently fails to match. This normalizes both sides to the file's own EOL and
 * refuses to guess: it requires exactly one match per patch.
 *
 * usage: node scripts/patch-text.mjs <file> <patch.json>
 * patch.json: [{ "old": "...", "new": "..." }]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , file, patchFile] = process.argv;
if (!file || !patchFile) {
  console.error("usage: node scripts/patch-text.mjs <file> <patch.json>");
  process.exit(1);
}

const source = readFileSync(file, "utf8");
const eol = source.includes("\r\n") ? "\r\n" : "\n";
const normalize = (text) => text.replace(/\r\n/g, "\n").split("\n").join(eol);
const patches = JSON.parse(readFileSync(patchFile, "utf8"));

let next = source;
for (const { old, new: replacement } of patches) {
  const target = normalize(old);
  const count = next.split(target).length - 1;
  if (count !== 1) {
    console.error(`expected exactly 1 match, found ${count}:\n${old.slice(0, 200)}`);
    process.exit(1);
  }
  next = next.replace(target, normalize(replacement));
}

writeFileSync(file, next);
console.log(`patched ${file} (${patches.length} replacement(s), ${eol === "\r\n" ? "CRLF" : "LF"})`);
