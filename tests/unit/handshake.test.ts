import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  generatePhrase,
  deriveKey,
  computeIdentifier,
  encryptUrl,
  decryptUrl,
  createHandshake,
  publishHandshake,
  lookupHandshake,
} from "../../src/core/handshake";
import { resetSessionCache } from "../../src/utils/session";

// ── generatePhrase ──────────────────────────────────────────────────────────

describe("generatePhrase", () => {
  test("returns 4 lowercase words separated by dashes", () => {
    const phrase = generatePhrase();
    const parts = phrase.split("-");
    expect(parts).toHaveLength(4);
    for (const part of parts) {
      expect(part).toMatch(/^[a-z]+$/);
    }
  });

  test("generates different phrases on each call", () => {
    const phrases = new Set(Array.from({ length: 10 }, () => generatePhrase()));
    // With 2048^4 combinations, collisions in 10 tries are essentially impossible
    expect(phrases.size).toBeGreaterThan(1);
  });
});

// ── computeIdentifier ───────────────────────────────────────────────────────

describe("computeIdentifier", () => {
  test("returns a 64-character hex string (SHA-256)", async () => {
    const id = await computeIdentifier("test-phrase-one-two");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same phrase", async () => {
    const a = await computeIdentifier("alpha-bravo-charlie-delta");
    const b = await computeIdentifier("alpha-bravo-charlie-delta");
    expect(a).toBe(b);
  });

  test("produces different identifiers for different phrases", async () => {
    const a = await computeIdentifier("alpha-bravo-charlie-delta");
    const b = await computeIdentifier("echo-foxtrot-golf-hotel");
    expect(a).not.toBe(b);
  });
});

// ── deriveKey ───────────────────────────────────────────────────────────────

