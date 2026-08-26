# Changelog

## 1.1.0

- Fixed `oauth-personal` always reporting "not authenticated". The probe looked for
  `~/.gemini/gemini-credentials.json`, a name Gemini CLI does not write; it now finds
  `oauth_creds.json` and still accepts the legacy name.
- `setup --verify` no longer refuses to run when the credential file is missing. A
  configured auth type always gets a real ACP handshake, and a successful handshake
  overrides the on-disk probe. Credential layout is Gemini CLI's business and it
  changes between releases, so a live session is the only trustworthy answer.
- `auth.detail` now names the credential file it found, or lists the names it probed.
- Added `/gemini:transfer`, which turns the current Claude Code session into a
  resumable Gemini session and prints the `gemini --session-file` command. Ported
  from codex-plugin-cc #374, which uses a Codex-only import RPC; this writes a
  native Gemini JSONL session instead. Harness markup (slash-command echoes,
  reminders) is stripped and tool payloads are collapsed unless
  `--include-tool-output` is passed.
- `SessionStart` now exports the transcript path so `/gemini:transfer` works without
  an explicit `--source`.
- Git commands no longer pass repository-derived arguments through a shell on
  Windows (codex-plugin-cc #447).
- Fixed `/gemini:review` failing with `Missing array next_steps` and dumping raw
  JSON instead of a rendered review. The prompts promised Gemini a schema it was
  never shown, and the renderer hard-rejected any response without `next_steps`.
  The real schema is now injected into the prompt, and `next_steps` is optional at
  render time. Upstream PR #5 by @petems, fixes upstream issue #4.
- Fixed the companion resolving its state directory into another plugin's data
  directory. `CLAUDE_PLUGIN_DATA` can point at the Codex plugin, whose state layout
  is identical, so this client would load Codex's broker session, dial the Codex
  app-server and fail every task with `unknown variant 'session/new'`. The
  directory is now checked for ownership, and a wrong-dialect broker reply falls
  back to the direct transport and forgets the endpoint. Fixes upstream issue #8,
  reported with a verified fix by @mplezier.

- Stopped sending small diffs down the self-collect path. `maxInlineFiles` was 2, so
  any change touching three files skipped the inline diff no matter how small it was —
  a 365-byte three-file diff qualified. Gemini was then told to fetch the diff itself
  with git, which an ACP session cannot do, and it returned `approve` inferred from
  diffstat line counts. The byte budget now decides; the file count is a loose guard
  at 60.
- When the diff genuinely does not fit, the prompt now forbids `approve` without
  evidence: Gemini must say which evidence it could not obtain and return
  `needs-attention`. The rendered output carries a warning naming the size that
  triggered it, so a verdict reached without the diff cannot pass for a reviewed one.

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
