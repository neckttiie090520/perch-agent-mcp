// Benchmark: qwen-3.8-max vs standard through perch-agent MCP.
// Objective grading: every item has a machine-checkable answer.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "perch-bench-"));

const client = new Client({ name: "perch-bench", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

const ITEMS = [
  {
    id: "primes-sum",
    ask: "What is the sum of all prime numbers below 50? Compute carefully. Reply with ONLY the number.",
    check: (t) => /\b328\b/.test(t) && !/\b(327|329|330)\b/.test(t),
    answer: "328",
  },
  {
    id: "mod-pow",
    ask: "Compute 7^100 mod 13. Show nothing but the final number. Reply with ONLY the number.",
    check: (t) => /\b9\b/.test(t),
    answer: "9",
  },
  {
    id: "inclusion-exclusion",
    ask: "How many positive integers from 1 to 1000 inclusive are divisible by neither 3 nor 7? Reply with ONLY the number.",
    check: (t) => /\b572\b/.test(t) && !/\b(571|573|524)\b/.test(t),
    answer: "572",
  },
  {
    id: "last-two-digits",
    ask: "What are the last two digits of 3^2026 in decimal? Reply with ONLY the two digits (e.g. 07 for 7).",
    check: (t) => /\b29\b/.test(t) && !/\b(2029|29\d\d)/.test(t.replace(/(20\d\d)/g, "")),
    answer: "29",
  },
  {
    id: "constraint-words",
    ask: 'Reply with exactly five words separated by single spaces: word 1 must start with "P", word 2 with "E", word 3 with "R", word 4 with "C", word 5 with "H". No other text, no punctuation.',
    check: (t) => {
      const w = t.trim().replace(/[.!?]+$/, "").split(/\s+/);
      return (
        w.length === 5 &&
        [/^p/i, /^e/i, /^r/i, /^c/i, /^h/i].every((re, i) => re.test(w[i]))
      );
    },
    answer: "P**** E**** R**** C**** H****",
  },
  {
    id: "agentic-code-exec",
    mode: "agents",
    ask:
      "Create a file bench_perfect.py containing a function that returns True if n is a perfect number. " +
      "Run it with python to print all perfect numbers below 10000 on one line, space-separated. " +
      "Then reply with EXACTLY that output line and nothing else.",
    check: (t) => /\b6\s+28\s+496\s+8128\b/.test(t),
    answer: "6 28 496 8128 (must actually run the script)",
  },
];

const MODELS = [
  { key: "standard", model: "standard" },
  { key: "qwen-3.8-max", model: "qwen-3.8-max" },
];

const results = [];
for (const m of MODELS) {
  for (const item of ITEMS) {
    const t0 = Date.now();
    let r, j;
    try {
      r = await client.callTool(
        {
          name: "delegate_to_perch",
          arguments: {
            task: item.ask,
            cwd,
            mode: item.mode ?? "ask",
            model: m.model,
            effort: "high",
            wait_seconds: 240,
            timeout_seconds: 300,
          },
          _meta: { progressToken: `pt-${m.key}-${item.id}` },
        },
        undefined,
        { timeout: 420000 }
      );
      j = JSON.parse(r.content[0].text);
    } catch (e) {
      j = { error: String(e?.message ?? e), assistant_text: "" };
    }
    const text = j.assistant_text ?? "";
    const ok = !j.error && item.check(text);
    const rec = {
      model: m.key,
      item: item.id,
      ok,
      served_model: j.model_id ?? "(n/a)",
      seconds: Math.round((Date.now() - t0) / 1000),
      out_tokens: j.usage?.output_tokens ?? null,
      reply: text.replace(/\s+/g, " ").slice(0, 90),
      err: j.error ?? null,
    };
    results.push(rec);
    console.log(`${ok ? "PASS" : "FAIL"}  ${m.key.padEnd(12)} ${item.id.padEnd(20)} ${rec.seconds}s  served=${rec.served_model}  "${rec.reply}"`);
  }
}

console.log("\n=== SCOREBOARD ===");
for (const m of MODELS) {
  const rs = results.filter((r) => r.model === m.key);
  const pass = rs.filter((r) => r.ok).length;
  const avgS = Math.round(rs.reduce((a, r) => a + r.seconds, 0) / rs.length);
  const avgTok = Math.round(rs.reduce((a, r) => a + (r.out_tokens ?? 0), 0) / rs.length);
  const served = [...new Set(rs.map((r) => r.served_model))].join(",");
  console.log(`${m.key.padEnd(12)} ${pass}/${rs.length}  avg ${avgS}s  avg out-tok ${avgTok}  served-as: ${served}`);
}

const identitiesDiffer =
  results.filter((r) => r.model === "standard").every((r) => /3\.6/.test(r.served_model)) &&
  results.filter((r) => r.model === "qwen-3.8-max").every((r) => /3\.8-Max/.test(r.served_model));
console.log(`\nidentity separation (each model served as its own id): ${identitiesDiffer}`);

await client.close();
