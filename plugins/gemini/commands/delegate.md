---
description: Delegate any task to Gemini — research, writing, analysis, code generation, brainstorming, explanation, or anything else. Routes to the Gemini rescue subagent for thin pass-through execution.
argument-hint: "[--background|--wait] [--resume|--fresh] [--plan] [--worktree <path>] [--model <pro|pro-3|flash|flash-lite|2.5-pro|auto|model-id>] [--effort <low|medium|high>] [what Gemini should do]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `gemini:gemini-rescue` subagent.
The final user-visible response must be Gemini's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `gemini:gemini-rescue` subagent in the background.
- If the request includes `--wait`, run the `gemini:gemini-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--effort`, `--plan`, and `--worktree` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Gemini, check for a resumable thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Gemini thread or start a new one.
- The two choices must be:
  - `Continue current Gemini thread`
  - `Start a new Gemini thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", or "dig deeper", put `Continue current Gemini thread (Recommended)` first.
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
- `--worktree <path>` maps to Gemini's `-w <path>` (run in the given worktree).
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should do.
- Unlike `/gemini:rescue`, do not nudge the forwarded prompt toward `codebase_investigator`. This command is general-purpose; the task may not involve code at all.
