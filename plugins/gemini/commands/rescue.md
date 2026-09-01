---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Gemini rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--plan] [--model <pro|pro-3|flash|flash-lite|2.5-pro|auto|model-id>] [--effort <low|medium|high>] [what Gemini should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `gemini:gemini-rescue` subagent via the `Agent` tool (`subagent_type: "gemini:gemini-rescue"`), forwarding the raw user request as the prompt.

`gemini:gemini-rescue` is a subagent, not a skill — do not call `Skill(gemini:rescue)` (no such skill) or `Skill(gemini-rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `gemini:gemini-rescue` subagent in the background.
- If the request includes `--wait`, run the `gemini:gemini-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--effort`, and `--plan` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Gemini, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Gemini thread or start a new one.
- The two choices must be:
  - `Continue current Gemini thread`
  - `Start a new Gemini thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Gemini thread (Recommended)` first.
- Otherwise put `Start a new Gemini thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/gemini:status`, fetch `/gemini:result`, call `/gemini:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort. Note: the flag is accepted but has no effect yet (pending upstream ACP support for thinkingLevel).
- Leave the model unset unless the user explicitly asks for one. Accept Gemini model aliases: `pro`, `pro-3`, `flash`, `flash-lite`, `2.5-pro`, `auto`. Pass concrete model IDs through unchanged.
- `--plan` maps to Gemini's `--approval-mode plan` (read-only planning run). Without `--plan`, the companion defaults to `--yolo --sandbox` (Gemini CLI built-in sandbox, filesystem scoped to the working tree).
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- Checking on the run is your job, not the subagent's. A returned subagent is not a finished Gemini run. The run counts as finished only when the output carries the companion's own result body. A promise to report later, a timeout notice, or a bare "moved to the background" line all mean it is still going — the subagent ended, the Gemini job did not.
- In that case confirm before treating the work as done: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status <job-id> --wait --timeout-ms 3600000` with `run_in_background: true`. A background call has no 600-second ceiling, and the harness re-invokes you when the wait exits. Drop the job id to wait on the one active job in this session.
- If that report still shows `queued` or `running`, read its `Liveness:` line before waiting again. `the log is still growing` means Gemini is working, so wait. `nothing new in the log for <time>` means it may be stuck. `the recorded process is gone` means it died without recording a result — report that and stop waiting.
- Once the status is terminal, collect the output with `/gemini:result <job-id>`.
- If the helper reports that Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
- When the rescue is exploratory or diagnostic (e.g., "where is X used?", "trace this flow", "why is this failing?"), the forwarded prompt should suggest that Gemini reach for its built-in `codebase_investigator` subagent before drafting a fix — it ships with the `codebase-investigation` skill and is already configured to use `gemini-3.1-pro-preview`.
