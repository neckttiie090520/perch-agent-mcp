import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const serverPath = fileURLToPath(new URL("../index.js", import.meta.url));
const client = new Client({ name: "q38-check", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: process.env }));
const r = await client.callTool({
  name: "delegate_to_perch",
  arguments: { task: "Reply with exactly MCP_Q38_OK", cwd: process.env.TEMP, model: "qwen-3.8-max", effort: "high", wait_seconds: 240, timeout_seconds: 300 },
}, undefined, { timeout: 420000 });
const j = JSON.parse(r.content[0].text);
console.log(JSON.stringify({ ok: j.ok, perch_status: j.perch_status, assistant_text: j.assistant_text, model_id: j.model_id, model_label: j.model_label, thread_id: j.thread_id, error: j.error }, null, 2));
await client.close();
