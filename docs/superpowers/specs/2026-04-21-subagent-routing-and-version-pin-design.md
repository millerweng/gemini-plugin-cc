# Fix: Subagent Routing Regression, Delegate Removal, and Version Pin

**Date:** 2026-04-21
**Status:** Implemented

---

## Problem Statement

Three findings from code audit:

1. **Subagent routing regression (High):** `/gemini:rescue` used `context: fork` and prose-based subagent routing. This reintroduced the exact recursion bug that `codex-plugin-cc` patched and regression-tested (issue #234). Forked contexts don't expose the `Agent` tool, so the routing instruction either recurses into the command or fails silently.

2. **Delegate command under-modeled (High):** `/gemini:delegate` was added without a `jobSubtype` field, sharing the same resume pool and status labels as `/gemini:rescue`. Since the codex baseline only has one task verb and the subagent already handles general-purpose delegation proactively, the separate command added surface area without proper state modeling.

3. **Version pinning gap (Medium):** CI pinned `@google/gemini-cli@0.39.0-preview.0` while user-facing install instructions referenced unpinned `@google/gemini-cli`. Users could install incompatible versions.

---

## Decisions

### Finding 1: Match codex baseline routing

- Removed `context: fork` from `rescue.md`.
- Added `Agent` to `allowed-tools`.
- Command now routes via explicit `Agent` tool with `subagent_type: "gemini:gemini-rescue"`.
- Added anti-recursion guard: "do not call `Skill(gemini:rescue)` (re-enters this command and hangs the session)".
- Added regression test asserting `context: fork` is NOT present and `subagent_type` IS present.

### Finding 2: Remove /gemini:delegate

- Deleted `plugins/gemini/commands/delegate.md`.
- `/gemini:rescue` handles all task types (code and general-purpose).
- The `gemini-rescue` subagent's proactive description already covers general-purpose delegation.
- No `jobSubtype` modeling needed since there's now only one task command.

### Finding 3: Pin to stable 0.38.2

- Verified all required ACP methods (`initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`) exist in 0.38.2.
- Updated CI, README, setup command, error messages, and type declaration comment to reference `@google/gemini-cli@0.38.2`.
- The `latest` npm dist-tag points to 0.38.2, so users who ignore the version specifier still get a compatible build.

---

## Files Changed

| File | Change |
|---|---|
| `plugins/gemini/commands/rescue.md` | Removed `context: fork`, added `Agent` tool, explicit routing, anti-recursion guard |
| `plugins/gemini/commands/delegate.md` | Deleted |
| `plugins/gemini/agents/gemini-rescue.md` | Removed `/gemini:delegate` reference from description |
| `tests/commands.test.mjs` | Removed delegate test, updated command list, added routing regression test |
| `.github/workflows/pull-request-ci.yml` | Pin `0.38.2` |
| `plugins/gemini/scripts/lib/acp-protocol.d.ts` | Version comment updated |
| `plugins/gemini/commands/setup.md` | Install pinned version |
| `plugins/gemini/scripts/gemini-companion.mjs` | Install suggestion pinned |
| `plugins/gemini/scripts/lib/gemini.mjs` | Install suggestion pinned |
| `plugins/gemini/skills/gemini-result-handling/SKILL.md` | delegate -> rescue reference |
| `plugins/gemini/CHANGELOG.md` | Document consolidation |
| `README.md` | Remove delegate section, pin version, update command table |

---

## Verification

- `npm test`: 54/55 pass (1 pre-existing env-specific failure in state.test.mjs)
- `npm run build`: clean
- Regression test confirms `context: fork` absence and `Agent` tool presence
- All ACP session methods confirmed present in gemini-cli 0.38.2 via tarball inspection
