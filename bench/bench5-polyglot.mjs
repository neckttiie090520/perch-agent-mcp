// Polyglot-style benchmark (aider/Exercism methodology) for Perch worker models.
// Agent gets instructions + stub, must run pytest itself and iterate. Grading =
// fresh pytest run by THIS harness. Usage: node bench5-polyglot.mjs [polyglot|review]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const seedDir = fileURLToPath(new URL("../polyglot-seed", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "perch-polyglot-"));
const client = new Client({ name: "perch-polyglot-bench", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

const EXERCISES = [
  { slug: "bowling", mod: "bowling" },
  { slug: "rectangles", mod: "rectangles" },
  { slug: "zebra-puzzle", mod: "zebra_puzzle" },
];
const MODELS = [
  { key: "standard", model: "standard" },
  { key: "qwen-3.8-max", model: "qwen-3.8-max" },
];

function gradePytest(dir, mod) {
  try {
    const out = execFileSync("python", ["-m", "pytest", `${mod}_test.py`, "-q"], {
      cwd: dir, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    });
    const m = out.match(/(\d+) passed/);
    return { ok: true, detail: `${m ? m[1] : "?"} passed` };
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`;
    const m = out.match(/(\d+) failed/);
    return { ok: false, detail: `${m ? m[1] + " failed" : "no pass"}: ${out.slice(-150).replace(/\s+/g, " ")}` };
  }
}

async function delegate(args, timeoutMs) {
  const r = await client.callTool(
    { name: "delegate_to_perch", arguments: { ...args, _meta: { progressToken: `pb-${Math.random().toString(36).slice(2, 7)}` } } },
    undefined,
    { timeout: timeoutMs }
  );
  return JSON.parse(r.content[0].text);
}

const section = process.argv[2] ?? "polyglot";

if (section === "polyglot") {
  for (const m of MODELS) {
    for (const ex of EXERCISES) {
      const dir = join(root, `${m.key}-${ex.slug}`);
      mkdirSync(dir, { recursive: true });
      cpSync(join(seedDir, ex.slug), dir, { recursive: true });
      const instructions = readFileSync(join(dir, "instructions.md"), "utf8");
      const t0 = Date.now();
      let j;
      try {
        j = await delegate(
          {
            task:
              `Exercise: implement ${ex.mod} in ${ex.mod}.py (a stub already exists â€” keep its class/function signatures, tests import them).\n\n` +
              `INSTRUCTIONS:\n${instructions}\n\n` +
              `Rules: standard library only. The test file ${ex.mod}_test.py exists in this directory. ` +
              `Run \`python -m pytest ${ex.mod}_test.py -q\` yourself, read failures, fix, and iterate until ALL tests pass. ` +
              `When all pass, reply with just: ALL TESTS PASSED`,
            cwd: dir,
            mode: "agents",
            model: m.model,
            effort: "high",
            wait_seconds: 540,
            timeout_seconds: 600,
          },
          720000
        );
      } catch (e) {
        j = { error: String(e?.message ?? e) };
      }
      const g = j.error ? { ok: false, detail: j.error } : gradePytest(dir, ex.mod);
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(`${g.ok ? "PASS" : "FAIL"}  ${m.key.padEnd(12)} ${ex.slug.padEnd(14)} ${secs}s  ${g.detail.slice(0, 130)}`);
    }
  }
}

if (section === "review") {
  for (const m of MODELS) {
    const dir = join(root, `review-${m.key}`);
    mkdirSync(dir, { recursive: true });
    copyFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), join(dir, "index.js"));
    copyFileSync(fileURLToPath(new URL("./test-client.mjs", import.meta.url)), join(dir, "test-client.mjs"));
    const t0 = Date.now();
    let j;
    try {
      j = await delegate(
        {
          task:
            "Read index.js in this directory (an MCP server delegating tasks to the perch CLI). " +
            "Find the single most serious LATENT defect that its test suite does NOT catch â€” a real state or parsing bug with a concrete failure scenario, not style. " +
            `Write the analysis (bug, exact line numbers, failure scenario) to review-findings.md. Reply with the bug in one line.`,
          cwd: dir,
          mode: "agents",
          model: m.model,
          effort: "high",
          wait_seconds: 540,
          timeout_seconds: 600,
        },
        720000
      );
    } catch (e) {
      j = { error: String(e?.message ?? e) };
    }
    const f = join(dir, "review-findings.md");
    const secs = Math.round((Date.now() - t0) / 1000);
    console.log(`REVIEW ${m.key.padEnd(12)} ${secs}s  "${(j.assistant_text ?? j.error ?? "").replace(/\s+/g, " ").slice(0, 130)}"`);
    if (existsSync(f)) {
      writeFileSync(new URL(`./review-${m.key}.md`, import.meta.url), readFileSync(f, "utf8"));
    } else {
      console.log(`  (no review-findings.md produced)`);
    }
  }
}

await client.close();
