/**
 * nr create — Create a new secure room
 */

import { createRoom } from "../core/room";
import { DEFAULT_SERVER } from "../utils/config";
import {
  showRoomHeader,
  outputJson,
  log,
  logInfo,
  logSuccess,
  logError,
} from "../utils/ui";
import type { CreateOptions, RoomState } from "../types";
import * as readline from "readline";

export async function createCommand(options: CreateOptions): Promise<void> {
  const server = options.server || DEFAULT_SERVER;
  const json = options.json || false;

  try {
    const session = await createRoom(server, {
      onState: (state: RoomState, detail?: string) => {
        if (json) return;
        switch (state) {
          case "created":
            logInfo("Room created");
            break;
          case "waiting":
            log("Waiting for peer to connect...");
            break;
          case "pq_upgrade":
            logInfo("Starting post-quantum key exchange...");
            break;
          case "connected":
            logSuccess("Peer connected. Post-quantum encryption active.");
            log("Type messages below (Ctrl+C to exit):\n");
            break;
          case "closed":
            log(`\n  Session ended${detail ? `: ${detail}` : ""}`);
            process.exit(0);
            break;
        }
      },
      onProgress: (msg: string) => {
        if (!json) logInfo(msg);
      },
      onError: (err: Error) => {
        if (json) {
          outputJson({ type: "error", error: err.message });
        } else {
          logError(err.message);
        }
      },
    });

    // Output connection info
    if (json) {
      outputJson({
        type: "room_created",
        code: session.phrase,
        connectionString: session.connectionString,
        roomId: session.connectionInfo.roomId,
      });
    } else {
      showRoomHeader(session.phrase, session.connectionString);
    }

    // Wait for peer to connect
    await session.waitForConnection();

    // Set up message display
    session.onMessage((msg: string) => {
      if (json) {
        outputJson({ type: "message", data: msg });
      } else {
        process.stdout.write(`\x1b[34m< ${msg}\x1b[0m\n`);
      }
    });

    // Interactive chat mode
    if (json) {
      // In JSON mode, read JSON lines from stdin
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "message" && parsed.data) {
            await session.sendMessage(parsed.data);
          }
        } catch {
          // Try sending as plain text
          await session.sendMessage(line);
        }
      });
      rl.on("close", () => {
        session.destroy();
        process.exit(0);
      });
    } else {
      // Interactive mode: read lines from stdin
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "> ",
      });
      rl.prompt();
      rl.on("line", async (line) => {
        if (line.trim()) {
          await session.sendMessage(line);
        }
        rl.prompt();
      });
      rl.on("close", () => {
        session.destroy();
        process.exit(0);
      });
    }
  } catch (err) {
    if (json) {
      outputJson({ type: "error", error: (err as Error).message });
    } else {
      logError((err as Error).message);
    }
    process.exit(1);
  }
}
