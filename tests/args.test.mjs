import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../plugins/gemini/scripts/lib/args.mjs";

test("unknown options land in positionals by default", () => {
  const { options, positionals } = parseArgs(["--focus", "auth", "--made-up"], {
    valueOptions: ["focus"]
  });

  assert.equal(options.focus, "auth");
  assert.deepEqual(positionals, ["--made-up"]);
});

// Regression: `setup --set-review-base <ref>` on a build without that flag reported
// success and did nothing. A command with no free-text arguments must reject it.
test("rejectUnknownOptions turns an unrecognised long flag into an error", () => {
  assert.throws(
    () =>
      parseArgs(["--set-review-base", "origin/main"], {
        booleanOptions: ["json", "verify"],
        valueOptions: ["cwd"],
        rejectUnknownOptions: true
      }),
    /Unknown option --set-review-base/
  );
});

test("the error names what the command does accept", () => {
  assert.throws(
    () => parseArgs(["--nope"], { booleanOptions: ["json"], valueOptions: ["cwd"], rejectUnknownOptions: true }),
    /accepts: --cwd, --json/
  );
});

test("rejectUnknownOptions also catches short flags", () => {
  assert.throws(
    () => parseArgs(["-z"], { booleanOptions: ["json"], rejectUnknownOptions: true }),
    /Unknown option -z/
  );
});

test("known options and real positionals still pass under rejectUnknownOptions", () => {
  const { options, positionals } = parseArgs(["--json", "--cwd", "/tmp/x", "job-1"], {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
    rejectUnknownOptions: true
  });

  assert.equal(options.json, true);
  assert.equal(options.cwd, "/tmp/x");
  assert.deepEqual(positionals, ["job-1"]);
});

test("everything after -- stays positional even under rejectUnknownOptions", () => {
  const { positionals } = parseArgs(["--json", "--", "--not-a-flag"], {
    booleanOptions: ["json"],
    rejectUnknownOptions: true
  });

  assert.deepEqual(positionals, ["--not-a-flag"]);
});

test("an optional-value flag works bare without eating the next token", () => {
  const { options, positionals } = parseArgs(["--multi", "focus", "text"], {
    optionalValueOptions: ["multi"]
  });
  assert.equal(options.multi, true);
  assert.deepEqual(positionals, ["focus", "text"]);
});

test("an optional-value flag keeps its inline value instead of coercing to true", () => {
  const { options } = parseArgs(["--multi=security,correctness"], {
    optionalValueOptions: ["multi"]
  });
  assert.equal(options.multi, "security,correctness");
});

test("an optional-value flag can be switched off inline", () => {
  const { options } = parseArgs(["--multi=false"], { optionalValueOptions: ["multi"] });
  assert.equal(options.multi, false);
});

test("an optional-value flag is listed in the unknown-option hint", () => {
  assert.throws(
    () => parseArgs(["--nope"], { optionalValueOptions: ["multi"], rejectUnknownOptions: true }),
    /--multi/
  );
});

test("an optional-value flag coerces the string \"true\" like it coerces \"false\"", () => {
  const { options } = parseArgs(["--multi=true"], { optionalValueOptions: ["multi"] });
  assert.equal(options.multi, true);
});

// A Claude Code session resolves the plugin once at startup, so a session that began
// before an upgrade keeps running the old copy. A flag added in the new one then comes
// back as "unknown option", which reads like a broken flag rather than a stale session.
test("the unknown-option error names the build it is running", () => {
  assert.throws(
    () =>
      parseArgs(["--set-max-diff-bytes", "1m"], {
        booleanOptions: ["json"],
        rejectUnknownOptions: true,
        buildLabel: "gemini-companion 1.8.1"
      }),
    /Running gemini-companion 1\.8\.1\..*restart the session/s
  );
});

test("the unknown-option error stays clean without a build label", () => {
  assert.throws(
    () => parseArgs(["--nope"], { booleanOptions: ["json"], rejectUnknownOptions: true }),
    (error) => {
      assert.match(error.message, /Unknown option --nope/);
      assert.doesNotMatch(error.message, /Running|restart the session/);
      return true;
    }
  );
});
