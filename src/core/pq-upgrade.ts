/**
 * Post-Quantum Upgrade Module for nullroom-cli
 *
 * Performs an ML-KEM-768 key exchange over the WebRTC data channel,
 * then fuses the quantum shared secret with the classical URL key via
 * HKDF to produce a hybrid session key.
 *
 * Protocol (3 messages):
 *   1. Initiator → Responder: {type: "pq-pubkey", data: "<base64-pk>"}
 *   2. Responder → Initiator: {type: "pq-encap", data: "<base64-ct>", confirm: "<base64-hmac>"}
 *   3. Initiator → Responder: {type: "pq-confirm", data: "<base64-hmac>"}
 *
 * Both sides switch to K_H only after mutual HMAC verification.
 *
 * Ported from app/javascript/modules/pq_upgrade.js
 */

import { createMlKem768 } from "mlkem";
import { deriveHybridKey } from "./encryption";
import {
  PQ_TIMEOUT_MS,
  CONFIRM_LABEL_RESPONDER,
  CONFIRM_LABEL_INITIATOR,
} from "../utils/config";
import type { PQMessage } from "../types";

/**
 * Encode a Uint8Array to Base64 string.
 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Decode a Base64 string to Uint8Array.
 */
function fromBase64(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64"));
}

/**
 * Compute HMAC-SHA-256 for key confirmation.
 */
async function computeConfirmHmac(
  sharedSecret: Uint8Array,
  label: string
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    sharedSecret.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(label)
  );
  return new Uint8Array(sig);
}

/**
 * Verify an HMAC-SHA-256 confirmation.
 */
async function verifyConfirmHmac(
  sharedSecret: Uint8Array,
  label: string,
  received: Uint8Array
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    sharedSecret.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    received.buffer as ArrayBuffer,
    new TextEncoder().encode(label)
  );
}

/**
 * Interface for the peer send function.
 * The peer must be able to send strings over the data channel.
 */
export interface PQPeer {
  send(data: string): void;
}

/**
 * Perform the post-quantum key upgrade.
 *
 * @param sendFn Function to send a string over the data channel
 * @param classicalKey The AES-GCM key from the URL fragment
 * @param isInitiator Whether this peer is the connection initiator
 * @param onProgress Optional progress callback
 * @returns The hybrid AES-GCM key (K_H)
 */
export async function performPQUpgrade(
  sendFn: (data: string) => void,
  classicalKey: CryptoKey,
  isInitiator: boolean,
  onProgress?: (msg: string) => void
): Promise<{ hybridKey: CryptoKey; messageHandler: (msg: string) => Promise<boolean> }> {
  const progress = onProgress || (() => {});

  // Initialize ML-KEM-768
  const mlkem = await createMlKem768();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Post-quantum upgrade timed out"));
    }, PQ_TIMEOUT_MS);

    let secretKey: Uint8Array | null = null;
    let pqSharedSecret: Uint8Array | null = null;

    /**
     * Message handler - returns true if the message was consumed as a PQ message.
     */
    const messageHandler = async (msgStr: string): Promise<boolean> => {
      try {
        const msg: PQMessage = JSON.parse(msgStr);
        if (!msg.type || !msg.type.startsWith("pq-")) return false;
        await processMessage(msg);
        return true;
      } catch {
        return false;
      }
    };

    async function processMessage(msg: PQMessage): Promise<void> {
      if (isInitiator) {
        await handleInitiatorMessage(msg);
      } else {
        await handleResponderMessage(msg);
      }
    }

    // ── Initiator Flow ──────────────────────────────────────────────

    async function runInitiator(): Promise<void> {
      const [pk, sk] = mlkem.generateKeyPair();
      secretKey = sk;
      progress("Exchanging ML-KEM-768 public shares...");
      sendFn(JSON.stringify({ type: "pq-pubkey", data: toBase64(pk) }));
    }

    async function handleInitiatorMessage(msg: PQMessage): Promise<void> {
      if (msg.type === "pq-encap") {
        const ciphertext = fromBase64(msg.data);
        const responderHmac = fromBase64(msg.confirm!);

        if (!secretKey) {
          clearTimeout(timeout);
          reject(new Error("PQ: No secret key available"));
          return;
        }

        // Decapsulate to get shared secret
        const sharedSecret = mlkem.decap(ciphertext, secretKey);
        secretKey = null;

        // Verify responder's HMAC
        const valid = await verifyConfirmHmac(
          sharedSecret,
          CONFIRM_LABEL_RESPONDER,
          responderHmac
        );
        if (!valid) {
          clearTimeout(timeout);
          reject(new Error("Post-quantum confirmation failed: responder HMAC invalid"));
          return;
        }

        progress("Verifying mutual HMAC integrity...");

        // Send our confirmation HMAC
        const initiatorHmac = await computeConfirmHmac(
          sharedSecret,
          CONFIRM_LABEL_INITIATOR
        );
        sendFn(JSON.stringify({ type: "pq-confirm", data: toBase64(initiatorHmac) }));

        // Derive hybrid key
        progress("Deriving PQ session keys [HKDF-SHA-256]...");
        const hybridKey = await deriveHybridKey(classicalKey, sharedSecret);
        clearTimeout(timeout);
        resolve({ hybridKey, messageHandler });
      }
    }

    // ── Responder Flow ──────────────────────────────────────────────

    async function handleResponderMessage(msg: PQMessage): Promise<void> {
      if (msg.type === "pq-pubkey") {
        const publicKey = fromBase64(msg.data);
        progress("Exchanging ML-KEM-768 public shares...");

        // Encapsulate to produce ciphertext + shared secret
        const [ct, ss] = mlkem.encap(publicKey);
        pqSharedSecret = ss;

        // Compute our confirmation HMAC
        const responderHmac = await computeConfirmHmac(ss, CONFIRM_LABEL_RESPONDER);

        // Send encapsulated ciphertext + our confirmation in one message
        sendFn(
          JSON.stringify({
            type: "pq-encap",
            data: toBase64(ct),
            confirm: toBase64(responderHmac),
          })
        );
      } else if (msg.type === "pq-confirm") {
        const initiatorHmac = fromBase64(msg.data);

        if (!pqSharedSecret) {
          clearTimeout(timeout);
          reject(new Error("PQ: No shared secret available"));
          return;
        }

        const sharedSecret = pqSharedSecret;
        pqSharedSecret = null;

        // Verify initiator's HMAC
        const valid = await verifyConfirmHmac(
          sharedSecret,
          CONFIRM_LABEL_INITIATOR,
          initiatorHmac
        );
        if (!valid) {
          clearTimeout(timeout);
          reject(new Error("Post-quantum confirmation failed: initiator HMAC invalid"));
          return;
        }

        progress("Verifying mutual HMAC integrity...");

        // Derive hybrid key
        progress("Deriving PQ session keys [HKDF-SHA-256]...");
        const hybridKey = await deriveHybridKey(classicalKey, sharedSecret);
        clearTimeout(timeout);
        resolve({ hybridKey, messageHandler });
      }
    }

    // Start the protocol
    if (isInitiator) {
      runInitiator().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    }
  });
}
