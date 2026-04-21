/**
 * Gemini Agent-Client Protocol (ACP) client.
 *
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./acp-protocol").AcpMethod} AcpMethod
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").AcpNotificationHandler} AcpNotificationHandler
 * @typedef {import("./acp-protocol").ClientCapabilities} ClientCapabilities
 * @typedef {import("./acp-protocol").AcpClientOptions} AcpClientOptions
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "GEMINI_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// Method-name table. Gemini ACP (v1) uses slash-notation for session methods.
// If a future Gemini CLI rev renames methods (e.g., drops the session/ prefix),
// edit this table in one place.
export const ACP_METHODS = Object.freeze({
  initialize: "initialize",
  authenticate: "authenticate",
  newSession: "session/new",
  loadSession: "session/load",
  prompt: "session/prompt",
  cancel: "session/cancel",
  setSessionMode: "session/set_mode",
  setSessionModel: "session/set_model"
});

/** @type {ClientCapabilities} */
const DEFAULT_CLIENT_CAPABILITIES = {};

const DEFAULT_PROTOCOL_VERSION = 1;

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AcpNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.initializeResult = null;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AcpMethod} M
   * @param {M} method
   * @param {import("./acp-protocol").AcpRequestParams<M>} params
   * @returns {Promise<import("./acp-protocol").AcpResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("gemini ACP client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Gemini CLI prints noisy non-JSONL warnings to stdout in some modes
      // (e.g., MCP-server duplicate registration warnings). Drop unparsable lines.
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          createProtocolError(
            message.error.message ?? `gemini ACP ${pending.method} failed.`,
            message.error
          )
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AcpNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    // Gemini may issue filesystem/permission requests; return method-not-found
    // for now so the agent falls back to its own behavior.
    this.sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("gemini ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }

  async initialize() {
    const result = await this.request(ACP_METHODS.initialize, {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      clientCapabilities: this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
      clientInfo: {
        name: "claude-code-gemini-plugin",
        version: PLUGIN_MANIFEST.version ?? "0.0.0"
      }
    });
    this.initializeResult = result;
    return result;
  }
}

class SpawnedAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("gemini", ["--acp"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // gemini is a Node shebang that re-execs a `node --max-old-space-size` child.
      // Without a dedicated pgroup we can only signal the wrapper, leaving the
      // real gemini process orphaned and our workers stuck in `client.close()`.
      // detached:true gives the wrapper+child their own group so we can kill it
      // wholesale on teardown. We do not call child.unref() — the parent still
      // needs to hold a handle for the 'exit' event.
      detached: process.platform !== "win32",
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `gemini --acp exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    return await super.initialize();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      try { this.proc.stdin.end(); } catch { /* pipe may already be closed */ }
      const killGroup = (signal) => {
        if (!this.proc || this.proc.killed || this.proc.exitCode !== null) return;
        if (process.platform === "win32") {
          try { terminateProcessTree(this.proc.pid); } catch { /* best-effort */ }
          return;
        }
        const pgid = this.proc.pid;
        try { process.kill(-pgid, signal); } catch (error) {
          if (error?.code !== "ESRCH") {
            try { this.proc.kill(signal); } catch { /* already gone */ }
          }
        }
      };
      const sigterm = setTimeout(() => killGroup("SIGTERM"), 50);
      sigterm.unref?.();
      const sigkill = setTimeout(() => killGroup("SIGKILL"), 750);
      sigkill.unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("gemini --acp stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    return await super.initialize();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
      setTimeout(() => {
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
      }, 50).unref?.();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("gemini ACP broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class GeminiAcpClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ??
        options.env?.[BROKER_ENDPOINT_ENV] ??
        process.env[BROKER_ENDPOINT_ENV] ??
        null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerAcpClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}
