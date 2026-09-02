# Gemini plugin for Claude Code

English | [简体中文](README.zh-CN.md)

![Gemini plugin onboarding terminal loop](docs/assets/gemini-plugin-cc-onboarding.gif)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-npm-green.svg)](tests/)

Run [Google's Gemini CLI](https://github.com/google-gemini/gemini-cli) from inside Claude Code:
code review, adversarial review, and delegated investigation or fix work, all against the
repository you are already in. The plugin talks to `gemini --acp` over JSON-RPC, so Claude and
Gemini work side by side on the same checkout.

Review commands never edit code. `/gemini:rescue` can write to the worktree by default.

## Install

Run inside a Claude Code session:

```text
/plugin marketplace add millerweng/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/reload-plugins
/gemini:setup --verify
```

You need Node.js 18.18+ and Gemini CLI access (OAuth, API key, Vertex AI, or a gateway).
`/gemini:setup` checks both, and offers to install the pinned CLI
(`npm install -g @google/gemini-cli@0.38.2`) if it is missing.

Update with `claude plugin marketplace update gemini-plugin-cc` then `claude plugin update gemini`,
and restart the session. Updates are compared by version number, so if an update reports nothing
to do, check that the marketplace advertises a higher version than
`~/.claude/plugins/installed_plugins.json` records.

## Commands

| Command | Purpose |
|---|---|
| `/gemini:review` | Review the current diff, structured findings |
| `/gemini:adversarial-review` | Challenge the approach, design, and assumptions |
| `/gemini:rescue` | Delegate investigation, diagnosis, or a fix |
| `/gemini:transfer` | Carry this session into a resumable Gemini session |
| `/gemini:setup` | Check readiness, or configure everything with `--init` |
| `/gemini:status` | Active and recent jobs, and whether each running one is still alive |
| `/gemini:result` | Stored output of a finished job |
| `/gemini:cancel` | Cancel an active background job |

Saying "gemini review" or "adversarial review" in plain text starts the matching review. Every
other command needs the slash form. Claude never starts a review on its own — one costs quota
and minutes.

```text
/gemini:review --wait
/gemini:adversarial-review --base main challenge the retry logic
/gemini:rescue --background investigate the N+1 query in the dashboard
/gemini:status --wait
/gemini:result
```

## Reviews

Both review commands take the same flags and accept focus text after them.

| Flag | Description |
|---|---|
| `--base <ref>` | Review the branch diff against this ref, even if the tree is dirty |
| `--scope auto\|working-tree\|branch` | Force what gets reviewed; `auto` is the default |
| `--cwd <path>` | Review a different checkout, such as a worktree you are not in |
| `--multi[=<lens,...>]` | Run three narrow passes instead of one and merge the findings |
| `--model <alias>` | Pick a model (see the aliases below) |
| `--show-reasoning` | Include Gemini's reasoning trace |
| `--show-files` | List the files the review actually covered, and any it did not |
| `--max-diff-bytes <size>` | Raise the truncation budget for this run (`512kb`, `1mb`, or raw bytes) |
| `--progress` | Stream progress lines even when output is captured |
| `--wait` / `--background` | Foreground, or detach |

Without `--wait` or `--background`, Claude sizes the review and recommends one.

**What gets reviewed**, highest precedence first:

1. `--scope working-tree` or `--scope branch`
2. `--base <ref>`
3. Uncommitted changes, when the tree is dirty
4. A branch diff against the pinned base (`--set-review-base`)
5. A branch diff against the auto-detected default branch

An auto-detected base spanning more than 40 files is flagged, since that usually means the
range is much wider than the change you meant to review.

A diff over the budget is sent in part, and the report names the budget it hit.
`--show-files` turns that warning into two explicit lists — what the review covered, and
what it never saw. The budget is 256 KB by default; raise it per run with
`--max-diff-bytes 512kb`, or for the workspace with
`/gemini:setup --set-max-diff-bytes 512kb`.

### Multi-lens review

A single pass has to weigh every concern at once, and the prompt's own calibration rules then
push Gemini to report its top finding and drop the rest. `--multi` runs the same diff through
three narrower passes:

| Lens | Looks for |
|---|---|
| `correctness` | Logic errors, boundaries, unhandled error paths, broken invariants |
| `security` | Auth gaps, isolation failures, injection, secret exposure |
| `resilience` | Races, idempotency, partial failure, rollback and migration hazards |

Findings from two different lenses merge when they land within five lines of each other and
describe the issue in similar terms. A merged finding is marked `confirmed by 2 lenses` and
sorted first — that agreement is the point. Merging is lossless: the wording it does not
promote stays under `Also reported as`.

A lens that fails is dropped with a warning, the passes that worked are still reported, and the
command exits non-zero so a partial review is not mistaken for a clean one.

The passes run one after another, so budget three times a single review and prefer
`--background`. Narrow them with `--multi=security,resilience`.

## Rescue

`/gemini:rescue` delegates investigation, diagnosis, or a fix to the `gemini-rescue` subagent.
It defaults to Gemini CLI's write-capable `--yolo --sandbox` mode, scoped to the worktree.

| Flag | Description |
|---|---|
| `--plan` | Read-only planning run — Gemini proposes but does not execute |
| `--background` / `--wait` | Detach, or block until done (foreground is the default) |
| `--resume` / `--fresh` | Continue the last Gemini thread in this repo, or start a new one |
| `--model <alias>` | Choose a model |
| `--effort low\|medium\|high` | Thinking level (accepted; pending upstream ACP support) |

| Alias | Model |
|---|---|
| `pro`, `pro-3` | `gemini-3.1-pro-preview` |
| `flash` | `gemini-3-flash-preview` |
| `flash-lite` | `gemini-3.1-flash-lite-preview` |
| `2.5-pro`, `2.5-flash`, `2.5-flash-lite` | the matching Gemini 2.5 model |
| `auto`, `auto-2.5` | `auto-gemini-3`, `auto-gemini-2.5` |

Concrete model IDs work too. Commit or stash before a rescue run that may write.

```bash
/gemini:rescue --plan trace the data flow from API to database for the orders endpoint
/gemini:rescue --model flash diagnose the memory leak in the worker pool
```

## Review gate

`/gemini:setup --enable-review-gate` installs a `Stop` hook that has Gemini review the work
before Claude finishes. If the gate cannot reach Gemini it blocks and says what to fix rather
than passing silently. Turn it off with `--disable-review-gate`.

The gate sees Claude's last response and the current repository state, not a per-turn diff. In a
long session with a dirty tree it cannot perfectly separate this turn's edits from earlier ones.

## Configuration

**Walk through everything once.** `--init` asks about each setting in turn and writes your
answers. Re-run it any time — every answer overwrites what was there, and the option you
already have is offered first:

```bash
/gemini:setup --init
```


**Pin a review base.** Auto-detection follows `origin/HEAD`. If your work merges into a
long-lived integration branch, that merge-base sits far behind and every review silently covers
everything since:

```bash
/gemini:setup --set-review-base origin/internal-release   # --clear-review-base to undo
```

The ref is resolved when you set it, so a typo fails immediately. Each git worktree is its own
workspace, and a worktree with no base of its own inherits the main checkout's. A pinned base
only supplies the ref for a branch review — uncommitted changes still take precedence.

**Always list covered files.** Turn `--show-files` on for every review in this workspace,
so a truncated run names what it missed without you remembering the flag:

```bash
/gemini:setup --enable-show-files   # --disable-show-files to undo
```

`--show-files` still turns it on for a single run, and `--hide-files` silences one run in a
workspace where the setting is on. Worktrees inherit the setting the same way the review
base does, and a worktree that turns it off stays off.

**Raise the diff budget.** Past 256 KB a review sends a partial diff. Raise the ceiling
when your changes routinely run larger:

```bash
/gemini:setup --set-max-diff-bytes 512kb   # --clear-max-diff-bytes to undo
```

Sizes take a suffix (`512kb`, `1mb`) or raw bytes, and an unusable value is rejected when
you set it rather than ignored later. Raise it a step at a time: a much larger prompt can
spend the whole turn on reasoning and return nothing, which is worse than a truncated
review that says it was truncated.

**Settings location.** Setup reports the file it wrote to. Settings live under
`CLAUDE_PLUGIN_DATA`, which Claude Code sets and a plain shell does not, so running the
companion script by hand writes to a temp fallback the plugin never reads back.

**Task timeout.** 30 minutes by default: `export GEMINI_TASK_TIMEOUT_MS=3600000`.

**Auth.** Configured in `~/.gemini/settings.json`, by `selectedType`: `oauth-personal` (run
`gemini` once interactively), `gemini-api-key` or `google-api-key` (plus the matching env var),
`vertex-ai` (plus `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`), or `gateway`.

## How it runs

The plugin starts a shared ACP broker so several commands reuse one Gemini process for the life
of the Claude Code session, falling back to a direct Gemini CLI process when the broker is busy
or unavailable. Job state lives outside the working tree, which is what `--resume` reads (the
last 20 sessions are kept).

`/gemini:transfer` writes the current Claude Code session as a native Gemini JSONL chat under
`~/.gemini/tmp/<project>/chats/`, so `gemini --list-sessions` and `--resume` find it. Harness
markup is stripped and tool calls collapse to one line each; `--include-tool-output` keeps the
results.

Running alongside the Codex plugin is fine — separate namespaces, separate runtimes.

## Fork and attribution

This is a fork of [m-ghalib/gemini-plugin-cc](https://github.com/m-ghalib/gemini-plugin-cc),
which is itself derived from OpenAI's
[Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc). Broker lifecycle,
state, job control, rendering, and arg parsing come from that codebase; see
[NOTICE](NOTICE) for full attribution.

What this fork changed — OAuth readiness, review targeting, multi-lens review, `/gemini:transfer`,
pinned review bases — is in the [CHANGELOG](plugins/gemini/CHANGELOG.md). All credit for the
plugin itself goes upstream.

Apache-2.0. See [LICENSE](LICENSE).
