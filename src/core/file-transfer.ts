/**
 * P2P File Transfer module for nullroom-cli
 *
 * Handles chunked, per-chunk AES-GCM encrypted file send/receive
 * over a dedicated WebRTC DataChannel ("nullroom-files").
 *
 * Files never touch the server — zero-trace preserved.
 *
 * Ported from app/javascript/modules/file_transfer.js
 */

import { CHUNK_SIZE, FILE_SIZE_LIMIT, MAX_BUFFER } from "../utils/config";
import type { FileMetadata, FileTransferComplete } from "../types";

const MAX_FILE_NAME_LENGTH = 255;
const MAX_TOTAL_CHUNKS = Math.ceil(FILE_SIZE_LIMIT / CHUNK_SIZE);
const SAFE_MIME_FALLBACK = "application/octet-stream";
const DISPLAYABLE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

function normalizeFileName(value: unknown): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();

  return (normalized || "download").slice(0, MAX_FILE_NAME_LENGTH);
}

function normalizeFileSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > FILE_SIZE_LIMIT) return 0;
  return Math.floor(parsed);
}

function normalizeMimeType(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return DISPLAYABLE_MIME_TYPES.has(normalized) ? normalized : SAFE_MIME_FALLBACK;
}

function normalizeTotalChunks(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TOTAL_CHUNKS) return 0;
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// FileTransferSender
// ─────────────────────────────────────────────────────────────────────────────

export interface FileSenderPeer {
  sendFile(data: ArrayBuffer | Buffer): void;
  send(data: string): void;
  getFileBufferedAmount(): number;
}

/**
 * Sends a single file over a WebRTC DataChannel in encrypted 64 KB chunks.
 */
export class FileTransferSender {
  private peer: FileSenderPeer;
  private encryptFn: (buffer: ArrayBuffer) => Promise<ArrayBuffer>;
  private onProgress: (name: string, percent: number) => void;
  private onError: (message: string) => void;
  private _sending: boolean = false;

  constructor(
    peer: FileSenderPeer,
    encryptFn: (buffer: ArrayBuffer) => Promise<ArrayBuffer>,
    onProgress: (name: string, percent: number) => void,
    onError: (message: string) => void
  ) {
    this.peer = peer;
    this.encryptFn = encryptFn;
    this.onProgress = onProgress;
    this.onError = onError;
  }

  /**
   * Send a file from disk using Bun.file() streaming.
   */
  async sendFromPath(filePath: string): Promise<void> {
    if (this._sending) {
      this.onError("A file transfer is already in progress.");
      return;
    }

    const file = Bun.file(filePath);
    const size = file.size;
    const name = filePath.split("/").pop() || "file";
    const mimeType = file.type || "application/octet-stream";

    if (size > FILE_SIZE_LIMIT) {
      this.onError(
        `File too large: ${(size / (1024 * 1024)).toFixed(1)} MB. Maximum is ${FILE_SIZE_LIMIT / (1024 * 1024)} MB.`
      );
      return;
    }

    this._sending = true;
    const transferId = crypto.randomUUID();
    const totalChunks = Math.ceil(size / CHUNK_SIZE);

    // 1. Send metadata header
    this.peer.send(
      JSON.stringify({
        type: "file-start",
        transferId,
        name,
        size,
        totalChunks,
        mimeType,
      })
    );

    // 2. Stream and send encrypted chunks
    try {
      const stream = file.stream();
      const reader = stream.getReader();
      let chunkIndex = 0;
      let leftover = new Uint8Array(0);

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Send any remaining leftover
          if (leftover.length > 0) {
            const encrypted = await this.encryptFn(leftover.buffer);
            await this._waitForBuffer();
            this.peer.sendFile(encrypted);
            chunkIndex++;
            this.onProgress(name, Math.round((chunkIndex / totalChunks) * 100));
          }
          break;
        }

        // Combine leftover with new data
        const combined = new Uint8Array(leftover.length + value.length);
        combined.set(leftover);
        combined.set(value, leftover.length);

        // Send complete chunks
        let offset = 0;
        while (offset + CHUNK_SIZE <= combined.length) {
          const chunk = combined.slice(offset, offset + CHUNK_SIZE);
          const encrypted = await this.encryptFn(chunk.buffer);
          await this._waitForBuffer();
          this.peer.sendFile(encrypted);
          offset += CHUNK_SIZE;
          chunkIndex++;
          this.onProgress(name, Math.round((chunkIndex / totalChunks) * 100));
        }

        // Save leftover for next iteration
        leftover = combined.slice(offset);
      }

