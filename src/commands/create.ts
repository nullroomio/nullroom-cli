/**
 * nr create — Create a new secure room
 */

import { createRoom } from "../core/room";
import { DEFAULT_SERVER } from "../utils/config";
import { registerCleanup } from "../index";
import {
  showRoomHeader,
  showBanner,
  showSeparator,
  getInputPrompt,
  printChatMessage,
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
  let lastConnectionPath: "direct" | "relay" | "blocked" | null = null;
  let chatRl: readline.Interface | null = null;

  try {
    const session = await createRoom(server, {
      onState: (state: RoomState, detail?: string) => {
        if (json) return;
        switch (state) {
          case "created":
            showBanner();
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
            showSeparator("connected");
            break;
          case "closed":
            showSeparator("session ended");
            process.exit(0);
            break;
        }
      },
      onProgress: (msg: string) => {
        if (!json) {
          logInfo(msg);
          if (chatRl) chatRl.prompt(true);
        }
      },
      onError: (err: Error) => {
        if (json) {
          outputJson({ type: "error", error: err.message });
        } else {
          logError(err.message);
          if (chatRl) chatRl.prompt(true);
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
        if (chatRl) chatRl.prompt(true);
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

    // Register cleanup for SIGINT
    registerCleanup(() => {
      session.destroy();
    });

    // Wait for peer to connect
    await session.waitForConnection();

    // Interactive chat mode
    if (json) {
      // Set up message display for JSON mode
      session.onMessage((msg: string) => {
        outputJson({ type: "message", data: msg });
      });

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
      // Interactive mode: set up readline and keep the session alive
      await new Promise<void>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          prompt: getInputPrompt(),
        });
        chatRl = rl;
        log("");
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
          resolve();
        });
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
