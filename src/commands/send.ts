/**
 * nr send <file> — One-shot encrypted file transfer
 */

import { createRoom } from "../core/room";
import { DEFAULT_SERVER, FILE_SIZE_LIMIT } from "../utils/config";
import {
  showRoomHeader,
  outputJson,
  log,
  logInfo,
  logSuccess,
  logError,
  formatSize,
} from "../utils/ui";
import type { SendOptions, RoomState } from "../types";
import { existsSync } from "fs";
import { resolve } from "path";

export async function sendCommand(filePath: string, options: SendOptions): Promise<void> {
  const server = options.server || DEFAULT_SERVER;
  const json = options.json || false;
  let lastConnectionPath: "direct" | "relay" | "blocked" | null = null;

  // Resolve and validate file
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    logError(`File not found: ${filePath}`);
    process.exit(1);
  }

  const file = Bun.file(resolvedPath);
  const fileSize = file.size;
  const fileName = resolvedPath.split("/").pop() || "file";

  if (fileSize > FILE_SIZE_LIMIT) {
    logError(`File too large: ${formatSize(fileSize)}. Maximum is ${formatSize(FILE_SIZE_LIMIT)}.`);
    process.exit(1);
  }

  if (!json) {
    logInfo(`File: ${fileName} (${formatSize(fileSize)})`);
  }

  try {
    const session = await createRoom(server, {
      onState: (state: RoomState, detail?: string) => {
        if (json) return;
        switch (state) {
          case "waiting":
            log("Waiting for receiver...");
            break;
          case "pq_upgrade":
            logInfo("Starting post-quantum key exchange...");
            break;
          case "connected":
            logSuccess("Peer connected. PQ encryption active.");
            logInfo("Sending file...");
            break;
          case "closed":
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

    // Output connection info
    if (json) {
      outputJson({
        type: "send_ready",
        code: session.phrase,
        connectionString: session.connectionString,
        fileName,
        fileSize,
      });
    } else {
      showRoomHeader(session.phrase, session.connectionString);
    }

    // Wait for peer to connect
    await session.waitForConnection();

    // Send the file (encryption handled internally by the session)
    await session.sendFile(resolvedPath);

    if (json) {
      outputJson({ type: "complete", fileName, fileSize });
    } else {
      logSuccess("Transfer complete.");
    }

    // Give time for the last packets to flush
    await new Promise((resolve) => setTimeout(resolve, 1000));
    session.destroy();
    process.exit(0);
  } catch (err) {
    if (json) {
      outputJson({ type: "error", error: (err as Error).message });
    } else {
      logError((err as Error).message);
    }
    process.exit(1);
  }
}
