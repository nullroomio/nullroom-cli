/**
 * nr join <code> — Join an existing secure room
 */

import { joinRoom } from "../core/room";
import { DEFAULT_SERVER } from "../utils/config";
import { registerCleanup } from "../index";
import {
  showBanner,
  showSeparator,
  printChatMessage,
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
  let lastConnectionPath: "direct" | "relay" | "blocked" | null = null;

  try {
    const session = await joinRoom(code, server, {
      onState: (state: RoomState, detail?: string) => {
        if (json) return;
        switch (state) {
          case "connecting":
            showBanner();
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
            showSeparator("connected");
            break;
          case "closed":
            showSeparator("session ended");
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
      onConnectionPath: (path) => {
        if (lastConnectionPath === path) return;
        lastConnectionPath = path;

        if (json) {
          outputJson({ type: "connection_path", path });
          return;
        }

        if (path === "direct") {
          logSuccess("Connection path: direct P2P");
        } else if (path === "relay") {
          logInfo("Connection path: encrypted relay (TURN)");
        } else {
          logError("Connection path blocked (direct and relay unavailable)");
        }
      },
    });

    if (json) {
      outputJson({ type: "joined", roomId: session.connectionInfo.roomId });
    }

    // Register cleanup for SIGINT
    registerCleanup(() => {
      session.destroy();
    });

    // Wait for connection
    await session.waitForConnection();

    // Interactive chat mode
    if (json) {
      // Set up message display for JSON mode
      session.onMessage((msg: string) => {
        outputJson({ type: "message", data: msg });
      });

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
      // Interactive mode: set up readline
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "> ",
      });
      rl.prompt();

      // Display incoming messages, clearing/restoring prompt
      session.onMessage((msg: string) => {
        printChatMessage("peer", msg, rl);
      });

      rl.on("line", async (line) => {
        if (line.trim()) {
          await session.sendMessage(line);
          printChatMessage("you", line, rl);
        } else {
          rl.prompt();
        }
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
