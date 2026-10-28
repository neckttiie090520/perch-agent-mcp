# review-findings.md

Review of `index.js` (438 lines) — MCP stdio server that delegates tasks to the
`perch` CLI. Test suite reviewed: `test-client.mjs` (116 lines, E2E only).

**Most serious latent defect:** the 512 KB stdout capture cap silently truncates
the `perch run --json` payload, which destroys the JSON parse and converts a
fully successful run into a hard error with no result.

---

## 1. The bug

`index.js:156` stops appending stdout the moment the buffer reaches 512 KB, but
the child process is left running and its exit code is still recorded as success.
The truncation is never flagged on the job object, so nothing downstream knows
the buffer is incomplete.

```js
// index.js:16
const STDOUT_MAX = 512 * 1024;

// index.js:155-157
proc.stdout.on("data", (d) => {
  if (job.stdout.length < STDOUT_MAX) job.stdout += d.toString();
});
```

`job.stdout` therefore ends up holding a *prefix* of the JSON document. The
parser then requires the payload to be the last thing in the buffer:

```js
// index.js:89-97
function parseRunJson(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start));   // index.js:93
  } catch {
    return null;
  }
}
```

`JSON.parse` on a truncated prefix throws, `parseRunJson` returns `null`,
`extractResult(parsed, null)` (index.js:195) returns `null`, and the
`!res && !base.error` branch fires:

```js
// index.js:226-230
if (!res && !base.error) {
  base.error = "could not parse perch run --json output";
  base.stdout_tail = job.stdout.trim().slice(-TAIL);
  base.stderr_tail = job.stderr.trim().slice(-TAIL);
}
```

Because `base.error` is set, `delegate_to_perch` marks the MCP result
`isError: true` (index.js:351-352) even though the child exited 0. The caller
loses `assistant_text`, `thread_id`, `turn_id`, `model_id`, and `usage` — most
importantly `thread_id`, which is the handle needed to continue the thread.

### Why the cap is reachable in normal operation

The cap is on the *whole* stdout buffer, and the `--json` envelope carries more
than the answer text: `assistantText`, `events`, `segments`, and
`contextSnapshot` (confirmed in the installed CLI, `perchai-cli` 2.4.118,
`dist/perch.mjs`). A single long report, a large diff, or a verbose event/segment
list pushes the envelope past 512 KB. The cap is also checked *before* appending,
so the buffer overshoots by up to one chunk and can never be exactly `STDOUT_MAX`.

## 2. Failure scenario (executed, not reasoned)

Harness: `repro.mjs` loads the real `index.js` source (shebang and the 8 import
lines stripped, server-registration tail cut at `const server = new McpServer(`)
and drives the genuine `startJob` / `jobSummary` with a fake CLI that prints a
valid `perch run --json` envelope and exits 0. No network, no model call.

Command:

```
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList "repro.mjs" -NoNewWindow -Wait -PassThru -RedirectStandardOutput "repro-out.txt" -RedirectStandardError "repro-err.txt"
```

Output (`repro-out.txt`), abridged to the two decisive cases:

```
=== CONTROL: small payload (well under STDOUT_MAX) ===
  child exit_code      : 0
  child stdout bytes   : 420  (STDOUT_MAX = 524288)
  parseRunJson         : parsed OK
  summary.error        : (none)
  summary.perch_status : completed
  summary.assistant_text: string, 200 chars
  summary.thread_id    : thread-abc

=== BUG: 600k-char assistantText (exit 0, successful run) ===
  child exit_code      : 0
  child stdout bytes   : 524288  (STDOUT_MAX = 524288)
  parseRunJson         : NULL (parse failed)
  summary.error        : could not parse perch run --json output
  summary.perch_status : (none)
  summary.assistant_text: undefined
  summary.thread_id    : (none)
  summary.usage        : null
```

A 2,000,000-character `assistantText` produces byte-identical output to the
600,000-character case: the buffer pins at exactly 524,288 bytes, the parse
fails, and the successful run is reported as an error.

