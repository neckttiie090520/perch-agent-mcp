import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const client = new Client({ name: "def-check", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../index.js", import.meta.url))], env: process.env }));
const r = await client.callTool({ name: "delegate_to_perch", arguments: { task: "Reply with exactly DEFMAX_OK", cwd: process.env.TEMP, wait_seconds: 240, timeout_seconds: 300 } }, undefined, { timeout: 420000 });
const j = JSON.parse(r.content[0].text);
console.log(JSON.stringify({ ok: j.ok, assistant_text: j.assistant_text, model_id: j.model_id, model_label: j.model_label }, null, 2));
await client.close();
