// Hard-item benchmark: discriminators where a small MoE (3B active) should
// visibly separate from a large dense model. Permission fix included.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "perch-bench2-"));

const client = new Client({ name: "perch-bench2", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

const ITEMS = [
  {
    id: "anagrams",
    ask: "How many distinct letter arrangements (anagrams) are there of the word MISSISSIPPI? Reply with ONLY the number.",
    check: (t) => /\b34650\b/.test(t) && !/\b(3465|34651|39960)\b/.test(t),
    answer: "34650",
  },
  {
    id: "day-arithmetic",
    ask: "If today is Wednesday, what day of the week will it be after exactly 10^100 (a googol) days? Reply with ONLY the day name.",
    check: (t) => /sunday/i.test(t),
    answer: "Sunday",
  },
  {
    id: "js-predict",
    ask: 'Without running code: what exactly does this JavaScript expression evaluate to?\n[1,2,3,4].reduce((a,b)=>a+b*b,0)+typeof(()=>{})\nReply with ONLY the exact resulting string.',
    check: (t) => /30function/.test(t.replace(/\s+/g, "")),
    answer: '"30function"',
  },
  {
    id: "trailing-zeros",
    ask: "How many trailing zeros does 2026! (factorial) have in decimal? Reply with ONLY the number.",
    check: (t) => /\b505\b/.test(t) && !/\b(506|504)\b/.test(t),
    answer: "505",
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
    let j;
    try {
      const r = await client.callTool(
        {
          name: "delegate_to_perch",
          arguments: {
            task: item.ask,
            cwd,
            mode: item.mode ?? "ask",
            model: m.model,
            effort: "high",
            wait_seconds: 300,
            timeout_seconds: 360,
          },
          _meta: { progressToken: `pt2-${m.key}-${item.id}` },
        },
        undefined,
        { timeout: 480000 }
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
      served: j.model_id ?? "(n/a)",
      seconds: Math.round((Date.now() - t0) / 1000),
      reply: text.replace(/\s+/g, " ").slice(0, 110),
      err: j.error ?? null,
    };
    results.push(rec);
    console.log(`${ok ? "PASS" : "FAIL"}  ${m.key.padEnd(12)} ${item.id.padEnd(20)} ${rec.seconds}s  "${rec.reply}"${rec.err ? "  ERR=" + rec.err.slice(0, 80) : ""}`);
  }
}

console.log("\n=== HARD SCOREBOARD ===");
for (const m of MODELS) {
  const rs = results.filter((r) => r.model === m.key);
  console.log(`${m.key.padEnd(12)} ${rs.filter((r) => r.ok).length}/${rs.length}  avg ${Math.round(rs.reduce((a, r) => a + r.seconds, 0) / rs.length)}s`);
}
await client.close();
