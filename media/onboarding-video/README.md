# gemini-plugin-cc onboarding GIF

This durable Remotion media project renders a terminal-first looping GIF for
the fastest Gemini plugin onboarding path:

```text
Claude Code TUI -> /plugin marketplace add -> /plugin install -> /reload-plugins -> /gemini:setup --verify -> /gemini:review --wait -> concise findings/status
```

It does not affect the plugin runtime, command behavior, auth contracts, or
published marketplace metadata.

## Concept

The GIF shows one deterministic Claude Code terminal workflow:

1. Add the plugin marketplace: `/plugin marketplace add m-ghalib/gemini-plugin-cc`.
2. Install the plugin: `/plugin install gemini@gemini-plugin-cc`.
3. Reload plugins.
4. Verify the pinned Gemini CLI and auth path through `/gemini:setup --verify`.
5. Run a foreground review with `/gemini:review --wait`.
6. Show compact review findings and saved-result status.

The composition uses generated terminal UI instead of live screenshots, so no
local account details, branch names, or credentials appear in the README asset.

## Commands

Install dependencies:

```bash
bun install
```

Preview in Remotion Studio:

```bash
bun run preview
```

Typecheck:

```bash
bun run check
```

Render verification stills:

```bash
bun run still:start
bun run still:setup
bun run still:review
```

Render review video:

```bash
bun run render
```

Render looping GIF:

```bash
bun run render:gif
```
