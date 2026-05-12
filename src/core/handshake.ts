/**
 * Zero-Knowledge Handshake Crypto Module for nullroom-cli
 * Ported from: nullroom/app/javascript/modules/handshake_crypto.js
 *
 * Uses a 4-word BIP-39 phrase as both:
 * - A lookup identifier (SHA-256 hash of the phrase)
 * - An encryption key (PBKDF2-derived AES-GCM 256-bit key)
 */

import { WORDLIST } from "../utils/wordlist";
import { PBKDF2_SALT, PBKDF2_ITERATIONS } from "../utils/config";
import { getAuthHeaders } from "../utils/session";

const SALT = new TextEncoder().encode(PBKDF2_SALT);

/**
 * Generate a 4-word phrase from the BIP-39 wordlist.
 * @returns Dash-separated 4-word phrase (e.g. "neon-zebra-piano-rocket")
 */
export function generatePhrase(): string {
  const indices = crypto.getRandomValues(new Uint16Array(4));
  const words = Array.from(indices, (i) => WORDLIST[i % WORDLIST.length]);
  return words.join("-");
}

/**
 * Derive an AES-GCM 256-bit key from a phrase using PBKDF2.
 */
export async function deriveKey(phrase: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(phrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Compute a SHA-256 hash of the phrase, returned as a hex string.
 * Used as the server-side key — the server never sees the phrase.
 */
export async function computeIdentifier(phrase: string): Promise<string> {
  const data = new TextEncoder().encode(phrase);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Encrypt a URL string using a key derived from the phrase.
 * Format: Base64(IV[12] || ciphertext)
 */
export async function encryptUrl(url: string, phrase: string): Promise<string> {
  const key = await deriveKey(phrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(url);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return Buffer.from(combined).toString("base64");
}

/**
 * Decrypt a Base64 blob back to the original URL using the phrase.
 */
export async function decryptUrl(base64Blob: string, phrase: string): Promise<string> {
  const key = await deriveKey(phrase);
  const combined = new Uint8Array(Buffer.from(base64Blob, "base64"));

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Orchestrator: generate a phrase, compute identifier, and encrypt the room URL.
 */
export async function createHandshake(
  roomUrl: string
): Promise<{ phrase: string; identifier: string; encryptedBlob: string }> {
  const phrase = generatePhrase();
  const [identifier, encryptedBlob] = await Promise.all([
    computeIdentifier(phrase),
    encryptUrl(roomUrl, phrase),
  ]);

  return { phrase, identifier, encryptedBlob };
}

/**
 * Publish a handshake to the server.
 * Route: POST /handshakes/:identifier
 */
export async function publishHandshake(
  serverUrl: string,
  identifier: string,
  encryptedBlob: string
): Promise<void> {
  const authHeaders = await getAuthHeaders(serverUrl);
  const res = await fetch(`${serverUrl}/handshakes/${identifier}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify({ blob: encryptedBlob }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to publish handshake: ${res.status} ${res.statusText} ${body}`);
  }
}

/**
 * Look up a handshake from the server (one-time read, deleted after).
 * Route: GET /handshakes/:identifier
 */
export async function lookupHandshake(
  serverUrl: string,
  identifier: string
): Promise<string> {
  const res = await fetch(`${serverUrl}/handshakes/${identifier}`, {
    headers: { "Accept": "application/json" },
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("Handshake not found or already used. The code may have expired.");
    }
    throw new Error(`Failed to lookup handshake: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { blob: string };
  return data.blob;
}
