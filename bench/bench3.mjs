// Round 3: competition-level items. Answers hand-verified.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "perch-bench3-"));
const client = new Client({ name: "perch-bench3", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

const ITEMS = [
  {
    id: "pow-tower-mod",
    ask: "Find the remainder when 7^(7^7) is divided by 100. Reply with ONLY the remainder.",
    check: (t) => /\b43\b/.test(t) && !/\b(143|243|343)\b/.test(t),
    answer: "43",
  },
  {
    id: "odd-digit-sum",
    ask: "Consider all three-digit numbers whose digits are all odd (1,3,5,7,9) and pairwise distinct. What is the sum of all such numbers? Reply with ONLY the number.",
    check: (t) => /\b33300\b/.test(t) && !/\b(33030|3330)\b/.test(t),
    answer: "33300",
  },
  {
    id: "event-loop",
    ask: 'Without running code, what does this print, in order?\nconsole.log(1);\nsetTimeout(()=>console.log(2),0);\nPromise.resolve().then(()=>console.log(3));\nconsole.log(4);\nReply with ONLY the four digits separated by single spaces.',
    check: (t) => /\b1\s+4\s+3\s+2\b/.test(t),
    answer: "1 4 3 2",
  },
  {
    id: "altitude-fraction",
    ask: "A right triangle has legs of length 8 and 15. What is the length of the altitude drawn to the hypotenuse? Reply with ONLY the exact fraction in lowest terms, like a/b.",
    check: (t) => /120\s*\/\s*17/.test(t),
    answer: "120/17",
  },
  {
    id: "cond-prob",
    ask: "Two fair six-sided dice are rolled. Given that the sum is 8, what is the probability that at least one die shows a 6? Reply with ONLY the exact probability as a fraction like a/b.",
    check: (t) => /\b2\s*\/\s*5\b|0\.4\b/.test(t),
    answer: "2/5",
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
            mode: "ask",
            model: m.model,
            effort: "high",
            wait_seconds: 300,
            timeout_seconds: 360,
          },
          _meta: { progressToken: `pt3-${m.key}-${item.id}` },
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
    const rec = { model: m.key, item: item.id, ok, seconds: Math.round((Date.now() - t0) / 1000), reply: text.replace(/\s+/g, " ").slice(0, 100), err: j.error ?? null };
    results.push(rec);
    console.log(`${ok ? "PASS" : "FAIL"}  ${m.key.padEnd(12)} ${item.id.padEnd(18)} ${rec.seconds}s  "${rec.reply}"${rec.err ? "  ERR=" + rec.err.slice(0, 60) : ""}`);
  }
}
console.log("\n=== ROUND3 ===");
for (const m of MODELS) {
  const rs = results.filter((r) => r.model === m.key);
  console.log(`${m.key.padEnd(12)} ${rs.filter((r) => r.ok).length}/${rs.length}  avg ${Math.round(rs.reduce((a, r) => a + r.seconds, 0) / rs.length)}s`);
}
await client.close();
