---
name: gemini-3-prompting
description: Internal guidance for composing Gemini 3 prompts for coding, review, diagnosis, and research tasks inside the Gemini Claude Code plugin
user-invocable: false
---

# Gemini 3 Prompting

Use this skill when `gemini:gemini-rescue` needs to ask Gemini for help.

Prompt Gemini like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- Prefer one clear task per Gemini run. Split unrelated asks into separate runs.
- Tell Gemini what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning or adding long natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure. Gemini 3 responds well to explicit `<thinking>` tags and to JSON schemas given inline — use both when the output shape matters.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Gemini should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or adversarial review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Gemini stays narrow and avoids unrelated refactors.

How to choose prompt shape:
- Gemini has no built-in review mode, so all review jobs go through `review` or `adversarial-review` subcommands that already carry the review contract.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Use `task --resume-last` for follow-up instructions on the same Gemini thread. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

Use Gemini's built-in subagents when the task benefits from dedicated exploration:
- `codebase_investigator` (ships with the `codebase-investigation` skill) — invoke it inside a prompt when Gemini needs to map call sites, trace invariants, or summarize a subsystem before answering. It is configured to use `gemini-3.1-pro-preview`. Mention it by name in the prompt body (e.g., "use the codebase_investigator subagent to map X before finalizing the fix") when you want Gemini to reach for it instead of guessing from a shallow read.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names that match the block names from the reference file.
- Do not raise reasoning or complexity first. Tighten the prompt and verification rules before escalating.
- Ask Gemini for brief, outcome-based progress updates only when the task is long-running or tool-heavy.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether Gemini should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.

Reusable blocks live in [references/gemini-prompt-blocks.md](references/gemini-prompt-blocks.md).
Concrete end-to-end templates live in [references/gemini-prompt-recipes.md](references/gemini-prompt-recipes.md).
Common failure modes to avoid live in [references/gemini-prompt-antipatterns.md](references/gemini-prompt-antipatterns.md).