Concrete user-visible sequence:

1. Orchestrator calls `delegate_to_perch` with a task whose answer is long
   (e.g. "review this repo and write up every finding").
2. Perch completes the work, exits 0, and prints a >512 KB JSON envelope.
3. The buffer truncates mid-document; `parseRunJson` returns `null`.
4. The tool returns `isError: true` with
   `error: "could not parse perch run --json output"`.
5. The orchestrator concludes the delegation failed and retries — re-running the
   whole task and burning credits — or gives up on work that actually succeeded.
   `thread_id` is gone, so the thread cannot even be resumed to recover it.

## 3. Why the test suite does not catch it

`test-client.mjs` is a live E2E suite and every assertion uses a tiny payload:

- `test-client.mjs:54` — `"Reply with exactly MCP_E2E_OK"` (11 characters).
- `test-client.mjs:65` — asks for a single word back.
- `test-client.mjs:80` — `"hi"`, and asserts the *error* path.
- `test-client.mjs:97` — `Start-Sleep -Seconds 120`, then `DONE`.
- `test-client.mjs:59`, `:75`, `:91`, `:106`, `:110` — assert `assistant_text`,
  `thread_id`, `status`, `canceled`, and progress notifications.

Every one of those payloads is a few hundred bytes against a 512 KB cap, roughly
three orders of magnitude of headroom. The suite never asserts anything about
`stdout` size, never exercises a large answer, and never checks that a
successful exit with an unparseable payload is distinguishable from a real
failure. The bug needs a >512 KB envelope to appear, so it is invisible to the
current suite by construction.

## 4. Secondary latent defect (same family, lower severity)

`parseRunJson` assumes the JSON object is the last thing on stdout and that the
first `{` in the buffer begins it (index.js:90, index.js:93). Any pre-JSON
progress/log line containing a brace breaks the parse:

```
=== SECONDARY: log line containing a brace before the JSON ===
  child exit_code : 0
  parseRunJson    : NULL (parse failed)
  summary.error   : could not parse perch run --json output
  assistant_text  : (none)
```

The same failure mode as the primary bug (successful run reported as an error),
triggered by a stray `{` in a log line rather than by size. The `notice`
extraction at index.js:209-210 has the identical assumption, so the error text
it surfaces would also be wrong in that case. Not the headline defect because it
depends on the CLI emitting brace-bearing pre-JSON output, which was not
observed; the size cap is reachable from ordinary long answers alone.

## 5. Suggested fix (not applied — review only)

- Track truncation explicitly: set a `job.stdoutTruncated = true` flag when the
  cap is hit (index.js:156), and surface it in `jobSummary` instead of reporting
  a parse failure.
- Parse the JSON envelope from the *end* of the buffer, or stream-parse the
  `--json` payload, rather than `indexOf("{")` + `JSON.parse(slice(start))`.
- Distinguish "child failed" from "child succeeded but the result could not be
  read", so a successful run is never returned as `isError: true`.
- Add a test case with an answer larger than `STDOUT_MAX`; that single case
  covers the primary defect.

## 6. Scope and assumptions

- Assumption: `STDOUT_MAX` is intended as a memory guard, not as a deliberate
  result-size limit. Either way the current behaviour is wrong, because the
  truncation is silent and the run is reported as failed rather than as
  truncated.
- The repro harness strips only the shebang and the import block (lines 1 and
  5-12) and cuts at the server-registration boundary (line 277); all logic under
  test — `startJob`, `jobSummary`, `parseRunJson`, `extractResult` — is the
  unmodified source.
- Verified against the installed `perchai-cli` 2.4.118 that `perch run` accepts
  `--json`, `--thread`, `--cwd`, `--mode`, `--persona`, `--model`, `--effort`
  (via `perch run --help`), so the argument construction at index.js:126-130 is
  consistent with the CLI. No model call was made; no Perch credits were spent.
- Not verified: the exact size at which the real CLI's envelope crosses 512 KB
  for a given task, since that requires a live run. The threshold is a property
  of the payload, not of this server.
