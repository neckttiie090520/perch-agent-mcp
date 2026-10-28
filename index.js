#!/usr/bin/env node
// perch-agent: MCP stdio server. Claude Code / opencode (orchestrator) delegate
// tasks to Perch AI (worker) via the official `perch` CLI (`perch run --json`).
//
// Quick config (see README for the full guide):
//   claude mcp add --scope user perch-agent -- node <path>/index.js
//   opencode.json -> mcp.perch-agent = { type:"local", command:["node","<path>/index.js"], timeout:1200000 }
//
// Env overrides:
//   PERCH_AGENT_MODEL   default pinned model (default: "standard";
//                       e.g. "qwen-3.8-max" — free on Starter until 2026-11-20)
//   PERCH_AGENT_EFFORT  reasoning effort        (default: "high")
//   PERCH_AGENT_DEFAULT_CWD  fallback working directory (default: OS temp dir)
//   PERCH_AGENT_CLI     explicit path to the perch CLI entry (.js)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_MODEL = process.env.PERCH_AGENT_MODEL?.trim() || "standard";
const DEFAULT_EFFORT = process.env.PERCH_AGENT_EFFORT?.trim() || "high";

const DEFAULT_CWD = process.env.PERCH_AGENT_DEFAULT_CWD?.trim() || tmpdir();
const MAX_JOBS = 50;
const STDOUT_MAX = 512 * 1024;
const TAIL = 4000;
const CHARACTER_LIMIT = 20000;

// Baked-in working guidelines for every delegated task (karpathy-guidelines):
// assumptions surfaced, minimal change, surgical scope, verification with real
// evidence. Perch is autonomous, so the preamble is the only steering we get.
const GUIDELINES = `Working guidelines for this task (follow strictly):
1. Think before coding — state your assumptions explicitly in the final summary; if the task is ambiguous, pick the simplest reasonable interpretation and say so.
2. Simplicity first — the minimum change that solves the problem; no speculative features, no abstractions for single-use code.
3. Surgical changes — touch only what the task requires; never reformat or refactor unrelated code; every changed file must trace to the task.
4. Goal-driven verification — decide what "done" means, actually run the relevant tests/builds/commands, and in your final summary quote the real command and its output as evidence. Never claim verification without evidence; list anything left unfinished.`;

const jobs = new Map();

function pruneJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const done = [...jobs.values()]
    .filter((j) => j.done)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const j of done) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(j.id);
  }
}

async function killTree(pid) {
  return new Promise((resolve) => {
    const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    k.on("exit", () => resolve());
    k.on("error", () => resolve());
  });
}

// Node >=20.12 refuses to spawn .cmd/.bat without shell (CVE-2024-27980), and
// shell:true would expose task text to cmd.exe metacharacter parsing. Resolve
// the CLI to its real .js entry and spawn node directly instead.
async function cliEntryFromPackage(pkgJsonPath, fallbackName) {
  const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[fallbackName] ?? Object.values(pkg.bin ?? {})[0];
  if (!bin) throw new Error(`no bin entry in ${pkgJsonPath}`);
  return join(dirname(pkgJsonPath), bin);
}

async function resolveCli() {
  const override = process.env.PERCH_AGENT_CLI?.trim();
  const npmDir = join(process.env.APPDATA || "", "npm");
  const candidates = override
    ? [override]
    : [join(npmDir, "node_modules", "perchai-cli", "package.json")];
  for (const c of candidates) {
    try {
      if (c.endsWith("package.json")) {
        const js = await cliEntryFromPackage(c, "perch");
        return { command: process.execPath, baseArgs: [js] };
      }
      await access(c);
      if (/\.cmd$/i.test(c)) {
        const js = await cliEntryFromPackage(
          join(dirname(c), "node_modules", "perchai-cli", "package.json"),
          "perch"
        );
        return { command: process.execPath, baseArgs: [js] };
      }
      if (/\.js$/i.test(c)) return { command: process.execPath, baseArgs: [c] };
      return { command: c, baseArgs: [] };
    } catch {}
  }
  throw new Error(
    `Perch CLI not found (tried: ${candidates.join(", ")}). Install with: npm i -g perchai-cli, or set PERCH_AGENT_CLI.`
  );
}

