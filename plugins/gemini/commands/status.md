---
description: Show active and recent Gemini jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Leave out progress blocks and prose beyond the table. The command's own table already carries a `Liveness` column — keep it, since it is the only column that says whether a run is alive.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

Liveness:

- `Elapsed` counts from the start and climbs whether or not the run is alive, so it never answers "is this stuck?". The `Liveness:` line does, and `Last update:` is the evidence behind it.
- `Liveness: the log is still growing` means Gemini is working. When the user is asking whether a long run is stuck, say plainly that it is alive and give `Last update:`.
- `Liveness: nothing new in the log for <time>` means the run may be stuck. Report it, point at the `Log:` path, and offer `/gemini:cancel <job-id>`.
- `Liveness: the recorded process is gone` means the job died without recording a result, so its `running` status is stale. Say the run is dead and offer to start it again. A dead job is never "still working".

