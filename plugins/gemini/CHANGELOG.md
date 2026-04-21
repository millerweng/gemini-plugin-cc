# Changelog

## 1.0.0

- First public release as a standalone open-source repository.
- Fixed Codex leftover references in stop-review-gate prompt.
- Aligned model alias documentation with verified Gemini CLI model IDs.
- Added comprehensive README, test suite, CI/CD, and version management tooling.
- Consolidated general-purpose delegation into `/gemini:rescue` (removed standalone `/gemini:delegate`).
- Removed `--worktree` flag (ACP mode does not support Gemini's `-w` worktree creation).
- Fixed setup auth guidance to use `gemini auth` instead of nonexistent `!gemini auth`.
- Added ACP capability probe to readiness check (catches incompatible Gemini builds).
- Fixed stop-gate auth remediation to use `/gemini:setup` instead of generic `GEMINI_API_KEY` suggestion.

## 0.1.0

- Initial version of the Gemini plugin for Claude Code.
- Codex-parity architecture: background jobs, workspace-keyed state,
  ACP broker for multiplexed concurrent sessions, Stop-hook review gate,
  `/gemini:setup`, `/gemini:rescue`, `/gemini:review`,
  `/gemini:adversarial-review`, `/gemini:status`, `/gemini:result`,
  `/gemini:cancel` commands.
- `gemini-rescue` subagent (Bash-only forwarder) with default `--yolo --sandbox`.
- Integrates with Google's Gemini CLI via `gemini --acp` (JSON-RPC 2.0 over stdio).
