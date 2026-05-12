/**
 * nr join <code> — Join an existing secure room
 */

import { joinRoom } from "../core/room";
import { DEFAULT_SERVER } from "../utils/config";
import {
  outputJson,
  log,
  logInfo,
  logSuccess,
  logError,
} from "../utils/ui";
import type { JoinOptions, RoomState } from "../types";
import * as readline from "readline";

export async function joinCommand(code: string, options: JoinOptions): Promise<void> {
  const server = options.server || DEFAULT_SERVER;
  const json = options.json || false;

  try {
    const session = await joinRoom(code, server, {
      onState: (state: RoomState, detail?: string) => {
        if (json) return;
        switch (state) {
          case "connecting":
            logInfo("Looking up room...");
            break;
          case "waiting":
            log("Connecting to room...");
            break;
          case "pq_upgrade":
            logInfo("Starting post-quantum key exchange...");
            break;
          case "connected":
            logSuccess("Connected. Post-quantum encryption active.");
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

    if (json) {
      outputJson({ type: "joined", roomId: session.connectionInfo.roomId });
    }

    // Wait for connection
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
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", async (line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "message" && parsed.data) {
            await session.sendMessage(parsed.data);
          }
        } catch {
          await session.sendMessage(line);
        }
      });
      rl.on("close", () => {
        session.destroy();
        process.exit(0);
      });
    } else {
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