function parseRunJson(stdout) {
  // The CLI prints one pretty-printed JSON document at a line start, but agent
  // runs can echo code (with line-start braces) into notices before it. Try
  // every line-start "{" and keep the LAST parse that looks like run output.
  let best = null;
  for (let i = stdout.indexOf("{"); i !== -1; i = stdout.indexOf("{", i + 1)) {
    if (i > 0 && stdout[i - 1] !== "\n" && stdout[i - 1] !== "\r") continue;
    try {
      const cand = JSON.parse(stdout.slice(i));
      if (cand && typeof cand === "object" && ("ok" in cand || "assistantText" in cand || "threadId" in cand)) {
        best = cand;
      }
    } catch {}
  }
  return best;
}

function extractResult(parsed, fallback) {
  if (!parsed) return fallback;
  const snap = parsed.contextSnapshot ?? null;
  const usage = snap?.turnApiUsage ?? snap?.lastApiUsage ?? null;
  return {
    ok: parsed.ok === true,
    status: parsed.status ?? (parsed.ok === true ? "completed" : "unknown"),
    thread_id: parsed.threadId ?? null,
    turn_id: parsed.runId ?? null,
    assistant_text: typeof parsed.assistantText === "string" ? parsed.assistantText : null,
    model_id: snap?.modelId ?? parsed.modelId ?? null,
    model_label: snap?.modelLabel ?? parsed.modelLabel ?? null,
    usage: usage
      ? {
          input_tokens: usage.inputTokens ?? null,
          output_tokens: usage.outputTokens ?? null,
          total_tokens: usage.totalTokens ?? null,
        }
      : null,
  };
}

async function startJob(opts) {
  const { command, baseArgs } = await resolveCli();
  const cwd = opts.cwd || DEFAULT_CWD;
  const taskText =
    opts.guidelines === false ? opts.task : `${GUIDELINES}\n\nTask:\n${opts.task}`;
  const args = ["run", taskText, "--json", "--cwd", cwd, "--mode", opts.mode, "--permission", opts.permission ?? "take_the_wheel"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.thread_id) args.push("--thread", opts.thread_id);
  if (opts.persona) args.push("--persona", opts.persona);

  const proc = spawn(command, [...baseArgs, ...args], { cwd, windowsHide: true, env: { ...process.env } });
  const job = {
    id: `pj-${randomUUID().slice(0, 8)}`,
    proc,
    task: opts.task,
    cwd,
    startedAt: Date.now(),
    endedAt: null,
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    timedOut: false,
    canceled: false,
    done: false,
    timeoutHandle: setTimeout(() => {
      job.timedOut = true;
      killTree(proc.pid);
    }, opts.timeout_seconds * 1000),
  };
  jobs.set(job.id, job);
  pruneJobs();

  proc.stdout.on("data", (d) => {
    if (job.stdout.length < STDOUT_MAX) job.stdout += d.toString();
  });
  proc.stderr.on("data", (d) => {
    if (job.stderr.length < STDOUT_MAX) job.stderr += d.toString();
  });
  job.exited = new Promise((resolve) => {
    proc.on("error", (err) => {
      // Failed spawns may never emit "exit" — finalize here or the job would
      // sit in "running" forever.
      clearTimeout(job.timeoutHandle);
      job.spawnError = String(err?.message ?? err);
      job.exitCode = job.exitCode ?? -1;
      job.endedAt = Date.now();
      job.done = true;
      resolve();
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(job.timeoutHandle);
      job.exitCode = code;
      job.signal = signal;
      job.endedAt = Date.now();
      job.done = true;
      resolve();
    });
  });
  return job;
}

