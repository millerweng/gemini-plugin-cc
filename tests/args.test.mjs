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