describe("deriveKey", () => {
  test("returns a CryptoKey with AES-GCM algorithm", async () => {
    const key = await deriveKey("test-phrase-one-two");
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  test("derived keys are usable for encrypt and decrypt", async () => {
    const key = await deriveKey("test-phrase-one-two");
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  test("same phrase produces functionally equivalent keys", async () => {
    const key1 = await deriveKey("same-phrase-same-key");
    const key2 = await deriveKey("same-phrase-same-key");

    // Both keys should be able to decrypt something encrypted by the other
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("test data");
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key1,
      plaintext
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key2,
      ciphertext
    );
    expect(new TextDecoder().decode(decrypted)).toBe("test data");
  });
});

// ── encryptUrl / decryptUrl ─────────────────────────────────────────────────

describe("encryptUrl / decryptUrl", () => {
  test("round-trips a URL through encrypt and decrypt", async () => {
    const phrase = "test-phrase-round-trip";
    const url = "https://www.nullroom.io/rooms/abc-123#secret-key";

    const encrypted = await encryptUrl(url, phrase);
    const decrypted = await decryptUrl(encrypted, phrase);

    expect(decrypted).toBe(url);
  });

  test("encrypted blob is a valid base64 string", async () => {
    const encrypted = await encryptUrl("https://example.com", "test-phrase-one-two");
    // Should not throw when decoded as base64
    expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    expect(encrypted.length).toBeGreaterThan(0);
  });

  test("different phrases produce different ciphertexts", async () => {
    const url = "https://example.com/room/123#key";
    const a = await encryptUrl(url, "phrase-alpha-beta-gamma");
    const b = await encryptUrl(url, "phrase-delta-echo-foxtrot");
    expect(a).not.toBe(b);
  });

  test("wrong phrase fails to decrypt", async () => {
    const encrypted = await encryptUrl("https://example.com", "correct-phrase-one-two");
    await expect(decryptUrl(encrypted, "wrong-phrase-one-two")).rejects.toThrow();
  });

  test("handles long URLs", async () => {
    const phrase = "test-long-url-works";
    const url = "https://www.nullroom.io/rooms/550e8400-e29b-41d4-a716-446655440000#" + "a".repeat(200);
    const decrypted = await decryptUrl(await encryptUrl(url, phrase), phrase);
    expect(decrypted).toBe(url);
  });
});

// ── createHandshake ─────────────────────────────────────────────────────────

describe("createHandshake", () => {
  test("returns phrase, identifier, and encrypted blob", async () => {
    const result = await createHandshake("https://example.com/rooms/abc#key");
    expect(result.phrase.split("-")).toHaveLength(4);
    expect(result.identifier).toMatch(/^[0-9a-f]{64}$/);
    expect(result.encryptedBlob.length).toBeGreaterThan(0);
  });

  test("encrypted blob can be decrypted with the returned phrase", async () => {
    const url = "https://www.nullroom.io/rooms/test-id#my-key";
    const { phrase, encryptedBlob } = await createHandshake(url);
    const decrypted = await decryptUrl(encryptedBlob, phrase);
    expect(decrypted).toBe(url);
  });

  test("identifier matches computeIdentifier of the phrase", async () => {
    const { phrase, identifier } = await createHandshake("https://example.com/rooms/x#k");
    const expected = await computeIdentifier(phrase);
    expect(identifier).toBe(expected);
  });
});

// ── publishHandshake (mocked fetch) ─────────────────────────────────────────

describe("publishHandshake", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionCache();
  });

  test("POSTs to /handshakes/:identifier with blob in body", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedMethod = "";

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      // First call may be to get CSRF token
      if (typeof url === "string" && url.endsWith("/")) {
        return new Response(
          '<meta name="csrf-token" content="test-csrf-token" />',
          {
            headers: {
              "content-type": "text/html",
              "set-cookie": "_session=abc123; path=/",
            },
          }
        );
      }

      capturedUrl = url as string;
      capturedMethod = init?.method || "GET";
      capturedBody = init?.body as string;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await publishHandshake("https://example.com", "abc123identifier", "encrypted-blob");

    expect(capturedUrl).toBe("https://example.com/handshakes/abc123identifier");
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual({ blob: "encrypted-blob" });
  });

  test("includes CSRF token in headers", async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/")) {
        return new Response(
          '<meta name="csrf-token" content="my-csrf-token" />',
          {
            headers: {
              "content-type": "text/html",
              "set-cookie": "_session=xyz; path=/",
            },
          }
        );
      }

      const headers = init?.headers as Record<string, string> | undefined;
      capturedHeaders = { ...headers };
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    await publishHandshake("https://example.com", "id123", "blob");

    expect(capturedHeaders["X-CSRF-Token"]).toBe("my-csrf-token");
  });

  test("throws on non-ok response", async () => {
    globalThis.fetch = (async (url: string) => {
      if (typeof url === "string" && url.endsWith("/")) {
        return new Response('<meta name="csrf-token" content="tok" />', {
          headers: { "set-cookie": "_s=x" },
        });
      }
      return new Response("Server error", { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;

    await expect(
      publishHandshake("https://example.com", "id", "blob")
    ).rejects.toThrow("Failed to publish handshake");
  });
});

// ── lookupHandshake (mocked fetch) ──────────────────────────────────────────

describe("lookupHandshake", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GETs /handshakes/:identifier and returns the blob", async () => {
    let capturedUrl = "";

    globalThis.fetch = (async (url: string) => {
      capturedUrl = url as string;
      return Response.json({ blob: "the-encrypted-blob" });
    }) as typeof fetch;

    const result = await lookupHandshake("https://example.com", "my-identifier");

    expect(capturedUrl).toBe("https://example.com/handshakes/my-identifier");
    expect(result).toBe("the-encrypted-blob");
  });

  test("throws descriptive error on 404", async () => {
    globalThis.fetch = (async () => {
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(
      lookupHandshake("https://example.com", "missing")
    ).rejects.toThrow("Handshake not found or already used");
  });

  test("throws on other error status", async () => {
    globalThis.fetch = (async () => {
      return new Response(null, { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;

    await expect(
      lookupHandshake("https://example.com", "id")
    ).rejects.toThrow("Failed to lookup handshake");
  });
});
