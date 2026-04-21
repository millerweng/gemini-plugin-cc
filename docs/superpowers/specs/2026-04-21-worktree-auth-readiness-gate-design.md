# Fix: Worktree False Contract, Auth Guidance, Readiness Probe, and Gate Remediation

**Date:** 2026-04-21
**Status:** Implemented

---

## Problem Statement

Four findings from code audit:

1. **`--worktree` false contract (High):** `--worktree <path>` was documented as mapping to Gemini CLI's `-w <path>` (which creates a new git worktree), but the implementation only copied the value into `cwd` and then `resolveWorkspaceRoot` normalized it to the repo root. Since the plugin communicates with Gemini via ACP mode (`gemini --acp`), the `-w` flag cannot be passed through the protocol. The tests locked in the incorrect behavior.

2. **Setup auth guidance (Medium):** `setup.md` told users to run `!gemini auth`, but Gemini CLI has no `auth` subcommand accessible that way. The `!` prefix runs commands inside the Claude Code session, which cannot handle interactive browser-based auth flows. The correct command is `gemini auth` run in a separate terminal.

3. **Readiness checking (Medium):** `getGeminiAvailability` only checked `gemini --version` success. Every real command depends on `gemini --acp` mode plus the ACP RPC surface. Incompatible Gemini builds would pass the availability check and fail only at first real use.

4. **Stop-gate auth remediation (Medium):** The gate always suggested "set `GEMINI_API_KEY`" regardless of the configured auth mode (vertex-ai, google-api-key, oauth, gateway). This is wrong guidance for most supported auth configurations.

---

## Decisions

### Finding 1: Remove `--worktree` entirely

- Removed from `rescue.md` (argument-hint, runtime flags list, operating rules).
- Removed from `gemini-rescue.md` agent (forwarding rules).
- Removed from `gemini-companion.mjs` (usage string, valueOptions, aliasMap, cwd override).
- Removed from `gemini-cli-runtime/SKILL.md` (forwarding rules).
- Removed from `README.md` (flags table).
- Removed 3 worktree tests from `task-flags.test.mjs` and cleaned up TASK_CONFIG.

### Finding 2: Fix auth guidance to `gemini auth`

- Updated `setup.md` to recommend `gemini auth` in a terminal outside Claude Code.
- Explicitly warns against using Claude's `!` prefix for auth (requires interactive browser).
- Updated `gemini-companion.mjs` setup report to match.

### Finding 3: Add ACP probe to availability check

- Added `gemini --acp --help` probe after `--version` succeeds in `getGeminiAvailability`.
- If the ACP probe fails, returns `available: false` with descriptive message.
- This catches incompatible builds before any real command attempts to use ACP.

### Finding 4: Simplify gate auth remediation

- Replaced "set `GEMINI_API_KEY`" with "Run `/gemini:setup` to diagnose and fix auth."
- `/gemini:setup` already provides mode-specific guidance, so the gate doesn't need to duplicate that logic.

---

## Files Changed

| File | Change |
|---|---|
| `plugins/gemini/commands/rescue.md` | Removed `--worktree` from argument-hint, flags list, and rules |
| `plugins/gemini/agents/gemini-rescue.md` | Removed `--worktree` forwarding rule |
| `plugins/gemini/commands/setup.md` | Fixed auth guidance to `gemini auth` |
| `plugins/gemini/scripts/gemini-companion.mjs` | Removed worktree from usage/args/alias/cwd; fixed auth guidance |
| `plugins/gemini/scripts/lib/gemini.mjs` | Added ACP probe to `getGeminiAvailability` |
| `plugins/gemini/scripts/stop-review-gate-hook.mjs` | Simplified auth remediation message |
| `plugins/gemini/skills/gemini-cli-runtime/SKILL.md` | Removed `--worktree` forwarding rule |
| `README.md` | Removed `--worktree` from flags table |
| `tests/task-flags.test.mjs` | Removed 3 worktree tests, cleaned config |
| `plugins/gemini/CHANGELOG.md` | Document all four fixes |

---

## Verification

- `npm test`: 51/52 pass (1 pre-existing env-specific failure in state.test.mjs)
- `npm run build`: clean
- All `--worktree` references removed from docs, commands, agents, skills, and runtime
- Auth guidance now correctly points to `gemini auth` without `!` prefix
- `getGeminiAvailability` now probes ACP capability before declaring available
- Gate message no longer suggests wrong env var for non-API-key auth modes
