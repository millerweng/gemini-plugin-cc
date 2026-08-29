import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildLensDirective } from "../plugins/gemini/scripts/lib/review-lenses.mjs";
import { interpolateTemplate } from "../plugins/gemini/scripts/lib/prompts.mjs";

const PROMPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "gemini",
  "prompts"
);

// An adversarial review read the diff for this placeholder as deleting the blank line
// between </review_method> and <finding_bar>, and recommended making buildLensDirective
// return "\n" to put it back. Doing that would add a third newline, not restore a
// missing one: the placeholder's own line already carries it. These assertions pin the
// spacing so the "fix" fails loudly instead of quietly changing every single-pass prompt.
for (const name of ["review", "adversarial-review"]) {
  test(`${name}: an empty lens directive leaves exactly one blank line`, () => {
    const template = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
    const rendered = interpolateTemplate(template, {
      LENS_DIRECTIVE: buildLensDirective(null),
      REVIEW_COLLECTION_GUIDANCE: "",
      TARGET_LABEL: "",
      USER_FOCUS: "",
      REVIEW_INPUT: "",
      OUTPUT_SCHEMA: "",
      REVIEW_KIND: ""
    });

    assert.ok(
      rendered.includes("</review_method>\n\n<finding_bar>"),
      "single-pass prompt must keep exactly one blank line before <finding_bar>"
    );
    assert.ok(!rendered.includes("</review_method>\n\n\n<finding_bar>"), "no extra blank line");
    assert.ok(!rendered.includes("{{LENS_DIRECTIVE}}"), "placeholder must be consumed");
  });

  test(`${name}: a lens directive is fenced by blank lines`, () => {
    const template = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
    const rendered = interpolateTemplate(template, {
      LENS_DIRECTIVE: buildLensDirective({ id: "security", label: "Security", directive: "Focus." }),
      REVIEW_COLLECTION_GUIDANCE: "",
      TARGET_LABEL: "",
      USER_FOCUS: "",
      REVIEW_INPUT: "",
      OUTPUT_SCHEMA: "",
      REVIEW_KIND: ""
    });

    assert.ok(rendered.includes("</review_method>\n\n<lens_focus>"));
    assert.ok(rendered.includes("</lens_focus>\n\n<finding_bar>"));
  });
}
