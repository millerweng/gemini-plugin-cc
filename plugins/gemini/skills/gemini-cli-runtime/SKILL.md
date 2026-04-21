---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Gemini CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-3-prompting` skill to rewrite the user's request into a tighter Gemini prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort. The flag is accepted but has no effect yet (pending upstream ACP support for thinkingLevel).
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Gemini model aliases:
  - `pro` → `gemini-3.1-pro-preview`
  - `pro-3` → `gemini-3.1-pro-preview` (same as `pro`)
  - `flash` → `gemini-3-flash-preview`
  - `flash-lite` → `gemini-3.1-flash-lite-preview`
  - `2.5-pro` → `gemini-2.5-pro`
  - `2.5-flash` → `gemini-2.5-flash`
  - `2.5-flash-lite` → `gemini-2.5-flash-lite`
  - `auto` → `auto-gemini-3`
  - `auto-2.5` → `auto-gemini-2.5`
- Default invocation mode for rescue is `--yolo --sandbox` (Gemini CLI built-in sandbox, filesystem scoped to the working tree). Opt out with `--plan` (maps to `--approval-mode plan`, read-only).

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize aliases from the table above and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`. Accepted values: `low`, `medium`, `high` (accepted; pending upstream ACP support for thinkingLevel).
- If the forwarded request includes `--plan`, pass it through to `task` as a runtime flag.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Gemini work in `gemini:gemini-rescue` unless the user explicitly asks for read-only behavior (pass `--plan`).
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.

ACP stability note:
- The Gemini ACP surface exposes methods like `session/new`, `session/prompt`, `session/cancel`, and `session/unstable_setSessionModel`. The `unstable_` prefix signals the method name may change. If ACP calls start failing with method-not-found errors, edit the method-name table at the top of `lib/acp-client.mjs` rather than rewriting the broker.
