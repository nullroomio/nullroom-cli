/**
 * nr receive <code> — Receive a file from a sender
 */

import { joinRoom } from "../core/room";
import { FileTransferReceiver } from "../core/file-transfer";
import { DEFAULT_SERVER } from "../utils/config";
import {
  outputJson,
  showProgress,
  log,
  logInfo,
  logSuccess,
  logError,
  formatSize,
} from "../utils/ui";
import type { ReceiveOptions, RoomState, FileTransferComplete } from "../types";
import { resolve } from "path";

export async function receiveCommand(code: string, options: ReceiveOptions): Promise<void> {
  const server = options.server || DEFAULT_SERVER;
  const json = options.json || false;
  const outputDir = resolve(options.output || ".");
  let lastConnectionPath: "direct" | "relay" | "blocked" | null = null;

  try {
    let fileReceived = false;

    const session = await joinRoom(code, server, {
      onState: (state: RoomState, detail?: string) => {
        if (json) return;
        switch (state) {
          case "connecting":
            logInfo("Looking up room...");
            break;
          case "waiting":
            log("Connecting to sender...");
            break;
          case "pq_upgrade":
            logInfo("Starting post-quantum key exchange...");
            break;
          case "connected":
            logSuccess("Connected. PQ encryption active.");
            log("Waiting for file...");
            break;
          case "closed":
            if (!fileReceived) {
              log("Session ended before file was received.");
            }
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

    // Wait for connection
    await session.waitForConnection();

    // Set up file receiver using the session's decrypt method
    const fileCompletePromise = new Promise<FileTransferComplete>((resolveFile, rejectFile) => {
      const receiver = new FileTransferReceiver(
        (buf) => session.decryptFileChunk(buf),
        (name, percent) => {
          if (json) {
            outputJson({ type: "progress", name, percent });
          } else {
            showProgress(name, percent);
          }
        },
        (info) => {
          fileReceived = true;
          resolveFile(info);
        },
        outputDir
      );

      // Route file data channel messages to receiver
      session.onFileData((data: ArrayBuffer) => {
        receiver.handleChunk(data);
      });

      // Route control messages (file-start/file-end) to receiver
      session.onControlMessage((msg: string) => {
        return receiver.handleControlMessage(msg);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (!fileReceived) {
          rejectFile(new Error("File receive timed out"));
        }
      }, 300_000);
    });

    const result = await fileCompletePromise;

    if (json) {
      outputJson({
        type: "complete",
        name: result.name,
        size: result.size,
        outputPath: result.outputPath,
      });
    } else {
      logSuccess(`Saved to ${result.outputPath} (${formatSize(result.size)})`);
    }

    // Clean up
    await new Promise((resolve) => setTimeout(resolve, 500));
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
