# Contributing to gemini-plugin-cc

Thank you for your interest in contributing! This guide covers the process for reporting issues, suggesting features, and submitting pull requests.

## Getting Started

### Prerequisites

- Node.js 18.18 or later
- Gemini CLI (`npm install -g @google/gemini-cli@0.38.2`)
- A Google account with Gemini CLI access (for end-to-end testing)

### Dev Setup

```bash
git clone https://github.com/m-ghalib/gemini-plugin-cc.git
cd gemini-plugin-cc
npm install
npm test
npm run build
```

### Running Tests

```bash
npm test                              # full suite
node --test tests/runtime.test.mjs    # single file
```

Tests use Node's built-in test runner. No external test framework required.

### Project Structure

```
plugins/gemini/
  commands/         # Slash command definitions (.md frontmatter)
  agents/           # Subagent definitions
  hooks/            # Stop and SessionEnd hooks
  scripts/          # Runtime JS (companion, lib/, prompts)
  scripts/lib/      # Core modules (ACP client, state, git, job control)
  schemas/          # JSON schemas for structured output
  skills/           # Skill definitions
tests/              # Test suite
.github/workflows/  # CI configuration
```

## Reporting Issues

- Use the [bug report template](https://github.com/m-ghalib/gemini-plugin-cc/issues/new?template=bug_report.yml) for bugs
- Use the [feature request template](https://github.com/m-ghalib/gemini-plugin-cc/issues/new?template=feature_request.yml) for ideas
- Check existing issues before opening a duplicate
- Include your Gemini CLI version (`gemini --version`) and Node.js version

## Pull Requests

### Before You Start

- Open an issue first for non-trivial changes to discuss the approach
- For small fixes (typos, doc corrections), a PR without an issue is fine

### PR Process

1. Fork the repository and create a branch from `main`
2. Make your changes — follow existing code patterns and conventions
3. Add or update tests for any changed behavior
4. Run `npm test` and `npm run build` — both must pass
5. Write a clear commit message explaining *why*, not just *what*
6. Open a PR against `main` using the PR template

### Code Conventions

- ESM modules (`.mjs` extension) with `node:` protocol for built-in imports
- No external runtime dependencies — the plugin ships zero `node_modules`
- Functions over classes where possible; the codebase is primarily functional
- No comments unless the *why* is non-obvious
- Keep changes minimal — touch only what's necessary for the fix or feature

### What We Look For in Review

- Does it work? Tests pass, build passes, manual verification for runtime changes
- Does it follow existing patterns? Consistency matters more than novelty
- Is it minimal? No unrelated refactoring bundled with the change
- Is it safe? No credential exposure, no unbounded resource usage

## Attribution

This project is derived from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache 2.0). If your contribution includes code from other sources, note it in the PR and ensure license compatibility.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
