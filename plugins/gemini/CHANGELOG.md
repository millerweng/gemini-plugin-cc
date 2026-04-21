# Changelog

## 1.0.0

- First public release as a standalone open-source repository.
- Fixed Codex leftover references in stop-review-gate prompt.
- Aligned model alias documentation with verified Gemini CLI model IDs.
- Added comprehensive README, test suite, CI/CD, and version management tooling.
- Consolidated general-purpose delegation into `/gemini:rescue` (removed standalone `/gemini:delegate`).
- Removed hardcoded `DEFAULT_MODEL` fallback; Gemini now picks its own default when `--model` is unset.
- Fixed remaining `!gemini` / `GEMINI_API_KEY` auth remediation strings in stop-gate and settings discovery.
- Hardened `.gitignore` to ignore `.gemini/` and `.env.*` (prevents accidental credential commits).
- Added `/reload-plugins` to README install flow (matches upstream baseline).
- Removed `--worktree` flag (ACP mode does not support Gemini's `-w` worktree creation).
- Fixed setup auth guidance to use `gemini auth` instead of nonexistent `!gemini auth`.
- Added ACP capability probe to readiness check (catches incompatible Gemini builds).
- Fixed stop-gate auth remediation to use `/gemini:setup` instead of generic `GEMINI_API_KEY` suggestion.
- Fixed stop-gate review sessions polluting rescue resume state (`--resume` no longer picks up gate threads).
- Fixed `setup --verify` hanging against live Gemini CLI (switched to async spawn, added `mcpServers: []`).
- Removed false ACP filesystem capabilities (client no longer advertises unimplemented `readTextFile`/`writeTextFile`).
- Added runtime test coverage for stop-gate exclusion, ACP capabilities, and verify connectivity.

## 0.1.0

- Initial version of the Gemini plugin for Claude Code.
- Codex-parity architecture: background jobs, workspace-keyed state,
  ACP broker for multiplexed concurrent sessions, Stop-hook review gate,
  `/gemini:setup`, `/gemini:rescue`, `/gemini:review`,
  `/gemini:adversarial-review`, `/gemini:status`, `/gemini:result`,
  `/gemini:cancel` commands.
- `gemini-rescue` subagent (Bash-only forwarder) with default `--yolo --sandbox`.
- Integrates with Google's Gemini CLI via `gemini --acp` (JSON-RPC 2.0 over stdio).
