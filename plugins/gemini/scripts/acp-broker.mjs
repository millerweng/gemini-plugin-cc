#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, GeminiAcpClient } from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

// Gemini's ACP `session/prompt` is request-response — notifications stream
// while the request is pending, and the response itself signals completion
// (via `stopReason`). There is no post-response notification stream, so
// the broker only needs `activeRequestSocket` to route notifications.
function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "session/cancel";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await GeminiAcpClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
  }

  function routeNotification(message) {
    if (!activeRequestSocket) {
      return;
    }
    send(activeRequestSocket, message);
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    // Serialize async message handling per-socket. The data event is sync,
    // but the handler awaits RPC calls — chain them through this promise so
    // later messages never interleave with earlier ones and mutate `buffer`
    // from under an in-flight await.
    let dispatchTail = Promise.resolve();

    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = [];
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        lines.push(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      for (const line of lines) {
        dispatchTail = dispatchTail.then(() => handleLine(line));
      }
    });

    async function handleLine(line) {
      if (!line.trim()) {
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        send(socket, {
          id: null,
          error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
        });
        return;
      }

      if (message.id !== undefined && message.method === "initialize") {
        send(socket, {
          id: message.id,
          result: {
            userAgent: "gemini-companion-broker"
          }
        });
        return;
      }

      if (message.method === "initialized" && message.id === undefined) {
        return;
      }

      if (message.id !== undefined && message.method === "broker/shutdown") {
        send(socket, { id: message.id, result: {} });
        await shutdown(server);
        process.exit(0);
      }

      if (message.id === undefined) {
        return;
      }

      // Cancel requests are always allowed — they may arrive from a second
      // socket while the originating socket is waiting on a long-running
      // session/prompt, and we need them to reach the agent without queuing.
      const allowCancelDuringActive =
        isInterruptRequest(message) && activeRequestSocket && activeRequestSocket !== socket;

      if (activeRequestSocket && activeRequestSocket !== socket && !allowCancelDuringActive) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Gemini broker is busy.")
        });
        return;
      }

      if (allowCancelDuringActive) {
        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
        }
        return;
      }

      activeRequestSocket = socket;

      try {
        const result = await appClient.request(message.method, message.params ?? {});
        send(socket, { id: message.id, result });
      } catch (error) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
        });
      } finally {
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
      }
    }

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