      // 3. Send end sentinel
      this.peer.send(JSON.stringify({ type: "file-end", transferId }));
    } catch (err) {
      this.onError(`File transfer failed: ${err}`);
    } finally {
      this._sending = false;
    }
  }

  /**
   * Send from a buffer (for pipe mode).
   */
  async sendFromBuffer(buffer: ArrayBuffer, name: string = "pipe-data"): Promise<void> {
    if (this._sending) {
      this.onError("A file transfer is already in progress.");
      return;
    }

    const size = buffer.byteLength;
    this._sending = true;
    const transferId = crypto.randomUUID();
    const totalChunks = Math.ceil(size / CHUNK_SIZE);

    // Send metadata
    this.peer.send(
      JSON.stringify({
        type: "file-start",
        transferId,
        name,
        size,
        totalChunks,
        mimeType: "application/octet-stream",
      })
    );

    // Send chunks
    try {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const chunk = buffer.slice(start, start + CHUNK_SIZE);
        const encrypted = await this.encryptFn(chunk);
        await this._waitForBuffer();
        this.peer.sendFile(encrypted);
        this.onProgress(name, Math.round(((i + 1) / totalChunks) * 100));
      }

      this.peer.send(JSON.stringify({ type: "file-end", transferId }));
    } catch (err) {
      this.onError(`File transfer failed: ${err}`);
    } finally {
      this._sending = false;
    }
  }

  private async _waitForBuffer(): Promise<void> {
    while (this.peer.getFileBufferedAmount() > MAX_BUFFER) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FileTransferReceiver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Receives chunked encrypted file data and reassembles it.
 */
export class FileTransferReceiver {
  private decryptFn: (buffer: ArrayBuffer) => Promise<ArrayBuffer>;
  private onProgress: (name: string, percent: number) => void;
  private onComplete: (info: FileTransferComplete) => void;
  private outputDir: string;

  private _meta: {
    transferId: string;
    name: string;
    size: number;
    totalChunks: number;
    mimeType: string;
  } | null = null;
  private _chunks: (ArrayBuffer | null)[] = [];
  private _nextIndex: number = 0;
  private _received: number = 0;
  private _pendingDecrypts: number = 0;
  private _endReceived: boolean = false;

  constructor(
    decryptFn: (buffer: ArrayBuffer) => Promise<ArrayBuffer>,
    onProgress: (name: string, percent: number) => void,
    onComplete: (info: FileTransferComplete) => void,
    outputDir: string = "."
  ) {
    this.decryptFn = decryptFn;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.outputDir = outputDir;
  }

  private _reset(): void {
    this._meta = null;
    this._chunks = [];
    this._nextIndex = 0;
    this._received = 0;
    this._pendingDecrypts = 0;
    this._endReceived = false;
  }

  /**
   * Handle a control message (JSON string from data channel).
   * Returns true if it was a file transfer control message.
   */
  handleControlMessage(data: string): boolean {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return false;
    }

    if (msg.type === "file-start") {
      this._reset();
      const totalChunks = normalizeTotalChunks(msg.totalChunks);
      if (!totalChunks) {
        this._reset();
        return true;
      }

      this._meta = {
        transferId: String(msg.transferId || ""),
        name: normalizeFileName(msg.name),
        size: normalizeFileSize(msg.size),
        totalChunks,
        mimeType: normalizeMimeType(msg.mimeType),
      };
      this._chunks = new Array(totalChunks).fill(null);
      return true;
    } else if (msg.type === "file-end") {
      this._endReceived = true;
      this._tryAssemble();
      return true;
    }

    return false;
  }

  /**
   * Handle an incoming binary chunk from the file data channel.
   */
  async handleChunk(data: ArrayBuffer): Promise<void> {
    if (!this._meta) return;

    const myIndex = this._nextIndex++;
    if (myIndex >= this._meta.totalChunks) return;
    this._pendingDecrypts++;

    try {
      const decrypted = await this.decryptFn(data);
      this._chunks[myIndex] = decrypted;
      this._received++;

      const percent = Math.round((this._received / this._meta.totalChunks) * 100);
      this.onProgress(this._meta.name, percent);
    } catch (err) {
      // Chunk decrypt error - slot remains null
    } finally {
      this._pendingDecrypts--;
      this._tryAssemble();
    }
  }

  private _tryAssemble(): void {
    if (this._endReceived && this._pendingDecrypts === 0 && this._meta) {
      this._assemble();
    }
  }

  private async _assemble(): Promise<void> {
    if (!this._meta || this._chunks.length === 0) return;

    // Filter out any unfilled slots
    const safeChunks = this._chunks.filter(Boolean) as ArrayBuffer[];

    // Combine all chunks
    const totalSize = safeChunks.reduce((sum, c) => sum + c.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of safeChunks) {
      combined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    // Write to disk
    const outputPath = `${this.outputDir}/${this._meta.name}`;
    await Bun.write(outputPath, combined);

    this.onComplete({
      name: this._meta.name,
      size: combined.length,
      mimeType: this._meta.mimeType,
      outputPath,
    });

    this._reset();
  }
}
