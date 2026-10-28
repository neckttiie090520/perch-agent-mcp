// Differential set: items where a 3B-active MoE should visibly separate from a
// large model. Answers hand-verified. ask-mode, effort high, both models.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "perch-diff-"));
const client = new Client({ name: "perch-diff", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

const ITEMS = [
  {
    id: "mod-tower-1000",
    ask: "Compute the last three digits of 7^(7^7). Reply with ONLY the three digits (zero-padded if needed).",
    check: (t) => /\b343\b/.test(t) && !/\b(1343|2343|7343)\b/.test(t),
    answer: "343",
  },
  {
    id: "cards-hypergeometric",
    ask: "Draw 5 cards from a standard 52-card deck without replacement. What is the probability of exactly 3 aces AND at least one king? Reply with ONLY the exact probability as a fraction in lowest terms, like a/b.",
    check: (t) => /1\s*\/\s*3570\b/.test(t.replace(/\s/g, "")),
    answer: "1/3570",
  },
  {
    id: "parseint-trap",
    ask: 'Without running code, what does this print?\nconsole.log([1,2,3].map(parseInt).join(","))\nReply with ONLY the exact output string.',
    check: (t) => /1\s*,\s*NaN\s*,\s*NaN/.test(t),
    answer: '"1,NaN,NaN"',
  },
  {
    id: "balanced-ternary",
    ask: "A balance scale uses weights that may be placed on either pan. What is the minimum NUMBER of weights needed to weigh every integer weight from 1 to 121 kg inclusive, and what is the LARGEST of those weights? Reply like: 5, 81",
    check: (t) => /\b5\b/.test(t) && /\b81\b/.test(t) && !/\b6\b.*\bweights/i.test(t),
    answer: "5 weights, largest 81",
  },
  {
    id: "recurrence",
    ask: "T(0)=1 and T(n)=2*T(n-1)+3 for n>=1. What is T(10)? Reply with ONLY the number.",
    check: (t) => /\b4093\b/.test(t) && !/\b(40930|40933)\b/.test(t),
    answer: "4093",
  },
];

const MODELS = [
  { key: "standard(3.6-35B)", model: "standard" },
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
          arguments: { task: item.ask, cwd, mode: "ask", model: m.model, effort: "high", wait_seconds: 300, timeout_seconds: 360 },
          _meta: { progressToken: `pd-${m.key}-${item.id}` },
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
    const rec = { model: m.key, item: item.id, ok, seconds: Math.round((Date.now() - t0) / 1000), reply: text.replace(/\s+/g, " ").slice(0, 110), err: j.error ?? null };
    results.push(rec);
    console.log(`${ok ? "PASS" : "FAIL"}  ${m.key.padEnd(16)} ${item.id.padEnd(20)} ${rec.seconds}s  "${rec.reply}"${rec.err ? "  ERR=" + rec.err.slice(0, 60) : ""}`);
  }
}
console.log("\n=== DIFFERENTIAL ===");
for (const m of MODELS) {
  const rs = results.filter((r) => r.model === m.key);
  console.log(`${m.key.padEnd(16)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
}
await client.close();
