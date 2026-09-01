# Gemini plugin for Claude Code

![Gemini plugin onboarding terminal loop](docs/assets/gemini-plugin-cc-onboarding.gif)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-blue.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-npm-green.svg)](tests/)

> **Fork notice.** This is a fork of [m-ghalib/gemini-plugin-cc](https://github.com/m-ghalib/gemini-plugin-cc),
> currently at 1.2.1 against upstream 1.0.0. Full detail in
> [CHANGELOG](plugins/gemini/CHANGELOG.md); the short version:
>
> **Reviews that looked fine but were not**
>
> - A review could return `approve` without ever seeing the diff. `maxInlineFiles` was
>   2, so any change touching three files skipped the inline diff no matter how small —
>   a 365-byte three-file diff qualified. Gemini was then told to fetch the diff itself
>   with git, which an ACP session cannot do, and it inferred a verdict from diffstat
>   line counts. The byte budget now decides, and when a diff genuinely does not fit,
>   the prompt forbids `approve` without evidence.
> - A response missing an optional field was thrown away and printed as raw JSON.
>   Showing a model a schema does not make it follow one, so the renderer fills in what
>   is missing and says which fields it filled. A missing severity reads `unrated`
>   rather than defaulting to `low`.
> - A configured review base hid every uncommitted change: a worktree with 15 modified
>   files reviewed nothing and still reported a verdict.
>
> **Authentication**
>
> - OAuth users were told they were logged out. Upstream probes for
>   `~/.gemini/gemini-credentials.json`, a filename Gemini CLI does not write, and
>   `setup --verify` refused to connect until that probe passed. The probe now looks for
>   `oauth_creds.json`, and a successful ACP handshake outranks whatever is on disk.
>
> **New**
>
> - `/gemini:transfer` carries the current Claude Code session into a resumable Gemini
>   session.
> - `/gemini:setup --set-review-base <ref>` pins the base a repository reviews against,
>   inherited by its worktrees. Auto-detection follows `origin/HEAD`, which is wrong for
>   repositories that merge into a long-lived integration branch.
> - Progress lines stay out of captured output, and the reasoning trace is opt-in via
>   `--show-reasoning`.
> - Commands with no free-text arguments reject unrecognised flags instead of silently
>   ignoring them.
>
> **Carried from upstream, not yet released there**
>
> - `/gemini:review` no longer fails with `Missing array next_steps` (PR #5 by
>   [@petems](https://github.com/petems), fixes upstream #4).
> - The companion no longer resolves its state into the Codex plugin's data directory
>   and dials the wrong server (upstream #8, reported with a verified fix by
>   [@mplezier](https://github.com/mplezier)).
> - Git arguments no longer pass through a shell on Windows (codex-plugin-cc #447).
>
> All credit for the plugin itself goes upstream. Apache-2.0, same as the original.

## Installation

```text
/plugin marketplace add millerweng/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/reload-plugins
/gemini:setup --verify
```

The `/gemini:setup` command checks whether the Gemini CLI is installed and authenticated. If the CLI is missing and npm is available, it offers to install the pinned CLI with `npm install -g @google/gemini-cli@0.38.2`.

### Updating

```bash
claude plugin marketplace update gemini-plugin-cc
claude plugin update gemini
```

Restart the session afterwards. Nothing updates on its own, and restarting alone does not
pick up a new version.

`claude plugin update` compares versions, so a release that did not roll its version
number looks like no release at all. If an update reports nothing to do but you expect a
change, check that the marketplace advertises a higher version than
`~/.claude/plugins/installed_plugins.json` records.

## Prerequisites

- Claude Code installed and authenticated. Run the install commands above inside a Claude Code session.
- Node.js 18.18 or later on `PATH`.
- Gemini CLI access through Google OAuth, a Gemini API key, a Google API key, Vertex AI, or an AI gateway.
- Gemini CLI authentication configured in `~/.gemini/settings.json`, or completed interactively by running `gemini` in a terminal.

## What it does

gemini-plugin-cc gives Claude Code a local Gemini companion for code review,
adversarial review, and delegated task work. It wraps [Google's Gemini CLI](https://github.com/google-gemini/gemini-cli)
(`@google/gemini-cli@0.38.2`) through the Agent-Client Protocol (ACP), using
JSON-RPC 2.0 over stdio so Claude and Gemini can work side by side on the same
repository.

The plugin exposes seven slash commands plus the `gemini-rescue` subagent.
Review commands are read-only. Rescue defaults to Gemini CLI's write-capable
`--yolo --sandbox` mode, scoped to the repository worktree; use `--plan` for a
read-only planning run.

## Commands

| Command | Purpose |
|---|---|
| `/gemini:setup` | Verify Gemini CLI readiness, check auth, toggle the review gate, pin the review base |
| `/gemini:review` | Review code changes with structured findings |
| `/gemini:adversarial-review` | Challenge implementation choices, tradeoffs, and assumptions |
| `/gemini:rescue` | Delegate investigation, diagnosis, research, or fix work to Gemini |
| `/gemini:transfer` | Hand the current Claude Code session over to a resumable Gemini session |
| `/gemini:status` | Check active and recent Gemini jobs |
| `/gemini:result` | Show the stored output of a finished job |
| `/gemini:cancel` | Cancel an active background job |

## Quick Flows

**Verify the install:**

```text
/gemini:setup --verify
```

**Review current work:**

```text
/gemini:review --wait
```

**Challenge a feature branch:**

```text
/gemini:adversarial-review --base main challenge whether this retry logic handles all failure modes
```

**Delegate an investigation:**

```text
/gemini:rescue --background investigate the N+1 query problem in the user dashboard
/gemini:status --wait
/gemini:result
```

**Enable stop-time review:**

```text
/gemini:setup --enable-review-gate
```

## Detailed Reference

### `/gemini:review`

Say "gemini review" and Claude runs this for you — the two review commands are the only
ones it can start from a plain request. Every other command in this plugin needs the slash
form. Claude will not start a review you did not ask for; one costs Gemini quota and
minutes, and `--multi` multiplies both.

Reads your working-tree diff or branch diff and asks Gemini to review it. Returns structured findings covering correctness, regression risk, and code quality. **Review-only -- never modifies code.**

**Flags:**

| Flag | Description |
|---|---|
| `--base <ref>` | Review the branch diff against this ref, even if the tree is dirty |
| `--scope auto\|working-tree\|branch` | Force what gets reviewed; `auto` is the default |
| `--cwd <path>` | Review a different checkout, such as a worktree the session is not in |
| `--multi[=<lens,...>]` | Run several narrow passes instead of one and merge the findings |
| `--show-reasoning` | Include Gemini's reasoning trace in the output |
| `--progress` | Stream progress lines even when output is being captured |
| `--wait` / `--background` | Foreground, or detach |

If neither `--wait` nor `--background` is given, Claude estimates the review size and recommends one.

**What gets reviewed**, highest precedence first:

1. `--scope working-tree` or `--scope branch`
2. `--base <ref>` — a branch diff, regardless of uncommitted changes
3. Uncommitted changes, when the tree is dirty
4. A branch diff against the configured base (see `--set-review-base` below)
5. A branch diff against the auto-detected default branch

An auto-detected base spanning more than 40 files is flagged in the output, since that
usually means the intended change is much smaller than the range being reviewed.

**Multi-lens review (`--multi`)**

A single pass has to weigh every concern at once, and the prompt's own calibration rules
("prefer one strong finding over several weak ones") then push Gemini to report the issue
it rates highest and drop the rest. `--multi` runs the same diff through three narrower
passes instead:

| Lens | Looks for |
|---|---|
| `correctness` | Logic errors, boundaries, unhandled error paths, broken invariants |
| `security` | Auth and authorization gaps, isolation failures, injection, secret exposure |
| `resilience` | Races, idempotency, partial failure, rollback and migration hazards, data loss |

Findings merge when two different lenses land within five lines of each other **and**
describe the issue in similar terms. A merged finding is marked `confirmed by 2 lenses` and
sorted above single-lens findings of the same severity — that agreement is the signal
multi-lens review exists to produce. Two findings from the same lens never merge, and a
merge keeps the wording it did not promote under `Also reported as`, so nothing a lens said
is lost.

A lens that fails — unusable JSON, a rate limit, a dropped connection — is dropped with a
warning and the passes that worked are still reported.

Narrow the passes with an inline list: `--multi=security,resilience`.

The passes run one after another, not in parallel. The ACP broker serves one session at a
time, so parallel passes would each start a separate Gemini process and hit a rate limit
that much sooner. Budget roughly one single-review duration per lens, and prefer
`--background`.

Single-pass review is unchanged and remains the default.

```bash
/gemini:review
/gemini:review --base main
/gemini:review --scope branch --background
/gemini:review --cwd ~/repo/.worktrees/feature-x
/gemini:review --multi --background
/gemini:review --multi=security,resilience --base main --background
```

---

### `/gemini:adversarial-review`

Same target selection as `/gemini:review`, but challenges the chosen implementation, design choices, tradeoffs, and assumptions. Not just a stricter pass over defects -- it asks whether the current approach is the right one and where the design could fail under real-world conditions.

**Steerable:** accepts focus text after flags to direct the review toward specific concerns.

**Flags:** same as `/gemini:review`, including `--multi`.

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge the error handling strategy
/gemini:adversarial-review challenge whether this retry logic handles all failure modes
/gemini:adversarial-review --multi --background
```

---

### `/gemini:rescue`

Delegates code investigation, fixes, or diagnosis to Gemini. For exploratory or diagnostic tasks, the plugin suggests that Gemini use its built-in `codebase_investigator` subagent before drafting a fix.

**Flags:**

| Flag | Description |
|---|---|
| `--background` | Detach and run as a background job |
| `--wait` | Run in the foreground (block until complete) |
| `--resume` | Continue from the last Gemini thread in this repository |
| `--fresh` | Start a new Gemini thread (ignore any prior session) |
| `--model <alias>` | Choose a specific Gemini model (see model aliases below) |
| `--effort low\|medium\|high` | Set Gemini's thinking level (accepted; pending upstream ACP support) |
| `--plan` | Read-only planning run (Gemini proposes but does not execute) |

**Model aliases:**

| Alias | Resolves to |
|---|---|
| `pro` | `gemini-3.1-pro-preview` |
| `pro-3` | `gemini-3.1-pro-preview` |
| `flash` | `gemini-3-flash-preview` |
| `flash-lite` | `gemini-3.1-flash-lite-preview` |
| `2.5-pro` | `gemini-2.5-pro` |
| `2.5-flash` | `gemini-2.5-flash` |
| `2.5-flash-lite` | `gemini-2.5-flash-lite` |
| `auto` | `auto-gemini-3` |
| `auto-2.5` | `auto-gemini-2.5` |

Concrete model IDs are also accepted (e.g., `--model gemini-3-pro-preview`).

**Examples:**

```bash
/gemini:rescue investigate why the auth middleware returns 403 for valid tokens
/gemini:rescue --background fix the flaky test in user-service
/gemini:rescue --plan trace the data flow from API to database for the orders endpoint
/gemini:rescue --model flash --effort high diagnose the memory leak in the worker pool
```

---

### `/gemini:transfer`

Turns the current Claude Code session into a Gemini session and prints the command to resume it.

Use it when a debugging or implementation conversation started in Claude Code and you want to carry that context into Gemini directly.

```bash
/gemini:transfer
/gemini:transfer --source ~/.claude/projects/<project>/<session-id>.jsonl
/gemini:transfer --include-tool-output
```

The `SessionStart` hook supplies the transcript path automatically; `--source` is a manual override. The source must live under `~/.claude/projects`.

Claude-specific harness markup is stripped (slash-command echoes, injected reminders, task notifications), and tool calls collapse to a single summary line. Pass `--include-tool-output` to carry tool results over as well, truncated per result.

The session is written as a native Gemini JSONL chat under `~/.gemini/tmp/<project>/chats/`, so `gemini --list-sessions` and `--resume` pick it up too.

---

### `/gemini:status`

Shows active and recent Gemini jobs for the current repository.

**Flags:**

| Flag | Description |
|---|---|
| `--wait` | Poll until a job finishes; auto-resolves if one active job exists, otherwise pass a job ID |
| `--timeout-ms <n>` | Maximum time to poll (used with `--wait`) |
| `--all` | Include jobs from all sessions, not just the current one |

**Examples:**

```bash
/gemini:status
/gemini:status --wait
/gemini:status --all
```

---

### `/gemini:result`

Shows the stored output of a finished Gemini job. Preserves all details including the session ID (useful for `--resume` on follow-up commands).

Accepts an optional job ID. Defaults to the latest finished job.

**Examples:**

```bash
/gemini:result
/gemini:result abc123
```

---

### `/gemini:cancel`

Cancels an active background Gemini job by sending an ACP cancel request to the running session.

Accepts an optional job ID. Defaults to the latest active job.

**Examples:**

```bash
/gemini:cancel
/gemini:cancel abc123
```

---

### `/gemini:setup`

Checks Gemini CLI availability and authentication status. Reports the detected auth method (OAuth, API key, Vertex AI, gateway) and whether credentials are present locally. Use `--verify` to confirm credentials work end-to-end.

If the Gemini CLI is not installed and npm is available, offers to install it via `npm install -g @google/gemini-cli@0.38.2`.

**Flags:**

| Flag | Description |
|---|---|
| `--verify` | Confirm credentials work end-to-end via ACP handshake (requires Gemini CLI) |
| `--enable-review-gate` | Enable the stop-time review gate (Gemini reviews Claude's work before stopping) |
| `--disable-review-gate` | Disable the stop-time review gate |
| `--set-review-base <ref>` | Pin the base branch reviews compare against in this repository |
| `--clear-review-base` | Drop the pinned base and go back to auto-detection |

The report names the settings file it wrote to. Settings live under `CLAUDE_PLUGIN_DATA`,
which Claude Code sets and a plain shell does not — running the companion script by hand
writes to a temp fallback the plugin never reads back, so check that path if a setting
appears not to take effect.

The review gate is a `Stop` hook that blocks Claude from finishing until Gemini has reviewed the work. When the gate cannot reach Gemini (auth failure, network issue), it blocks and surfaces actionable guidance rather than silently allowing the stop. Disable with `--disable-review-gate` if the block is not resolvable in the current session.

**Limitation:** The gate receives Claude's last response text and the current repository state, not a per-turn diff. In multi-turn sessions with a dirty working tree, Gemini uses the response text to attribute changes to the most recent turn, but cannot perfectly distinguish this turn's edits from earlier ones.

**Examples:**

```bash
/gemini:setup
/gemini:setup --verify
/gemini:setup --enable-review-gate
/gemini:setup --set-review-base origin/internal-release
/gemini:setup --clear-review-base
```

#### Pinning a review base

Without a pinned base, reviews compare against whatever `origin/HEAD` points at, which
is the repository's default branch. For a repository whose work merges into a long-lived
integration branch, that merge-base sits far behind, and the review silently covers every
change since:

```bash
/gemini:setup --set-review-base origin/internal-release
```

The ref is resolved when you set it, so a typo fails immediately rather than inside a
later `merge-base` call.

Each git worktree is its own workspace, since `git rev-parse --show-toplevel` returns the
worktree's own path. A worktree with no base of its own inherits the main checkout's, so
pinning it once covers the worktrees created from it. Setting one on a worktree still
wins, and unrelated repositories inherit nothing.

A pinned base only supplies the ref for a branch review. It does not turn a dirty tree
into a branch diff — uncommitted changes still take precedence, and `--base` is how you
ask for a branch diff regardless.

---

## Gemini Integration

The plugin communicates with the Gemini CLI through the **Agent-Client Protocol (ACP)** -- a JSON-RPC 2.0-based protocol over stdio. The Gemini CLI is started with `gemini --acp`, which launches it in programmatic ACP mode rather than the interactive terminal UI. ACP supports session management, turn-based prompting, streaming updates, and session mode control.

### Authentication

Configure your auth method in `~/.gemini/settings.json`. Supported auth types:

| Auth type | Configuration |
|---|---|
| **Google OAuth** | Run `gemini` interactively to complete OAuth flow, or set `selectedType: "oauth-personal"` |
| **Gemini API key** | Set `selectedType: "gemini-api-key"` and `GEMINI_API_KEY` env var |
| **Google API key** | Set `selectedType: "google-api-key"` and `GOOGLE_API_KEY` env var |
| **Vertex AI** | Set `selectedType: "vertex-ai"`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION` |
| **AI Gateway** | Set `selectedType: "gateway"` |

### Shared ACP broker

The plugin starts a shared ACP broker session so multiple commands reuse a single Gemini process. The broker starts on the first command that needs it and runs for the duration of the Claude Code session. If the broker is busy or unavailable, the plugin falls back to a direct Gemini CLI process automatically.

### Execution modes

- **Default** (`--yolo --sandbox`) -- Gemini can read and write files within the repository worktree, scoped by Gemini CLI's built-in sandbox mode (filesystem access limited to the working tree).
- **Plan** (`--plan`) -- Read-only. Gemini proposes changes but does not execute them.

### Session persistence and timeouts

Task sessions are indexed in the plugin's state directory (outside the working tree), enabling the `--resume` flag to continue from a prior thread (up to 20 recent sessions are retained).

The default task turn timeout is 30 minutes. Override with `GEMINI_TASK_TIMEOUT_MS`:

```bash
export GEMINI_TASK_TIMEOUT_MS=3600000  # 60 minutes
```

---

## Attribution

> [!NOTE]
> This plugin is derived from and inspired by OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc), licensed under the Apache License 2.0. The broker lifecycle, state management, job control, rendering, and arg parsing modules are forked from that codebase with identifiers adapted for Google's Gemini CLI integration. See the [NOTICE](NOTICE) file for full attribution details.

---

## FAQ

**Do I need a separate Google account?**
You need Gemini CLI access. Configure your auth method in `~/.gemini/settings.json`. The setup command checks this for you.

**Does the plugin run a separate process?**
Yes. The plugin starts the Gemini CLI as a local process communicating via ACP (JSON-RPC 2.0 over stdio). A shared broker session keeps one Gemini process alive across multiple commands.

**What is ACP?**
The Agent-Client Protocol is a JSON-RPC 2.0-based protocol used by the Gemini CLI for programmatic interaction. It supports session management, turn-based prompting, streaming updates, and session mode control.

**Can I use this alongside the Codex plugin?**
Yes. Separate namespaces (`/gemini:*` and `/codex:*`) and independent runtimes.

Upstream 1.0.0 did interfere, which is upstream issue #8: `CLAUDE_PLUGIN_DATA` carries
whichever plugin's directory the surrounding shell holds, and the Codex plugin uses an
identical `state/<slug>-<hash>/broker.json` layout. Both plugins resolved to one state
file, this client loaded Codex's broker session and dialled the Codex app-server, and
every task died on `unknown variant 'session/new'`. This fork checks that the directory
belongs to Gemini, and treats a wrong-dialect broker reply as a dead broker.

**What happens if Gemini is not authenticated?**
The plugin detects this and tells you to run `/gemini:setup`. You can also run `gemini` interactively in a terminal to complete the OAuth flow.

**How does the review gate work?**
When enabled via `/gemini:setup --enable-review-gate`, a `Stop` hook fires every time Claude is about to finish. The hook triggers a Gemini review of Claude's changes, giving you an automatic second opinion. Disable it with `/gemini:setup --disable-review-gate`.

**Can I control which Gemini model is used?**
Yes. Pass `--model <alias>` to `/gemini:rescue`. See the model aliases table above. If no model is specified, Gemini uses its default.

> [!WARNING]
> The default `--yolo --sandbox` mode allows Gemini to modify files in your repository. Make sure your work is committed or stashed before running rescue commands that may write to the worktree.

---

## License

Apache License 2.0. See [LICENSE](LICENSE).
