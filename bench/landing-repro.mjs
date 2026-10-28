// Landing-page repro: Perch (new defaults = qwen-3.8-max/high) builds the same brief.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const cwd = join(fileURLToPath(new URL(".", import.meta.url)), "landing-repro");
mkdirSync(cwd, { recursive: true });

const client = new Client({ name: "landing-repro", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));

const t0 = Date.now();
const r = await client.callTool(
  {
    name: "delegate_to_perch",
    arguments: {
      task:
        "Build a single-file world-class landing page at landing.html in this directory. " +
        "Theme: PERCH AGENT â€” 'Delegate Everything' (an MCP tool that lets Claude Code delegate tasks to Perch AI as an autonomous worker agent). " +
        "Requirements: ONE self-contained landing.html, dark cinematic award-winning (Awwwards-style) aesthetic. " +
        "Include ALL of: a WebGL (three.js) animated shader/particle background, GSAP scroll animations with smooth scrolling (Lenis), " +
        "kinetic split-character typography hero, an infinite marquee strip, scroll-scrubbed text reveal, " +
        "a horizontally-scrolling pinned section with 3-4 feature cards, animated stat counters, a custom cursor, " +
        "a film-grain overlay, a preloader with a percentage counter, and a magnetic hover CTA button. " +
        "Use CDN links for libraries. The page must work by simply opening the file in a browser. " +
        "When done, reply with the file path and the list of features you actually implemented.",
      cwd,
      mode: "agents",
      wait_seconds: 780,
      timeout_seconds: 900,
    },
    _meta: { progressToken: "pt-landing-repro" },
  },
  undefined,
  { timeout: 960000 }
);
const j = JSON.parse(r.content[0].text);
console.log(JSON.stringify({
  ok: j.ok,
  perch_status: j.perch_status,
  served: `${j.model_id} (${j.model_label})`,
  seconds: Math.round(((j.endedAt ?? Date.now()) - 0) / 1000) || j.duration_seconds,
  thread: j.thread_id,
  error: j.error ?? null,
  reply: (j.assistant_text ?? "").slice(0, 600),
}, null, 2));

const f = join(cwd, "landing.html");
if (existsSync(f)) {
  console.log("landing.html bytes:", statSync(f).size);
} else {
  console.log("files in cwd:", readdirSync(cwd).join(", ") || "(none)");
}
await client.close();
