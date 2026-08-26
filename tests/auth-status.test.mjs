import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/gemini/scripts/lib/gemini.mjs"
);

function runAuthProbe(env = {}, options = {}) {
  const tmpHome = makeTempDir("auth-test-");
  const binDir = path.join(tmpHome, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, "gemini"), '#!/bin/sh\necho "1.0.0"');

  const settingsDir = path.join(tmpHome, ".gemini");
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: env._AUTH_TYPE ?? "vertex-ai" } } })
  );

  for (const filename of options.credentialFiles ?? []) {
    fs.writeFileSync(path.join(settingsDir, filename), JSON.stringify({ access_token: "test" }));
  }

  const wrapper = [
    `import { getGeminiAuthStatus } from ${JSON.stringify(SCRIPT)};`,
    `const result = await getGeminiAuthStatus(process.cwd(), { env: process.env });`,
    `process.stdout.write(JSON.stringify({ loggedIn: result.loggedIn, authMethod: result.authMethod, detail: result.detail, credentialFile: result.credentialFile ?? null }));`
  ].join("\n");
  const wrapperFile = path.join(tmpHome, "probe.mjs");
  fs.writeFileSync(wrapperFile, wrapper);

  const childEnv = { ...env };
  delete childEnv._AUTH_TYPE;

  const { stdout, stderr } = spawnSync(process.execPath, [wrapperFile], {
    cwd: tmpHome,
    env: {
      ...childEnv,
      HOME: tmpHome,
      PATH: `${binDir}:${process.env.PATH}`,
      NODE_NO_WARNINGS: "1"
    },
    encoding: "utf8",
    timeout: 5000
  });

  if (!stdout) return {};
  return JSON.parse(stdout);
}

test("vertex-ai reports loggedIn when both project and location are set", () => {
  const result = runAuthProbe({
    _AUTH_TYPE: "vertex-ai",
    GOOGLE_CLOUD_PROJECT: "my-project",
    GOOGLE_CLOUD_LOCATION: "us-central1"
  });
  assert.equal(result.loggedIn, true);
  assert.equal(result.authMethod, "vertex-ai");
});

test("vertex-ai reports NOT loggedIn when only project is set (no location)", () => {
  const result = runAuthProbe({
    _AUTH_TYPE: "vertex-ai",
    GOOGLE_CLOUD_PROJECT: "my-project"
  });
  assert.equal(result.loggedIn, false);
});

test("vertex-ai reports NOT loggedIn when only location is set (no project)", () => {
  const result = runAuthProbe({
    _AUTH_TYPE: "vertex-ai",
    GOOGLE_CLOUD_LOCATION: "us-central1"
  });
  assert.equal(result.loggedIn, false);
});

test("vertex-ai reports NOT loggedIn when neither project nor location is set", () => {
  const result = runAuthProbe({ _AUTH_TYPE: "vertex-ai" });
  assert.equal(result.loggedIn, false);
});

test("vertex-ai accepts GCLOUD_PROJECT as a fallback for project", () => {
  const result = runAuthProbe({
    _AUTH_TYPE: "vertex-ai",
    GCLOUD_PROJECT: "alt-project",
    GOOGLE_CLOUD_LOCATION: "europe-west1"
  });
  assert.equal(result.loggedIn, true);
});

test("gateway reports NOT loggedIn when no gateway sub-config exists", () => {
  const result = runAuthProbe({ _AUTH_TYPE: "gateway" });
  assert.equal(result.loggedIn, false);
  assert.equal(result.authMethod, "gateway");
});

test("gateway reports loggedIn when gateway sub-config is present", () => {
  const tmpHome = makeTempDir("auth-test-gw-");
  const binDir = path.join(tmpHome, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, "gemini"), '#!/bin/sh\necho "1.0.0"');

  const settingsDir = path.join(tmpHome, ".gemini");
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "gateway", gateway: { endpoint: "https://gw.example.com" } } } })
  );

  const wrapper = [
    `import { getGeminiAuthStatus } from ${JSON.stringify(SCRIPT)};`,
    `const result = await getGeminiAuthStatus(process.cwd(), { env: process.env });`,
    `process.stdout.write(JSON.stringify({ loggedIn: result.loggedIn, authMethod: result.authMethod }));`
  ].join("\n");
  const wrapperFile = path.join(tmpHome, "probe.mjs");
  fs.writeFileSync(wrapperFile, wrapper);

  const { stdout } = spawnSync(process.execPath, [wrapperFile], {
    cwd: tmpHome,
    env: { HOME: tmpHome, PATH: `${binDir}:${process.env.PATH}`, NODE_NO_WARNINGS: "1" },
    encoding: "utf8",
    timeout: 5000
  });

  const result = stdout ? JSON.parse(stdout) : {};
  assert.equal(result.loggedIn, true);
  assert.equal(result.authMethod, "gateway");
});