function jobSummary(job) {
  const parsed = parseRunJson(job.stdout);
  const base = {
    job_id: job.id,
    task: job.task,
    cwd: job.cwd,
    status: job.done ? "finished" : "running",
    elapsed_seconds: Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000),
  };
  if (!job.done) return base;
  base.exit_code = job.exitCode;
  base.signal = job.signal;
  base.duration_seconds = job.endedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : null;
  if (job.spawnError) {
    base.error = job.spawnError;
    return base;
  }
  const res = extractResult(parsed, null);
  if (res) {
    base.perch_status = res.status;
    Object.assign(base, res, { status: base.status });
  }
  if (job.timedOut) base.timeout = true;
  if (job.canceled) base.canceled = true;

  const failed =
    job.exitCode !== 0 ||
    job.spawnError ||
    (res && res.ok === false) ||
    (job.signal !== null && job.signal !== undefined);
  if (failed && !base.error) {
    const firstBrace = job.stdout.indexOf("{");
    const notice = firstBrace > 0 ? job.stdout.slice(0, firstBrace).trim() : "";
    const errText = parsed?.error ?? parsed?.message ?? null;
    const stderrTail = job.stderr.trim().slice(-TAIL);
    base.error =
      (typeof errText === "string" && errText) ||
      notice ||
      stderrTail ||
      (job.timedOut
        ? `timed out after job timeout`
        : job.canceled
          ? "canceled by request"
          : `perch run exited with code ${job.exitCode}`);
    if (/login|sign[- ]?in|auth/i.test(base.error)) {
      base.hint = "Perch session missing or expired. Run: perch login";
    }
  }
  if (!res && !base.error) {
    base.error = "could not parse perch run --json output";
    base.stdout_tail = job.stdout.trim().slice(-TAIL);
    base.stderr_tail = job.stderr.trim().slice(-TAIL);
  }
  return base;
}

function textResult(payload, isError = false) {
  return {
    isError,
    content: [{ type: "text", text: clip(JSON.stringify(payload, null, 2)) }],
  };
}

function clip(s) {
  return s.length > CHARACTER_LIMIT ? s.slice(0, CHARACTER_LIMIT) + "\n…[truncated to fit context]" : s;
}

// glm-mcp pattern: stream progress via notifications/progress when the caller
// supplied a progressToken; also keeps timeout-resetting clients alive.
function makeProgress(extra) {
  const token = extra?._meta?.progressToken;
  let seq = 0;
  return (message) => {
    if (token == null || !extra?.sendNotification) return;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++seq, message },
      })
      .catch(() => {});
  };
}

async function waitWithProgress(job, waitMs, onProgress) {
  let elapsed;
  const iv = setInterval(() => {
    elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    onProgress(`perch running… ${elapsed}s elapsed (job ${job.id})`);
  }, 5000);
  try {
    return await Promise.race([
      job.exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), waitMs)),
    ]);
  } finally {
    clearInterval(iv);
  }
}

const server = new McpServer({ name: "perch-agent", version: "0.2.0" });

