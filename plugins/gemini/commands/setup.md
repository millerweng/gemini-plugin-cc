---
description: Check whether the local Gemini CLI is ready, walk through every setting with --init, toggle the stop-time review gate, set the default review base, raise the diff budget, skip directories, or make reviews always list the files they covered
argument-hint: '[--init] [--verify] [--enable-review-gate|--disable-review-gate] [--set-review-base <ref>|--clear-review-base] [--enable-show-files|--disable-show-files] [--set-max-diff-bytes <size>|--clear-max-diff-bytes] [--set-exclude <paths>|--clear-exclude]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

If the result says Gemini is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Gemini CLI now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Gemini CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @google/gemini-cli@0.38.2
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

If Gemini is already installed or npm is unavailable:
- Do not ask about installation.

Guided setup (`--init`):

- `--init` makes the command publish an `initPrompts` list instead of asking anything itself — it runs as a non-interactive child process and has no prompt to show. Each entry carries `header`, `question`, `current`, and `options`, and each option carries the `apply` flag that writes that answer.
- Ask every entry in one `AskUserQuestion` call, one question per entry, in the order the list gives them. Use each entry's `header` and `question` verbatim, and each option's `label` and `description`.
- Put the option matching `current` first and suffix its label with `(Recommended)`, so re-running `--init` defaults to keeping what is already set.
- The review base entry carries a `freeText` note. The user can answer with any git ref through the "Other" choice; turn that answer into `--set-review-base <ref>`.
- Then apply every answer in one run, collecting the `apply` flags of the chosen options. Skip options whose `apply` is `null` — those mean "leave it alone":

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup <collected flags>
```

- Present that second run's output, which names each setting's new value under `Actions taken:`.
- `--init` is re-runnable and every answer overwrites what was there. Say so if the user asks whether it is safe to run again.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Gemini is installed but not authenticated, preserve the guidance to configure auth in `~/.gemini/settings.json` or run `gemini auth` in a terminal outside Claude Code. Do not suggest running auth commands via Claude's `!` prefix — the auth flow is interactive and requires a browser.