test("gemini-api-key reports loggedIn when GEMINI_API_KEY is set", () => {
  const result = runAuthProbe({
    _AUTH_TYPE: "gemini-api-key",
    GEMINI_API_KEY: "test-key-123"
  });
  assert.equal(result.loggedIn, true);
});

test("gemini-api-key reports NOT loggedIn when GEMINI_API_KEY is missing", () => {
  const result = runAuthProbe({ _AUTH_TYPE: "gemini-api-key" });
  assert.equal(result.loggedIn, false);
});

test("project-scoped settings are discovered when user-level settings are absent", () => {
  const tmpHome = makeTempDir("auth-proj-");
  const tmpProject = makeTempDir("auth-proj-cwd-");
  const binDir = path.join(tmpHome, "bin");
  fs.mkdirSync(binDir);
  writeExecutable(path.join(binDir, "gemini"), '#!/bin/sh\necho "1.0.0"');

  // No user-level settings at tmpHome/.gemini/settings.json
  // Project-scoped settings at tmpProject/.gemini/settings.json
  const projectSettingsDir = path.join(tmpProject, ".gemini");
  fs.mkdirSync(projectSettingsDir);
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } })
  );

  // Make tmpProject a git repo so resolveWorkspaceRoot finds it
  spawnSync("git", ["init"], { cwd: tmpProject });

  const wrapper = [
    `import { getGeminiAuthStatus } from ${JSON.stringify(SCRIPT)};`,
    `const result = await getGeminiAuthStatus(process.cwd(), { env: process.env });`,
    `process.stdout.write(JSON.stringify({ loggedIn: result.loggedIn, authMethod: result.authMethod }));`
  ].join("\n");
  const wrapperFile = path.join(tmpProject, "probe.mjs");
  fs.writeFileSync(wrapperFile, wrapper);

  const { stdout } = spawnSync(process.execPath, [wrapperFile], {
    cwd: tmpProject,
    env: {
      HOME: tmpHome,
      PATH: `${binDir}:${process.env.PATH}`,
      NODE_NO_WARNINGS: "1",
      GEMINI_API_KEY: "project-key-abc"
    },
    encoding: "utf8",
    timeout: 5000
  });

  const result = stdout ? JSON.parse(stdout) : {};
  assert.equal(result.loggedIn, true);
  assert.equal(result.authMethod, "gemini-api-key");
});

// Regression: the OAuth probe used to look only for gemini-credentials.json, a name
// Gemini CLI does not write. Every logged-in user was reported as logged out.
test("oauth-personal reports loggedIn when oauth_creds.json exists", () => {
  const result = runAuthProbe({ _AUTH_TYPE: "oauth-personal" }, { credentialFiles: ["oauth_creds.json"] });
  assert.equal(result.loggedIn, true);
  assert.equal(result.authMethod, "oauth-personal");
  assert.match(result.credentialFile ?? "", /oauth_creds\.json$/);
});

test("oauth-personal still accepts the legacy gemini-credentials.json name", () => {
  const result = runAuthProbe(
    { _AUTH_TYPE: "oauth-personal" },
    { credentialFiles: ["gemini-credentials.json"] }
  );
  assert.equal(result.loggedIn, true);
  assert.match(result.credentialFile ?? "", /gemini-credentials\.json$/);
});

test("oauth-personal prefers oauth_creds.json when both names are present", () => {
  const result = runAuthProbe(
    { _AUTH_TYPE: "oauth-personal" },
    { credentialFiles: ["gemini-credentials.json", "oauth_creds.json"] }
  );
  assert.match(result.credentialFile ?? "", /oauth_creds\.json$/);
});

test("oauth-personal reports NOT loggedIn and names the files it probed", () => {
  const result = runAuthProbe({ _AUTH_TYPE: "oauth-personal" });
  assert.equal(result.loggedIn, false);
  assert.match(result.detail ?? "", /oauth_creds\.json/);
  assert.match(result.detail ?? "", /gemini-credentials\.json/);
  assert.equal(result.credentialFile, null);
});
