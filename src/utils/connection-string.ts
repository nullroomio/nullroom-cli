/**
 * Connection string encoding/decoding for nullroom-cli
 *
 * Supports two formats:
 * - 4-word phrase: "neon-zebra-piano-rocket" (human-friendly, uses server handshake)
 * - Raw connection string: "nr://base64url@host" (agent-friendly, direct)
 */

import type { ConnectionInfo } from "../types";
import { DEFAULT_SERVER } from "./config";

/**
 * Encode room connection info into a compact connection string.
 * Format: nr://<base64url(roomId:key)>@<host>
 */
export function encodeConnectionString(info: ConnectionInfo): string {
  const payload = `${info.roomId}:${info.key}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const host = new URL(info.server).host;
  return `nr://${encoded}@${host}`;
}

/**
 * Decode a connection string back into connection info.
 */
export function decodeConnectionString(str: string): ConnectionInfo {
  // Remove the "nr://" prefix
  const withoutPrefix = str.replace(/^nr:\/\//, "");

  // Split on @ to get payload and host
  const atIndex = withoutPrefix.lastIndexOf("@");
  if (atIndex === -1) {
    throw new Error("Invalid connection string: missing @host");
  }

  const encoded = withoutPrefix.slice(0, atIndex);
  const host = withoutPrefix.slice(atIndex + 1);

  // Decode the payload
  const payload = Buffer.from(encoded, "base64url").toString("utf-8");
  const colonIndex = payload.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid connection string: missing room_id:key separator");
  }

  const roomId = payload.slice(0, colonIndex);
  const key = payload.slice(colonIndex + 1);

  // Reconstruct server URL (assume https)
  const server = `https://${host}`;

  return { roomId, key, server };
}

/**
 * Detect whether a string is a connection string or a 4-word phrase.
 */
export function isConnectionString(input: string): boolean {
  return input.startsWith("nr://");
}

/**
 * Detect whether a string is a 4-word BIP-39 phrase.
 * Pattern: word-word-word-word (4 lowercase words separated by dashes)
 */
export function isPhrase(input: string): boolean {
  const parts = input.split("-");
  return parts.length === 4 && parts.every((p) => /^[a-z]+$/.test(p));
}

/**
 * Parse any connection input (phrase or connection string).
 * For phrases, we need to look up the handshake from the server — this just
 * validates the format and returns the type.
 */
export function parseConnectionInput(input: string): {
  type: "phrase" | "connection_string";
  value: string;
} {
  if (isConnectionString(input)) {
    return { type: "connection_string", value: input };
  }
  if (isPhrase(input)) {
    return { type: "phrase", value: input };
  }
  throw new Error(
    `Invalid connection input: "${input}". Expected a 4-word phrase (e.g., "word-word-word-word") or a connection string (e.g., "nr://...")`
  );
}
