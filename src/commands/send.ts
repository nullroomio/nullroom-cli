/**
 * nr send <file> — One-shot encrypted file transfer
 */

import { createRoom } from "../core/room";
import { FileTransferSender } from "../core/file-transfer";
import { encryptBuffer } from "../core/encryption";
import { DEFAULT_SERVER, FILE_SIZE_LIMIT } from "../utils/config";
import {
  showRoomHeader,
  outputJson,
  showProgress,
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

    // Send the file
    const sender = new FileTransferSender(
      {
        sendFile: (data) => {
          // We need to access the peer's sendFile directly
          // The session exposes sendFile for this purpose
        },
        send: (data) => {},
        getFileBufferedAmount: () => 0,
      },
      async (buf) => encryptBuffer(buf, session.connectionInfo as any),
      (name, percent) => {
        if (json) {
          outputJson({ type: "progress", name, percent });
        } else {
          showProgress(name, percent);
        }
      },
      (errMsg) => {
        if (json) {
          outputJson({ type: "error", error: errMsg });
        } else {
          logError(errMsg);
        }
      }
    );

    // Use the session's sendFile method which handles encryption internally
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
