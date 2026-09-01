---
description: Show the stored final output for a finished Gemini job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/gemini:status <id>` and `/gemini:review`

Coverage reporting:
- A stored review replays the same `Warning:` lines the original run printed. Read them before presenting anything.
- `the diff was too large to send in full ... so it was truncated` — Gemini saw only part of the diff, and every path under `Files Not Included` went unreviewed.
- `base ... was auto-detected and the range covers N files` — the range may be wider than the change the user meant.
- `N of M lenses produced no usable result` — those lenses contributed nothing to the findings.
- When any of these appear, open with one sentence of your own naming the limit and what it leaves uncovered, then give the full output. Presenting a partial review as a clean verdict is the failure this rule prevents.
- Then offer a narrower rerun: `/gemini:review --base <ref>`, or `--scope working-tree` when only the uncommitted change matters.
- With no `Warning:` line, present the output as-is and add nothing.
