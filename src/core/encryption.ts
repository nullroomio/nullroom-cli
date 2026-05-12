/**
 * AES-GCM-256 encryption module for nullroom-cli
 *
 * Direct port of app/javascript/modules/encryption.js
 * Uses Web Crypto API (supported in Bun)
 */

import { HKDF_INFO } from "../utils/config";

/**
 * Generate an AES-GCM 256-bit key and export as Base64 string for URL fragment
 */
export async function generateKey(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  const jwk = await crypto.subtle.exportKey("jwk", key);
  const jsonString = JSON.stringify(jwk);
  return Buffer.from(jsonString).toString("base64");
}

/**
 * Import a Base64-encoded JWK key string back into a CryptoKey
 */
export async function importKey(keyString: string): Promise<CryptoKey> {
  const jsonString = Buffer.from(keyString, "base64").toString("utf-8");
  const jwk = JSON.parse(jsonString);

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt plaintext string with AES-GCM
 * @returns Base64(IV[12] || ciphertext)
 */
export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBuffer = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBuffer
  );

  const combined = new Uint8Array(iv.length + ciphertextBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertextBuffer), iv.length);

  return Buffer.from(combined).toString("base64");
}

/**
 * Decrypt Base64(IV || ciphertext) with AES-GCM
 */
export async function decrypt(encryptedString: string, key: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(Buffer.from(encryptedString, "base64"));

  const iv = bytes.slice(0, 12);
  const ciphertextBuffer = bytes.slice(12).buffer;

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertextBuffer
  );

  return new TextDecoder().decode(plaintextBuffer);
}

/**
 * Encrypt a binary ArrayBuffer with AES-GCM.
 * Returns: IV (12 bytes) || ciphertext
 * Used for per-chunk file transfer encryption.
 */
export async function encryptBuffer(buffer: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    buffer
  );

  const combined = new Uint8Array(12 + ciphertextBuffer.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertextBuffer), 12);

  return combined.buffer;
}

/**
 * Decrypt an ArrayBuffer whose first 12 bytes are the AES-GCM IV.
 */
export async function decryptBuffer(buffer: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12).buffer;

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
}

/**
 * Derive a hybrid AES-GCM 256-bit key from a classical CryptoKey and a
 * post-quantum shared secret using HKDF-SHA-256.
 *
 * HKDF(salt=classical_key_raw, ikm=quantum_secret, info="nullroom-hybrid-v1")
 */
export async function deriveHybridKey(
  classicalKey: CryptoKey,
  quantumSecret: Uint8Array
): Promise<CryptoKey> {
  // Export the classical key as raw bytes to use as HKDF salt
  const classicalRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", classicalKey)
  );

  // Import the quantum secret as HKDF key material (IKM)
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    quantumSecret.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"]
  );

  // Derive the hybrid key
  const hybridKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: classicalRaw,
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  return hybridKey;
}
