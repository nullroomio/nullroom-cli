/**
 * nr receive <code> — Receive a file from a sender
 */

import { joinRoom } from "../core/room";
import { FileTransferReceiver } from "../core/file-transfer";
import { decryptBuffer } from "../core/encryption";
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

  try {
    let fileReceived = false;
    let encryptionKey: CryptoKey;

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
    });

    if (json) {
      outputJson({ type: "joined", roomId: session.connectionInfo.roomId });
    }

    // Wait for connection
    await session.waitForConnection();

    // We need to get the hybrid key from the session for decryption
    // The session handles decryption internally through its message routing,
    // but for file chunks we need the raw decryptBuffer function.
    // The file-transfer module expects raw encrypted chunks from the file data channel.

    // Set up file receiver - the hybrid key is managed internally by the room session
    // File data comes in already routed to us from the peer's file channel
    const fileCompletePromise = new Promise<FileTransferComplete>((resolveFile, rejectFile) => {
      const receiver = new FileTransferReceiver(
        async (buf) => {
          // decryptBuffer using the session's internal key
          // The session routes raw encrypted file chunks to us
          return decryptBuffer(buf, (session as any)._hybridKey || (await getSessionKey(session)));
        },
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

/**
 * Helper to get the session's current encryption key.
 * This is a workaround since the session doesn't expose the key directly.
 */
async function getSessionKey(session: any): Promise<CryptoKey> {
  // The key is managed internally by the room module.
  // For the receive command, decryption happens through the session's
  // internal routing. This function exists as a fallback.
  throw new Error("Session key not accessible - file decryption should be handled by the session");
}
