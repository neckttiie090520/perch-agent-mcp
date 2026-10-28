// Agentic coding benchmark: build / debug / stateful-CLI / real-repo review.
// Grading = end-state verified by THIS harness (fresh process runs), never the model's claim.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "perch-agentic-"));
const client = new Client({ name: "perch-agentic-bench", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

// ---- seeded buggy project for the debug task ----
const CALC_JS = `function mean(xs) { return xs.reduce((a, b) => a + b, 0) / (xs.length - 1); }
function median(xs) {
  const s = xs;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function max(xs) { return xs.reduce((a, b) => (a > b ? a : b), 0); }
module.exports = { mean, median, max };
`;
const CALC_TEST = `const test = require("node:test");
const assert = require("node:assert");
const c = require("./calc.cjs");
test("mean", () => assert.equal(c.mean([2, 4, 6]), 4));
test("median odd", () => assert.equal(c.median([3, 1, 2]), 2));
test("median even", () => assert.equal(c.median([4, 1, 3, 2]), 2.5));
test("max negatives", () => assert.equal(c.max([-5, -2, -9]), -2));
`;
function seedCalc(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calc.cjs"), CALC_JS);
  writeFileSync(join(dir, "calc.test.cjs"), CALC_TEST);
  return createHash("sha256").update(CALC_TEST).digest("hex");
}
function run(cmd, args, cwd) {
  try {
    return { out: execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ""}${e.stderr || ""}`, code: e.status ?? 1 };
  }
}

const TASKS = [
  {
    id: "build-cli",
    task:
      "In this directory create markdowntoc.js: a Node CLI (no dependencies) that takes a markdown file path as argv[2] " +
      "and prints a table of contents built from headings: '# X' -> '- X', '## X' -> '  - X', '### X' -> '    - X' (2-space indent steps). " +
      "Then create sample.md with exactly these lines:\\n# Alpha\\n## Beta\\n### Gamma\\n# Delta\\n" +
      "Run `node markdowntoc.js sample.md` and include its full output in your reply.",
    grade: (dir) => {
      if (!existsSync(join(dir, "markdowntoc.js"))) return { ok: false, why: "no markdowntoc.js" };
      const r = run(process.execPath, ["markdowntoc.js", "sample.md"], dir);
      const ok =
        r.code === 0 &&
        /^- Alpha$/m.test(r.out) &&
        /^ {2}- Beta$/m.test(r.out) &&
        /^ {4}- Gamma$/m.test(r.out) &&
        /^- Delta$/m.test(r.out);
      return { ok, why: ok ? "" : `bad toc output: ${JSON.stringify(r.out.slice(0, 120))}` };
    },
  },
  {
    id: "debug-tests",
    seed: seedCalc,
    task:
      "In this directory there is calc.cjs (statistical helpers) and calc.test.cjs (tests). " +
      "Run `node --test calc.test.cjs`, fix ONLY calc.cjs until every test passes. " +
      "Do NOT modify calc.test.cjs. Reply with the list of bugs you fixed, one per line.",
    grade: (dir, ctx) => {
      const testHash = createHash("sha256").update(readFileSync(join(dir, "calc.test.cjs"))).digest("hex");
      if (testHash !== ctx.testHash) return { ok: false, why: "TEST FILE WAS MODIFIED (cheat)" };
      const r = run(process.execPath, ["--test", "calc.test.cjs"], dir);
      return { ok: r.code === 0 && /pass \d+/.test(r.out) && !/fail \d+/m.test(r.out.replace(/fail 0/g, "")), why: r.code === 0 ? "" : `tests still failing: ${r.out.slice(-200)}` };
    },
  },
  {
    id: "stateful-todo",
    task:
      'Create todos.js (Node, no dependencies) with commands: `node todos.js add <text>` appends a todo, ' +
      "`node todos.js done <n>` marks the n-th (1-based) as done, `node todos.js list` prints them. " +
      "State persists in todos.json. Then run exactly: add \"alpha\", add \"beta\", add \"gamma\", done 2, list. " +
      "Reply with the final list output.",
    grade: (dir) => {
      if (!existsSync(join(dir, "todos.json"))) return { ok: false, why: "no todos.json" };
      let j;
      try {
        j = JSON.parse(readFileSync(join(dir, "todos.json"), "utf8"));
      } catch {
        return { ok: false, why: "todos.json unparseable" };
      }
      const items = Array.isArray(j) ? j : j.todos ?? [];
      const ok =
        items.length === 3 &&
        /alpha/i.test(JSON.stringify(items[0])) &&
        /beta/i.test(JSON.stringify(items[1])) &&
        /gamma/i.test(JSON.stringify(items[2])) &&
        (items[1].done === true || items[1].status === "done" || items[1].completed === true);
      return { ok, why: ok ? "" : `bad todos.json: ${JSON.stringify(j).slice(0, 160)}` };
    },
  },
];

const MODELS = [
  { key: "standard", model: "standard" },
  { key: "qwen-3.8-max", model: "qwen-3.8-max" },
];

const results = [];
for (const m of MODELS) {
  for (const t of TASKS) {
    const dir = join(root, `${m.key}-${t.id}`);
    mkdirSync(dir, { recursive: true });
    const ctx = { testHash: null };
    if (t.seed) ctx.testHash = t.seed(dir);
    const t0 = Date.now();
    let j;
    try {
      const r = await client.callTool(
        {
          name: "delegate_to_perch",
          arguments: { task: t.task, cwd: dir, mode: "agents", model: m.model, effort: "high", wait_seconds: 420, timeout_seconds: 480 },
          _meta: { progressToken: `pa-${m.key}-${t.id}` },
        },
        undefined,
        { timeout: 600000 }
      );
      j = JSON.parse(r.content[0].text);
    } catch (e) {
      j = { error: String(e?.message ?? e), assistant_text: "" };
    }
    const g = j.error ? { ok: false, why: j.error } : t.grade(dir, ctx);
    const rec = { model: m.key, item: t.id, ok: g.ok, why: g.why, seconds: Math.round((Date.now() - t0) / 1000), out_tokens: j.usage?.output_tokens ?? null, thread: j.thread_id ?? null };
    results.push(rec);
    console.log(`${g.ok ? "PASS" : "FAIL"}  ${m.key.padEnd(12)} ${t.id.padEnd(14)} ${rec.seconds}s  out-tok=${rec.out_tokens}${g.why ? "  " + g.why.slice(0, 140) : ""}`);
  }
}

// ---- real-repo planted-bug review (qwen-3.8-max focus) ----
for (const m of MODELS) {
  const dir = join(root, `${m.key}-review`);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  let j;
  try {
    const r = await client.callTool(
      {
        name: "delegate_to_perch",
        arguments: {
          task:
            "Read index.js and test-client.mjs in this directory. Find the single most serious LATENT bug in index.js " +
            "that the test suite does NOT catch â€” a real state or parsing defect, not a style issue. " +
            "Write your analysis (bug, exact line numbers, failure scenario) to review-findings.md in this directory. " +
            "Reply with the bug in one line.",
          cwd: dir,
          mode: "agents",
          model: m.model,
          effort: "high",
          wait_seconds: 480,
          timeout_seconds: 540,
        },
        _meta: { progressToken: `pa-${m.key}-review` },
      },
      undefined,
      { timeout: 660000 }
    );
    j = JSON.parse(r.content[0].text);
  } catch (e) {
    j = { error: String(e?.message ?? e), assistant_text: "" };
  }
  const findings = existsSync(join(dir, "review-findings.md")) ? readFileSync(join(dir, "review-findings.md"), "utf8") : "(no findings file)";
  results.push({ model: m.key, item: "review", seconds: Math.round((Date.now() - t0) / 1000), reply: (j.assistant_text ?? "").replace(/\s+/g, " ").slice(0, 140), err: j.error ?? null });
  writeFileSync(join(__dirnameSafe(), `review-${m.key}.md`), findings);
  console.log(`REVIEW ${m.key.padEnd(12)} ${Math.round((Date.now() - t0) / 1000)}s  "${(j.assistant_text ?? "").replace(/\s+/g, " ").slice(0, 120)}"`);
}
function __dirnameSafe() {
  return new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

console.log("\n=== AGENTIC SCOREBOARD ===");
for (const m of MODELS) {
  const rs = results.filter((r) => r.model === m.key && r.item !== "review");
  console.log(`${m.key.padEnd(12)} ${rs.filter((r) => r.ok).length}/${rs.length}  avg ${Math.round(rs.reduce((a, r) => a + r.seconds, 0) / rs.length)}s`);
}
console.log("sandbox root:", root);
await client.close();
