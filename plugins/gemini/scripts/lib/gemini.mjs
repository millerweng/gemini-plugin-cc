/**
 * Gemini model-specific ACP adapter. Mirrors the codex.mjs contract so
 * gemini-companion.mjs can call runAcpTurn / runAcpReview without caring
 * about model details.
 *
 * @typedef {((update: string | { message: string, phase?: string | null, sessionId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import {
  ACP_METHODS,
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  GeminiAcpClient
} from "./acp-client.mjs";
import { clearBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const TASK_SESSION_PREFIX = "Gemini Companion Task";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

function resolveTaskTimeoutMs() {
  const raw = process.env.GEMINI_TASK_TIMEOUT_MS;
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TASK_TIMEOUT_MS;
  return parsed;
}

const GEMINI_SETTINGS_FILE = path.join(os.homedir(), ".gemini", "settings.json");
const TASK_SESSION_INDEX_FILE = ".gemini-task-sessions.json";

// Gemini CLI writes OAuth credentials to oauth_creds.json. Older/other builds have
// used gemini-credentials.json, so both names are probed before declaring a miss.
// The file check is only a hint: `setup --verify` runs a real ACP handshake and
// that result always wins over what is on disk.
const OAUTH_CREDENTIAL_FILENAMES = ["oauth_creds.json", "gemini-credentials.json"];

function findOauthCredentialFile() {
  const geminiHome = path.join(os.homedir(), ".gemini");
  for (const filename of OAUTH_CREDENTIAL_FILENAMES) {
    const candidate = path.join(geminiHome, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Effort → Gemini thinking controls. Gemini 3 uses thinkingLevel (low|medium|high);
// Gemini 2.5 used thinkingBudget (int). We expose --effort low|medium|high and let
// Gemini pick the right knob based on the current model.
const EFFORT_TO_THINKING_LEVEL = new Map([
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"]
]);

export function cleanGeminiStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (!line) {
        return false;
      }
      // Drop known Gemini CLI startup warnings that leak to stderr but do not
      // indicate a real failure for the ACP session.
      if (line.startsWith("MCP server ")) return false;
      if (line.startsWith("Prompt with name ") && line.includes(" is already registered")) return false;
      if (line.startsWith("Tool with name ") && line.includes(" is already registered")) return false;
      if (line.startsWith("Skill ") && line.includes(" is overriding the built-in skill")) return false;
      if (line.startsWith("[STARTUP] Phase ")) return false;
      if (line.startsWith("[DEBUG] ")) return false;
      return true;
    })
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskSessionName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) return;
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) return;
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function createTurnCaptureState(sessionId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    sessionId,
    turnId: null,
    completion,
    resolveCompletion,
    rejectCompletion,
    completed: false,
    stopReason: null,
    lastAgentMessage: "",
    agentMessageBuffer: "",
    thoughts: [],
    toolCalls: new Map(),
    touchedFiles: new Set(),
    error: null,
    onProgress: options.onProgress ?? null
  };
}

function collectToolTouchedFiles(state, toolCall) {
  // Heuristic: when Gemini reports a tool_call or tool_call_update with a
  // file-writing kind, try to pull a path out of rawInput/rawOutput.
  const rawInput = toolCall?.rawInput;
  if (rawInput && typeof rawInput === "object") {
    for (const key of ["absolute_path", "path", "file_path", "filepath"]) {
      const value = rawInput[key];
      if (typeof value === "string" && value) {
        state.touchedFiles.add(value);
      }
    }
  }
}

function applySessionUpdate(state, params) {
  if (!params || params.sessionId !== state.sessionId) return;
  const update = params.update ?? {};
  const kind = update.sessionUpdate;

  switch (kind) {
    case "agent_message_chunk": {
      const text =
        (typeof update.content === "object" && typeof update.content?.text === "string"
          ? update.content.text
          : "") ||
        (typeof update.text === "string" ? update.text : "");
      if (text) {
        state.agentMessageBuffer += text;
      }
      break;
    }
    case "agent_thought_chunk": {
      const text =
        (typeof update.content === "object" && typeof update.content?.text === "string"
          ? update.content.text
          : "") ||
        (typeof update.thought === "string" ? update.thought : "") ||
        (typeof update.text === "string" ? update.text : "");
      if (text) {
        state.thoughts.push(text.trim());
        emitLogEvent(state.onProgress, {
          message: `Reasoning: ${shorten(text, 96)}`,
          phase: "investigating"
        });
      }
      break;
    }
    case "tool_call": {
      const toolCall = update.toolCall ?? update;
      if (toolCall?.toolCallId) {
        state.toolCalls.set(toolCall.toolCallId, toolCall);
      }
      collectToolTouchedFiles(state, toolCall);
      const title = toolCall?.title || toolCall?.kind || "tool";
      emitProgress(state.onProgress, `Tool call: ${shorten(title, 96)}`, "investigating");
      break;
    }
    case "tool_call_update": {
      const toolCall = update.toolCall ?? update;
      if (toolCall?.toolCallId) {
        state.toolCalls.set(toolCall.toolCallId, {
          ...(state.toolCalls.get(toolCall.toolCallId) ?? {}),
          ...toolCall
        });
      }
      collectToolTouchedFiles(state, toolCall);
      const status = toolCall?.status ?? "updated";
      const title = toolCall?.title || toolCall?.kind || "tool";
      emitProgress(state.onProgress, `Tool ${status}: ${shorten(title, 96)}`, "investigating");
      break;
    }
    case "plan":
      emitProgress(state.onProgress, "Plan updated.", "starting");
      break;
    case "available_commands_update":
      // Ignore — the available-commands list is informational.
      break;
    case "user_message_chunk":
      // Echo of the user prompt; ignore.
      break;
    default:
      break;
  }
}

function completeTurn(state, stopReason, turn = null) {
  if (state.completed) return;
  state.completed = true;
  state.stopReason = stopReason ?? "end_turn";
  if (state.agentMessageBuffer) {
    state.lastAgentMessage = state.agentMessageBuffer;
  }
  state.resolveCompletion(state);
}

async function captureTurn(client, sessionId, startRequest, options = {}) {
  const state = createTurnCaptureState(sessionId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    if (message.method === ACP_METHODS.prompt || message.method === "session/update") {
      if (message.params?.sessionId === state.sessionId) {
        applySessionUpdate(state, message.params);
      } else if (previousHandler) {
        previousHandler(message);
      }
      return;
    }
    if (previousHandler) previousHandler(message);
  });

  const timeoutMs = resolveTaskTimeoutMs();
  let timeoutHandle = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Gemini turn exceeded ${timeoutMs}ms timeout. Override with GEMINI_TASK_TIMEOUT_MS.`
        )
      );
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([startRequest(), timeoutPromise]);
    const stopReason = response?.stopReason ?? "end_turn";
    completeTurn(state, stopReason);
    return await state.completion;
  } catch (error) {
    if (!state.completed) {
      state.error = error;
      completeTurn(state, "error");
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAcpClient(cwd, fn) {
  let client = null;
  try {
    client = await GeminiAcpClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested =
      client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    // A broker endpoint that answers but speaks another dialect is a foreign server —
    // in practice the Codex plugin's app-server, which shares this state layout. It
    // accepts `initialize` and then rejects `session/new`. Treat that like a dead
    // broker: fall back to direct, and forget the endpoint so the next run does not
    // dial it again.
    const dialectMismatch =
      client?.transport === "broker" &&
      (error?.rpcCode === -32600 ||
        error?.rpcCode === -32601 ||
        /unknown variant|method not found/i.test(String(error?.message ?? "")));
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      dialectMismatch ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (dialectMismatch) {
      try {
        clearBrokerSession(cwd);
      } catch {
        // Best effort: the retry below still uses the direct transport.
      }
    }

    if (!shouldRetryDirect) throw error;

    const directClient = await GeminiAcpClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function startSession(client, cwd, options = {}) {
  const params = {
    cwd,
    mcpServers: options.mcpServers ?? []
  };
  if (options.model) {
    params.modelId = options.model;
  }
  const response = await client.request(ACP_METHODS.newSession, params);
  await applySessionControls(client, response.sessionId, options);
  return response;
}

async function loadSession(client, sessionId, cwd, options = {}) {
  const params = {
    sessionId,
    cwd,
    mcpServers: options.mcpServers ?? []
  };
  if (options.model) {
    params.modelId = options.model;
  }
  const response = await client.request(ACP_METHODS.loadSession, params);
  await applySessionControls(client, sessionId, options);
  return response ?? { sessionId };
}

async function applySessionControls(client, sessionId, options = {}) {
  if (options.sandbox === "read-only" || options.approvalMode === "plan") {
    try {
      await client.request(ACP_METHODS.setSessionMode, { sessionId, modeId: "plan" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot enforce read-only/plan mode for session ${sessionId}: ${detail}. ` +
        `Aborting to prevent unintended writes.`
      );
    }
  } else if (options.approvalMode === "yolo" || options.sandbox === "workspace-write") {
    await client
      .request(ACP_METHODS.setSessionMode, { sessionId, modeId: "yolo" })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[gemini] setSessionMode(yolo) failed for session ${sessionId}: ${detail}\n`
        );
      });
  }
  if (options.effort && EFFORT_TO_THINKING_LEVEL.has(options.effort)) {
    // Pending upstream ACP support — thinkingLevel control is not yet exposed.
  }
}

function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt }];
}

function buildResultStatus(turnState) {
  if (turnState.stopReason !== "end_turn") return 1;
  const message = turnState.lastAgentMessage;
  if (typeof message !== "string" || !message.trim()) return 1;
  return 0;
}

function collectTouchedFilePaths(state) {
  return [...state.touchedFiles];
}

// -----------------------------------------------------------------------------
// Public availability / auth / session-runtime probes.
// -----------------------------------------------------------------------------

export function getGeminiAvailability(cwd) {
  const versionStatus = binaryAvailable("gemini", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const acpStatus = binaryAvailable("gemini", ["--acp", "--help"], { cwd });
  if (!acpStatus.available) {
    return {
      available: false,
      detail: "gemini --version works but --acp mode is not supported by this build"
    };
  }

  return {
    available: true,
    detail: versionStatus.detail
  };
}

function readSettingsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readGeminiSettings(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd ?? process.cwd());
  const projectPath = path.join(workspaceRoot, ".gemini", "settings.json");
  const projectSettings = readSettingsFile(projectPath);
  const userSettings = readSettingsFile(GEMINI_SETTINGS_FILE);

  if (!projectSettings && !userSettings) return { resolved: null, source: null };
  if (projectSettings && !userSettings) return { resolved: projectSettings, source: projectPath };
  if (!projectSettings && userSettings) return { resolved: userSettings, source: GEMINI_SETTINGS_FILE };

  // Project overrides user per-key within security.auth
  const mergedAuth = {
    ...(userSettings?.security?.auth ?? {}),
    ...(projectSettings?.security?.auth ?? {})
  };
  const merged = {
    ...userSettings,
    ...projectSettings,
    security: {
      ...(userSettings?.security ?? {}),
      ...(projectSettings?.security ?? {}),
      auth: mergedAuth
    }
  };
  return { resolved: merged, source: projectPath };
}

function describeAuthType(selectedType, env, details = {}) {
  switch (selectedType) {
    case "vertex-ai": {
      const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
      const location = env.GOOGLE_CLOUD_LOCATION;
      if (project && location) {
        return `Vertex AI (project=${project}, location=${location})`;
      }
      if (project) {
        return `Vertex AI (project=${project}; set GOOGLE_CLOUD_LOCATION)`;
      }
      return "Vertex AI (set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION)";
    }
    case "gemini-api-key":
      return env.GEMINI_API_KEY
        ? "Gemini API key configured"
        : "Gemini API key selected, but GEMINI_API_KEY is unset";
    case "google-api-key":
      return env.GOOGLE_API_KEY
        ? "Google API key configured"
        : "Google API key selected, but GOOGLE_API_KEY is unset";
    case "oauth-personal":
    case "oauth": {
      if (details.oauthCredentialFile) {
        return `Google OAuth (personal); credentials found at ${details.oauthCredentialFile}`;
      }
      const probed = OAUTH_CREDENTIAL_FILENAMES.join(", ");
      return `Google OAuth (personal) selected, but no credential file was found in ~/.gemini (looked for ${probed}). Run \`setup --verify\` to test the login directly.`;
    }
    case "gateway":
      return "AI API Gateway";
    default:
      return selectedType ? `Configured auth type: ${selectedType}` : "No auth configured";
  }
}

export async function getGeminiAuthStatus(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      provider: null
    };
  }

  const env = options.env ?? process.env;
  const { resolved: settings } = readGeminiSettings(cwd);
  const selectedType = settings?.security?.auth?.selectedType ?? null;
  if (!selectedType) {
    const workspaceRoot = resolveWorkspaceRoot(cwd ?? process.cwd());
    const projectPath = path.join(workspaceRoot, ".gemini", "settings.json");
    return {
      available: true,
      loggedIn: false,
      detail: `No auth type selected. Checked ${projectPath} and ${GEMINI_SETTINGS_FILE}. Run \`gemini auth\` in a terminal outside Claude Code, or edit the settings file directly.`,
      source: "settings",
      authMethod: null,
      verified: false,
      provider: null
    };
  }

  let loggedIn = false;
  let oauthCredentialFile = null;
  switch (selectedType) {
    case "vertex-ai":
      loggedIn = Boolean(
        (env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT) && env.GOOGLE_CLOUD_LOCATION
      );
      break;
    case "gemini-api-key":
      loggedIn = Boolean(env.GEMINI_API_KEY);
      break;
    case "google-api-key":
      loggedIn = Boolean(env.GOOGLE_API_KEY);
      break;
    case "oauth-personal":
    case "oauth": {
      oauthCredentialFile = findOauthCredentialFile();
      loggedIn = Boolean(oauthCredentialFile);
      break;
    }
    case "gateway": {
      const gatewayConfig = settings?.security?.auth?.gateway;
      loggedIn = Boolean(gatewayConfig && typeof gatewayConfig === "object" && Object.keys(gatewayConfig).length > 0);
      break;
    }
    default:
      loggedIn = false;
  }

  return {
    available: true,
    loggedIn,
    detail: describeAuthType(selectedType, env, { oauthCredentialFile }),
    source: "settings",
    authMethod: selectedType,
    verified: null,
    provider: selectedType,
    credentialFile: oauthCredentialFile
  };
}

export async function verifyGeminiConnectivity(cwd, options = {}) {
  const authStatus = await getGeminiAuthStatus(cwd, options);
  // Only bail out when nothing is configured at all. A configured auth type whose
  // credentials were not found on disk still gets a real ACP handshake: the file
  // layout is Gemini CLI's business and it changes between releases, so a live
  // session is the only trustworthy answer.
  if (!authStatus.authMethod) {
    return { verified: false, detail: `Auth check failed: ${authStatus.detail}` };
  }

  const { spawn: spawnChild } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const timeout = options.timeout ?? 15000;

  const requests = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } })
  ].join("\n") + "\n";

  return new Promise((resolve) => {
    const child = spawnChild("gemini", ["--acp"], {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let settled = false;
    let initOk = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ verified: false, detail: "ACP verification timed out" });
      }
    }, timeout);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1 && msg.result) initOk = true;
        if (msg.id === 1 && msg.error) {
          finish({ verified: false, detail: msg.error.message ?? "ACP initialization rejected" });
          return;
        }
        if (msg.id === 2 && msg.result?.sessionId) {
          finish({ verified: true, detail: "ACP session created successfully" });
          return;
        }
        if (msg.id === 2 && msg.error) {
          finish({ verified: false, detail: msg.error.message ?? "Session creation failed (auth may be invalid)" });
          return;
        }
      } catch {
        // non-JSON line, skip
      }
    });

    child.on("error", (err) => {
      finish({ verified: false, detail: err.message ?? "gemini --acp failed to start" });
    });

    child.on("close", () => {
      if (!settled) {
        finish(
          initOk
            ? { verified: false, detail: "ACP initialized but session creation got no response" }
            : { verified: false, detail: "No valid ACP response received" }
        );
      }
    });

    child.stdin.write(requests);
    child.stdin.end();
  });
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Gemini ACP runtime.",
      endpoint
    };
  }
  return {
    mode: "direct",
    label: "direct startup",
    detail:
      "No shared Gemini ACP runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

// -----------------------------------------------------------------------------
// Interrupt + resume discovery
// -----------------------------------------------------------------------------

export async function interruptAcpTurn(cwd, { sessionId }) {
  if (!sessionId) {
    return { attempted: false, interrupted: false, transport: null, detail: "missing sessionId" };
  }
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    return { attempted: false, interrupted: false, transport: null, detail: availability.detail };
  }

  let client = null;
  try {
    client = await GeminiAcpClient.connect(cwd, { reuseExistingBroker: true });
    await client.request(ACP_METHODS.cancel, { sessionId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Cancelled ${sessionId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

function resolveSessionIndexPath(cwd) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, TASK_SESSION_INDEX_FILE);
}

function readSessionIndex(cwd) {
  const file = resolveSessionIndexPath(cwd);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function writeSessionIndex(cwd, sessions) {
  const file = resolveSessionIndexPath(cwd);
  try {
    fs.writeFileSync(file, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort; session resume will fall back to "no prior thread".
  }
}

function recordPersistentSession(cwd, sessionId, name) {
  if (!sessionId) return;
  const sessions = readSessionIndex(cwd);
  const next = [
    { id: sessionId, name: name ?? null, updatedAt: new Date().toISOString() },
    ...sessions.filter((entry) => entry.id !== sessionId)
  ].slice(0, 20);
  writeSessionIndex(cwd, next);
}

export async function findLatestTaskSession(cwd) {
  const sessions = readSessionIndex(cwd);
  const latest = sessions.find((entry) => entry.id);
  return latest ? { id: latest.id, name: latest.name ?? null } : null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskSessionName(prompt);
}

// -----------------------------------------------------------------------------
// Turn execution
// -----------------------------------------------------------------------------

export async function runAcpTurn(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Gemini CLI is not installed. Install it with `npm install -g @google/gemini-cli@0.38.2`, then rerun `/gemini:setup`."
    );
  }

  return withAcpClient(cwd, async (client) => {
    let sessionId;

    if (options.resumeSessionId) {
      emitProgress(options.onProgress, `Resuming Gemini session ${options.resumeSessionId}.`, "starting");
      const response = await loadSession(client, options.resumeSessionId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        approvalMode: options.approvalMode,
        effort: options.effort
      });
      sessionId = response.sessionId ?? options.resumeSessionId;
    } else {
      emitProgress(options.onProgress, "Starting Gemini ACP session.", "starting");
      const response = await startSession(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        approvalMode: options.approvalMode,
        effort: options.effort
      });
      sessionId = response.sessionId;
      if (options.persistThread) {
        recordPersistentSession(cwd, sessionId, options.threadName ?? null);
      }
    }

    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Gemini run.");
    }

    const turnState = await captureTurn(
      client,
      sessionId,
      () =>
        client.request(ACP_METHODS.prompt, {
          sessionId,
          prompt: buildTurnInput(prompt)
        }),
      { onProgress: options.onProgress }
    );

    if (turnState.lastAgentMessage) {
      emitLogEvent(options.onProgress, {
        message: `Final output: ${shorten(turnState.lastAgentMessage, 96)}`,
        phase: "finalizing",
        logTitle: "Assistant message",
        logBody: turnState.lastAgentMessage
      });
    }

    return {
      status: buildResultStatus(turnState),
      threadId: sessionId,
      sessionId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.thoughts,
      stopReason: turnState.stopReason,
      error: turnState.error,
      stderr: cleanGeminiStderr(client.stderr),
      fileChanges: [...turnState.toolCalls.values()],
      touchedFiles: collectTouchedFilePaths(turnState),
      commandExecutions: []
    };
  });
}

export async function runAcpReview(cwd, options = {}) {
  // Gemini has no built-in review RPC; reviews are prompt-based. Run like a task
  // but in read-only mode so Gemini never edits during review.
  return runAcpTurn(cwd, {
    ...options,
    sandbox: "read-only",
    approvalMode: "plan"
  });
}

// -----------------------------------------------------------------------------
// Structured output helpers (review-output.schema.json)
// -----------------------------------------------------------------------------

export function parseStructuredOutput(rawOutput, fallback = {}) {
  // `??` lets an empty string through, and callers build failureMessage from
  // `error?.message ?? stderr` — which is "" whenever Gemini exits without writing to
  // stderr. That produced a bare "Parse error:" with nothing after it.
  const failureMessage =
    typeof fallback.failureMessage === "string" && fallback.failureMessage.trim()
      ? fallback.failureMessage.trim()
      : null;

  // Spread first so the fields set below always win. A fallback key colliding with
  // `parsed` or `parseError` would otherwise overwrite the real result.
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError:
        failureMessage ??
        "Gemini exited without a final message. Nothing was returned to parse — check the job stderr for why the turn ended.",
      rawOutput: rawOutput ?? ""
    };
  }

  const candidate = extractJsonBlock(rawOutput);
  if (!candidate) {
    return {
      ...fallback,
      parsed: null,
      parseError: failureMessage
        ? `Gemini did not return a JSON block (${failureMessage}).`
        : "Gemini did not return a JSON block.",
      rawOutput
    };
  }

  try {
    return {
      ...fallback,
      parsed: JSON.parse(candidate),
      parseError: null,
      rawOutput
    };
  } catch (error) {
    // Before giving up, try the one repair that never changes meaning: escaping raw
    // control characters inside string literals. Discarding a complete set of findings
    // over a literal newline is a worse outcome than repairing it and saying so.
    const repaired = escapeControlCharsInStrings(candidate);
    if (repaired !== candidate) {
      try {
        return {
          ...fallback,
          parsed: JSON.parse(repaired),
          parseError: null,
          parseRepaired: "escaped raw control characters inside string values",
          rawOutput
        };
      } catch {
        // Fall through to the original error, which describes the payload as it came.
      }
    }

    return {
      ...fallback,
      parsed: null,
      parseError: `Gemini returned a JSON block that does not parse: ${error.message}`,
      rawOutput
    };
  }
}

function extractJsonBlock(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  // A review recommendation routinely contains a fenced code sample, so the payload
  // has ``` inside it. A non-greedy match to the first closing fence cuts the JSON off
  // mid-string; close on the last fence instead.
  let body = trimmed;
  const opening = trimmed.match(/^```(?:json)?[ \t]*\r?\n/i);
  if (opening) {
    const afterOpening = trimmed.slice(opening[0].length);
    const lastFence = afterOpening.lastIndexOf("```");
    body = lastFence === -1 ? afterOpening : afterOpening.slice(0, lastFence);
  }

  // Braces are the real delimiters. Anything outside them is prose or fence residue.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1).trim();
}

/**
 * Escapes raw control characters that appear inside JSON string literals. Models emit
 * literal newlines and tabs inside strings, which JSON forbids, and the whole payload
 * is otherwise discarded over a syntax detail that carries no meaning.
 */
function escapeControlCharsInStrings(json) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (const character of json) {
    if (escaping) {
      result += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      result += character;
      escaping = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      result += character;
      continue;
    }
    if (inString) {
      if (character === "\n") {
        result += "\\n";
        continue;
      }
      if (character === "\r") {
        result += "\\r";
        continue;
      }
      if (character === "\t") {
        result += "\\t";
        continue;
      }
    }
    result += character;
  }

  return result;
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { TASK_SESSION_PREFIX };
