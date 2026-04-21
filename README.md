# Gemini plugin for Claude Code

Use Gemini from inside Claude Code for code reviews or to delegate tasks to Gemini.

This plugin lets you delegate tasks, reviews, and adversarial reviews to [Google's Gemini CLI](https://github.com/google-gemini/gemini-cli) (`@google/gemini-cli@0.38.2`) without leaving your Claude Code session. It wraps the Gemini CLI via the Agent-Client Protocol (ACP) -- JSON-RPC 2.0 over stdio -- so Claude and Gemini can work side by side on the same codebase.

---

## What You Get

Six slash commands and a proactive subagent:

| Command | Purpose |
|---|---|
| `/gemini:review` | Code review with structured findings |
| `/gemini:adversarial-review` | Steerable adversarial review that challenges design choices |
| `/gemini:rescue` | Delegate investigation, fix, diagnosis, research, or any substantial task to Gemini |
| `/gemini:status` | Check active and recent Gemini jobs |
| `/gemini:result` | View the stored output of a finished job |
| `/gemini:cancel` | Cancel an active background job |
| `/gemini:setup` | Verify readiness, check auth, toggle review gate |

**`gemini-rescue` subagent** -- Claude Code can proactively delegate substantial tasks to Gemini through this subagent. It handles debugging, implementation, research, writing, analysis, brainstorming, explanation, or a second diagnosis pass as a thin forwarding wrapper around the Gemini companion runtime.

---

## Requirements

- **Google account with Gemini CLI access**, or a Gemini API key, or Vertex AI credentials
- **Node.js 18.18 or later**
- **Gemini CLI** (`@google/gemini-cli@0.38.2`) -- the setup command can install it for you

---

## Install

```bash
/plugin marketplace add m-ghalib/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/gemini:setup
```

The `/gemini:setup` command checks whether the Gemini CLI is installed and authenticated. If the CLI is missing and npm is available, it offers to install it for you via `npm install -g @google/gemini-cli@0.38.2`.

---

## Usage

### `/gemini:review`

Reads your working-tree diff or branch diff and asks Gemini to review it. Returns structured findings covering correctness, regression risk, and code quality. **Review-only -- never modifies code.**

**Flags:** `--base <ref>` (explicit base branch), `--scope auto|working-tree|branch`, `--wait` (foreground), `--background` (detach).

If neither `--wait` nor `--background` is specified, Claude estimates the review size and recommends an execution mode.

```bash
/gemini:review
/gemini:review --base main
/gemini:review --scope branch --background
```

---

### `/gemini:adversarial-review`

Same target selection as `/gemini:review`, but challenges the chosen implementation, design choices, tradeoffs, and assumptions. Not just a stricter pass over defects -- it asks whether the current approach is the right one and where the design could fail under real-world conditions.

**Steerable:** accepts focus text after flags to direct the review toward specific concerns.

**Flags:** same as `/gemini:review`.

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge the error handling strategy
/gemini:adversarial-review challenge whether this retry logic handles all failure modes
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

If the Gemini CLI is not installed and npm is available, offers to install it via `npm install -g @google/gemini-cli`.

**Flags:**

| Flag | Description |
|---|---|
| `--verify` | Confirm credentials work end-to-end via ACP handshake (requires Gemini CLI) |
| `--enable-review-gate` | Enable the stop-time review gate (Gemini reviews Claude's work before stopping) |
| `--disable-review-gate` | Disable the stop-time review gate |

The review gate is a `Stop` hook that blocks Claude from finishing until Gemini has reviewed the work. When the gate cannot reach Gemini (auth failure, network issue), it blocks and surfaces actionable guidance rather than silently allowing the stop. Disable with `--disable-review-gate` if the block is not resolvable in the current session.

**Limitation:** The gate receives Claude's last response text and the current repository state, not a per-turn diff. In multi-turn sessions with a dirty working tree, Gemini uses the response text to attribute changes to the most recent turn, but cannot perfectly distinguish this turn's edits from earlier ones.

**Examples:**

```bash
/gemini:setup
/gemini:setup --enable-review-gate
/gemini:setup --disable-review-gate
```

---

## Typical Flows

**Quick code review:**

```bash
/gemini:review
```

**Deep adversarial review of a feature branch:**

```bash
/gemini:adversarial-review --base main challenge whether this retry logic handles all failure modes
```

**Delegate a complex investigation:**

```bash
/gemini:rescue --background investigate the N+1 query problem in the user dashboard
/gemini:status --wait
/gemini:result
```

**Continue a prior Gemini thread:**

```bash
/gemini:rescue --resume apply the top fix from your investigation
```

**General-purpose delegation via rescue:**

```bash
/gemini:rescue research the best rate limiting libraries for Node.js and recommend one
```

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
Yes. Both plugins use separate namespaces (`/gemini:*` and `/codex:*`) and independent runtimes. They do not interfere with each other.

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
