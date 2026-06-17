/**
 * Unit tests for FileTransferReceiver size-limit enforcement (zero-trace hardening).
 *
 * Verifies the receiver actually bounds memory rather than just displaying a limit:
 *  - rejects a transfer whose declared chunk count alone exceeds the limit
 *  - aborts mid-stream when bytes ACTUALLY received exceed the limit (a peer that
 *    lies about size/totalChunks or sends oversized frames)
 *  - still completes a normal in-memory transfer
 *
 * Ported from: nullroom/test/javascript/file_transfer_test.mjs
 */

import { test, expect, afterAll } from "bun:test";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { FileTransferReceiver } from "../../src/core/file-transfer";
import type { FileTransferComplete } from "../../src/types";

const CHUNK_SIZE = 65_536;
const identityDecrypt = async (buf: ArrayBuffer) => buf;

const outDir = mkdtempSync(join(tmpdir(), "nr-filetransfer-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function fileStart({
  size,
  totalChunks,
  name = "f.bin",
}: {
  size: number;
  totalChunks: number;
  name?: string;
}): string {
  return JSON.stringify({
    type: "file-start",
    transferId: "t",
    name,
    size,
    totalChunks,
    mimeType: "application/octet-stream",
  });
}

test("rejects a file-start whose declared chunk count exceeds the limit", async () => {
  const errors: string[] = [];
  let completed = false;
  const r = new FileTransferReceiver(
    identityDecrypt,
    () => {},
    () => {
      completed = true;
    },
    outDir,
    (msg) => errors.push(msg)
  );
  r.setFileSizeLimit(200_000); // ~3 chunks worth

  // 1000 chunks * 64 KB ≫ 200 KB → must be refused up front, buffering nothing.
  r.handleControlMessage(fileStart({ size: 10_000_000, totalChunks: 1000 }));

  expect(completed).toBe(false);
  expect(errors.length).toBe(1);
  expect(errors[0]).toMatch(/exceeds/i);
});

test("aborts mid-stream when received bytes exceed the limit (lying peer)", async () => {
  const errors: string[] = [];
  let completed = false;
  const r = new FileTransferReceiver(
    identityDecrypt,
    () => {},
    () => {
      completed = true;
    },
    outDir,
    (msg) => errors.push(msg)
  );
  r.setFileSizeLimit(200_000);

  // Declares only 2 chunks (passes the up-front guard) but each frame is oversized.
  r.handleControlMessage(fileStart({ size: 100_000, totalChunks: 2 }));
  await r.handleChunk(new ArrayBuffer(150_000)); // cumulative 150 KB — ok
  await r.handleChunk(new ArrayBuffer(150_000)); // cumulative 300 KB — overflow → abort

  expect(completed).toBe(false);
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]).toMatch(/exceeds/i);
});

test("completes a normal in-memory transfer within the limit", async () => {
  let received: FileTransferComplete | null = null;
  const r = new FileTransferReceiver(
    identityDecrypt,
    () => {},
    (file) => {
      received = file;
    },
    outDir,
    () => {}
  );
  r.setFileSizeLimit(10 * CHUNK_SIZE);

  r.handleControlMessage(fileStart({ size: 100, totalChunks: 2, name: "ok.bin" }));
  await r.handleChunk(new ArrayBuffer(50));
  await r.handleChunk(new ArrayBuffer(50));
  r.handleControlMessage(JSON.stringify({ type: "file-end", transferId: "t" }));

  // _assemble() writes to disk asynchronously before firing onComplete.
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(received).not.toBeNull();
  expect(received!.name).toBe("ok.bin");
});
