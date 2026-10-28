// Standalone E2E: MCP client -> perch-agent stdio server -> perch CLI
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "perch-agent-e2e-"));

const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env });
const client = new Client({ name: "perch-agent-e2e-client", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
if (!tools.tools.map((t) => t.name).join(",").includes("delegate_to_perch")) {
  throw new Error("delegate_to_perch not registered");
}

let progressCount = 0;
client.fallbackNotificationHandler = (n) => {
  if (n.method === "notifications/progress") progressCount++;
};

function textOf(res) {
  return res.content?.map((c) => c.text).join("\n") ?? "";
}

async function call(name, args, timeoutMs) {
  return client.callTool(
    { name, arguments: args, _meta: { progressToken: `pt-${name}-${Math.random().toString(36).slice(2, 7)}` } },
    undefined,
    {
      timeout: timeoutMs,
      onprogress: (p) => {
        progressCount++;
        if (p?.message) console.log(`  [progress] ${p.message}`);
      },
    }
  );
}

console.log("\n--- perch_status ---");
const r0 = await call("perch_status", {}, 30000);
const j0 = JSON.parse(textOf(r0));
console.log(JSON.stringify({ cli: j0.cli?.slice(0, 80), active: j0.active_jobs?.length }, null, 2));
if (!/Signed in/i.test(j0.cli ?? "")) throw new Error("perch_status: CLI not signed in");

console.log("\n--- happy path: delegate simple task ---");
const r1 = await call(
  "delegate_to_perch",
  { task: "Reply with exactly MCP_E2E_OK", cwd, wait_seconds: 240, timeout_seconds: 300 },
  420000
);
const j1 = JSON.parse(textOf(r1));
console.log(JSON.stringify(j1, null, 2));
if (j1.assistant_text !== "MCP_E2E_OK" || !j1.thread_id) throw new Error("happy path failed");

console.log("\n--- thread continuation ---");
const r2 = await call(
  "delegate_to_perch",
  {
    task: "What exact word did I ask you to reply with in the previous message? Reply with only that word.",
    cwd,
    thread_id: j1.thread_id,
    wait_seconds: 240,
    timeout_seconds: 300,
  },
  420000
);
const j2 = JSON.parse(textOf(r2));
console.log(JSON.stringify({ assistant_text: j2.assistant_text, thread_id: j2.thread_id, error: j2.error }, null, 2));
if (j2.assistant_text !== "MCP_E2E_OK") throw new Error("thread continuation failed");

console.log("\n--- error path: pro model on starter plan ---");
const r3 = await call(
  "delegate_to_perch",
  { task: "hi", cwd, model: "pro", wait_seconds: 60, timeout_seconds: 120 },
  120000
);
const j3 = JSON.parse(textOf(r3));
console.log(JSON.stringify({ isError: r3.isError, error: j3.error }, null, 2));
if (!r3.isError || !j3.error) throw new Error("error path did not surface failure");

console.log("\n--- job status on finished job ---");
const r4 = await call("perch_job_status", { job_id: j1.job_id }, 30000);
const j4 = JSON.parse(textOf(r4));
console.log(JSON.stringify({ status: j4.status, perch_status: j4.perch_status, model_id: j4.model_id }, null, 2));
if (j4.status !== "finished") throw new Error("status check failed");

console.log("\n--- async handoff + mid-run cancel ---");
const r5 = await call(
  "delegate_to_perch",
  {
    task: "Run this exact PowerShell command and only after it finishes reply DONE: Start-Sleep -Seconds 120",
    cwd,
    wait_seconds: 8,
    timeout_seconds: 300,
  },
  60000
);
const j5 = JSON.parse(textOf(r5));
console.log(JSON.stringify({ status: j5.status, job_id: j5.job_id }, null, 2));
if (j5.status !== "running" || !j5.job_id) throw new Error("async handoff failed");
const r6 = await call("perch_job_cancel", { job_id: j5.job_id }, 60000);
const j6 = JSON.parse(textOf(r6));
console.log(JSON.stringify({ status: j6.status, canceled: j6.canceled, exit_code: j6.exit_code }, null, 2));
if (j6.status !== "finished" || !j6.canceled) throw new Error("cancel failed");

console.log(`\nprogress notifications received: ${progressCount}`);
if (progressCount < 1) throw new Error("no progress notifications received");

await client.close();
console.log("\nALL E2E CHECKS PASSED");
