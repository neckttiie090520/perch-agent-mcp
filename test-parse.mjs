// Self-check for parseRunJson hardening: code-echo braces before real JSON.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const fn = src.match(/function parseRunJson[\s\S]*?\n}/)[0];
const parseRunJson = new Function(`return ${fn};`)();

const fake =
  'Notice: agent quoted code below\n' +
  '{\n  "looks": "like json start"\n}\n' +
  'more text { inline }\n' +
  '{\n  "ok": true,\n  "status": "completed",\n  "threadId": "cli-x",\n  "assistantText": "DONE"\n}';

const r = parseRunJson(fake);
assert.ok(r && r.ok === true && r.threadId === "cli-x" && r.assistantText === "DONE", "should pick the real run JSON");
assert.equal(parseRunJson("no json at all"), null);
console.log("PARSE FIX VERIFIED — last line-start JSON wins, decoys ignored");
