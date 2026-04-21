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

function runAuthProbe(env = {}) {
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

  const wrapper = [
    `import { getGeminiAuthStatus } from ${JSON.stringify(SCRIPT)};`,
    `const result = await getGeminiAuthStatus(process.cwd(), { env: process.env });`,
    `process.stdout.write(JSON.stringify({ loggedIn: result.loggedIn, authMethod: result.authMethod }));`
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
