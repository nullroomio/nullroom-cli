/**
 * nr pipe — Stdin/stdout piping for agent-to-agent communication
 *
 * Auto-detects direction:
 * - If stdin is piped and no code → create mode (send stdin through tunnel)
 * - If code is provided → join mode (receive and output to stdout)
 * - If both → bidirectional pipe
 */

import { createRoom, joinRoom } from "../core/room";
import { DEFAULT_SERVER } from "../utils/config";
import { outputJson, log, logInfo, logSuccess, logError } from "../utils/ui";
import type { PipeOptions, RoomState } from "../types";

const PIPE_READY_MARKER = "\x04PIPE_READY";

export async function pipeCommand(code: string | undefined, options: PipeOptions): Promise<void> {
  const server = options.server || DEFAULT_SERVER;
  const json = options.json || false;
  const stdinIsTTY = process.stdin.isTTY;

  // Determine mode
  if (code) {
    // Join mode: receive data and output to stdout
    await pipeReceive(code, server, json);
  } else if (!stdinIsTTY) {
    // Create mode: send stdin data through tunnel
    await pipeSend(server, json);
  } else {
    logError("Usage: <command> | nr pipe   OR   nr pipe <code>");
    logError("  Send: echo 'data' | nr pipe");
    logError("  Receive: nr pipe <code> > output.txt");
    process.exit(1);
  }
}

async function pipeSend(server: string, json: boolean): Promise<void> {
  try {
    // Read all stdin into a buffer
    const chunks: Uint8Array[] = [];
    const reader = Bun.stdin.stream().getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
    const buffer = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    // Create room
    const session = await createRoom(server, {
      onState: (state: RoomState) => {
        if (state === "connected" && !json) {
          logInfo("Peer connected. Sending data...");
        }
      },
      onProgress: (msg) => {
        if (!json) logInfo(msg);
      },
      onError: (err) => {
        logError(err.message);
      },
      onConnectionPath: (path) => {
        if (json) {
          process.stderr.write(JSON.stringify({ type: "connection_path", path }) + "\n");
          return;
        }
        if (path === "relay") {
          logInfo("Connection path: encrypted relay (TURN)");
        } else if (path === "direct") {
          logInfo("Connection path: direct P2P");
        } else {
          logError("Connection path blocked (direct and relay unavailable)");
        }
      },
    });

    let receiverReadyResolve: (() => void) | null = null;
    const receiverReadyPromise = new Promise<void>((resolve) => {
      receiverReadyResolve = resolve;
    });

    session.onMessage((msg: string) => {
      if (msg === PIPE_READY_MARKER) {
        receiverReadyResolve?.();
      }
    });

    // Output the code to stderr (so stdout stays clean for piping)
    if (json) {
      process.stderr.write(
        JSON.stringify({ type: "pipe_ready", code: session.phrase, connectionString: session.connectionString }) + "\n"
      );
    } else {
      process.stderr.write(`  Code: ${session.phrase}\n`);
    }

    // Wait for peer
    await session.waitForConnection();

    // Wait for receiver app-level readiness to avoid first-message races.
    await Promise.race([
      receiverReadyPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    // Send the data as a stream of encrypted messages
    // For simplicity, send as encrypted chat messages (chunked if large)
    const PIPE_CHUNK_SIZE = 16384; // 16 KB per message
    for (let i = 0; i < buffer.length; i += PIPE_CHUNK_SIZE) {
      const chunk = buffer.slice(i, i + PIPE_CHUNK_SIZE);
      const base64 = Buffer.from(chunk).toString("base64");
      await session.sendMessage(`\x02${base64}`); // \x02 = STX prefix for pipe data
    }

    // Send end-of-stream marker
    await session.sendMessage("\x03"); // ETX = end of transmission

    // Wait for flush
    await new Promise((resolve) => setTimeout(resolve, 500));
    session.destroy();
    process.exit(0);
  } catch (err) {
    logError((err as Error).message);
    process.exit(1);
  }
}

async function pipeReceive(code: string, server: string, json: boolean): Promise<void> {
  try {
    let readyForPayload = false;

    const session = await joinRoom(code, server, {
      onState: (state: RoomState) => {
        if (!json) {
          if (state === "connecting") logInfo("Connecting...");
        }
      },
      onProgress: (msg) => {
        if (!json) logInfo(msg);
      },
      onError: (err) => {
        logError(err.message);
      },
      onConnectionPath: (path) => {
        if (json) {
          process.stderr.write(JSON.stringify({ type: "connection_path", path }) + "\n");
          return;
        }
        if (path === "relay") {
          logInfo("Connection path: encrypted relay (TURN)");
        } else if (path === "direct") {
          logInfo("Connection path: direct P2P");
        } else {
          logError("Connection path blocked (direct and relay unavailable)");
        }
      },
    });

    // Register receiver handler before waiting for connection to avoid races
    // where sender transmits immediately after PQ upgrade completes.
    session.onMessage((msg: string) => {
      if (!readyForPayload) {
        return;
      }

      if (msg === "\x03") {
        // End of transmission
        session.destroy();
        process.exit(0);
      } else if (msg.startsWith("\x02")) {
        // Pipe data chunk (base64 encoded)
        const base64 = msg.slice(1);
        const data = Buffer.from(base64, "base64");
        process.stdout.write(data);
      }
    });

    await session.waitForConnection();

    readyForPayload = true;

    // Signal sender that receiver handlers are fully installed.
    await session.sendMessage(PIPE_READY_MARKER);

    if (!json) {
      process.stderr.write("  Connected. Receiving data...\n");
    }

    // Timeout after 5 minutes of no data
    setTimeout(() => {
      session.destroy();
      process.exit(0);
    }, 300_000);
  } catch (err) {
    logError((err as Error).message);
    process.exit(1);
  }
}
