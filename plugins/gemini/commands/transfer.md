---
description: Transfer the current Claude Code session into a resumable Gemini session
argument-hint: "[--source <claude-jsonl>] [--include-tool-output]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Gemini session ID and the `gemini --session-file <path>` command.

If the command reports that it could not identify the current Claude transcript, tell the user to pass `--source ~/.claude/projects/<project>/<session-id>.jsonl` explicitly.