server.registerTool(
  "delegate_to_perch",
  {
    title: "Delegate task to Perch AI",
    description:
      "Delegate a task to Perch AI (worker agent) via the official perch CLI. Perch runs autonomously in the given working directory with its own tools (bash, file read/write, skills) on the signed-in Perch plan. Karpathy working guidelines (assumptions, simplicity, surgical scope, evidence-based verification) are prepended to every task by default (guidelines:false to disable). Returns the final answer, thread id, and status. Long-running tasks: pass wait_seconds to bound blocking; if still running you get a job_id — poll perch_job_status.",
    inputSchema: {
      task: z.string().min(1).describe("Natural-language task for Perch to execute autonomously."),
      cwd: z.string().optional().describe("Working directory Perch operates in (default: temp dir)."),
      mode: z
        .enum(["ask", "agents", "plan"])
        .default("agents")
        .describe("agents = autonomous execution with tools; ask = answer only; plan = plan only."),
      permission: z
        .enum(["take_the_wheel", "auto_review", "default"])
        .default("take_the_wheel")
        .describe("Perch permission mode. take_the_wheel = never asks before writes/commands (required for autonomous delegation; auto_review makes the worker stop and ask, ending the turn)."),
      guidelines: z
        .boolean()
        .default(true)
        .describe("Prepend the karpathy working guidelines (assumptions, simplicity, surgical scope, evidence-based verification) to the task."),
      model: z
        .string()
        .default(DEFAULT_MODEL)
        .describe(
          'Model tier or pinned model id: "standard", "standard 1m", "pro", "pro 1m", or a pin id like "qwen-3.8-max" (free on Starter until 2026-11-20, effort off..high). Defaults to $PERCH_AGENT_MODEL or "standard".'
        ),
      effort: z
        .enum(["off", "low", "medium", "high", "xhigh", "max", "ultra"])
        .default(DEFAULT_EFFORT)
        .describe("Reasoning effort. Defaults to $PERCH_AGENT_EFFORT or \"high\". Starter plans cap effort at high; some promo models only accept off..high."),
      persona: z.enum(["saffron", "quill"]).optional().describe("Perch persona."),
      thread_id: z
        .string()
        .optional()
        .describe("Continue an existing Perch thread (from a previous result's thread_id)."),
      wait_seconds: z
        .number()
        .int()
        .min(1)
        .max(3600)
        .default(120)
        .describe("Seconds to block waiting for completion before returning a running job_id."),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(21600)
        .default(1800)
        .describe("Hard limit; the Perch process tree is killed after this."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async (opts, extra) => {
    try {
      const job = await startJob(opts);
      const onProgress = makeProgress(extra);
      onProgress(`perch job ${job.id} started (${opts.mode}${opts.model ? `, ${opts.model}` : ""})`);
      // Client cancelling the MCP request kills the Perch process tree too.
      extra?.signal?.addEventListener(
        "abort",
        () => {
          if (!job.done) {
            job.canceled = true;
            killTree(job.proc.pid);
          }
        },
        { once: true }
      );
      const finished = await waitWithProgress(job, opts.wait_seconds * 1000, onProgress);
      if (finished) {
        const summary = jobSummary(job);
        const failed = Boolean(summary.error);
        return textResult(summary, failed);
      }
      return textResult({
        ...jobSummary(job),
        note: "Still running. Poll perch_job_status with job_id; cancel with perch_job_cancel.",
      });
    } catch (err) {
      return textResult({ error: String(err?.message ?? err) }, true);
    }
  }
);

server.registerTool(
  "perch_job_status",
  {
    title: "Perch job status",
    description: "Get status/result of a delegated Perch job by job_id.",
    inputSchema: {
      job_id: z.string().min(1),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) return textResult({ error: `unknown job_id: ${job_id}` }, true);
    return textResult(jobSummary(job), Boolean(jobSummary(job).error));
  }
);

server.registerTool(
  "perch_job_cancel",
  {
    title: "Cancel Perch job",
    description: "Kill a running delegated Perch job (process tree).",
    inputSchema: { job_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) return textResult({ error: `unknown job_id: ${job_id}` }, true);
    if (job.done) return textResult({ job_id, status: "finished", note: "already finished" });
    job.canceled = true;
    await killTree(job.proc.pid);
    await job.exited;
    return textResult(jobSummary(job));
  }
);

server.registerTool(
  "perch_status",
  {
    title: "Perch CLI & server status",
    description:
      "Free local check (no model call): perch CLI presence and sign-in state, plus this server's live job list. Call before delegating if unsure the worker is ready.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const jobList = [...jobs.values()].map((j) => ({
      job_id: j.id,
      status: j.done ? "finished" : "running",
      task: j.task.slice(0, 80),
    }));
    try {
      const { command, baseArgs } = await resolveCli();
      const out = await new Promise((resolve) => {
        const p = spawn(command, [...baseArgs, "status"], { windowsHide: true, env: { ...process.env } });
        let s = "";
        p.stdout.on("data", (d) => (s += d.toString()));
        p.stderr.on("data", (d) => (s += d.toString()));
        p.on("error", (e) => resolve(`(perch status failed: ${e.message})`));
        p.on("exit", () => resolve(s.trim().slice(0, 500)));
      });
      return textResult({
        cli: out || "(no output)",
        defaults: { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, env_model: process.env.PERCH_AGENT_MODEL ?? null },
        active_jobs: jobList.filter((j) => j.status === "running"),
        recent_jobs: jobList.filter((j) => j.status === "finished").slice(-10),
        guidelines: "karpathy guidelines are prepended to every delegation by default (guidelines:false to disable)",
      });
    } catch (err) {
      return textResult({ error: String(err?.message ?? err), active_jobs: jobList }, true);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
