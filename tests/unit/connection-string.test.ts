import { describe, test, expect } from "bun:test";
import {
  encodeConnectionString,
  decodeConnectionString,
  isConnectionString,
  isPhrase,
  parseConnectionInput,
} from "../../src/utils/connection-string";
import type { ConnectionInfo } from "../../src/types";

// ── encodeConnectionString / decodeConnectionString ─────────────────────────

describe("encodeConnectionString / decodeConnectionString", () => {
  test("round-trips a standard connection info", () => {
    const info: ConnectionInfo = {
      roomId: "abc-123-def-456",
      key: "my-secret-key-here",
      server: "https://www.nullroom.io",
    };
    const encoded = encodeConnectionString(info);
    const decoded = decodeConnectionString(encoded);

    expect(decoded.roomId).toBe(info.roomId);
    expect(decoded.key).toBe(info.key);
    expect(decoded.server).toBe(info.server);
  });

  test("encoded string starts with nr://", () => {
    const info: ConnectionInfo = {
      roomId: "room-id",
      key: "key",
      server: "https://example.com",
    };
    expect(encodeConnectionString(info)).toStartWith("nr://");
  });

  test("encoded string contains the host after @", () => {
    const info: ConnectionInfo = {
      roomId: "room-id",
      key: "key",
      server: "https://www.nullroom.io",
    };
    const encoded = encodeConnectionString(info);
    expect(encoded).toEndWith("@www.nullroom.io");
  });

  test("round-trips with special characters in key", () => {
    const info: ConnectionInfo = {
      roomId: "550e8400-e29b-41d4-a716-446655440000",
      key: "aB3+/=zZyY0123456789",
      server: "https://www.nullroom.io",
    };
    const decoded = decodeConnectionString(encodeConnectionString(info));
    expect(decoded.roomId).toBe(info.roomId);
    expect(decoded.key).toBe(info.key);
  });

  test("round-trips with a custom server", () => {
    const info: ConnectionInfo = {
      roomId: "room1",
      key: "key1",
      server: "https://custom.server.dev",
    };
    const decoded = decodeConnectionString(encodeConnectionString(info));
    expect(decoded.server).toBe("https://custom.server.dev");
  });

  test("throws on missing @host", () => {
    expect(() => decodeConnectionString("nr://abc123")).toThrow("missing @host");
  });

  test("throws on missing room_id:key separator", () => {
    // Encode a payload with no colon
    const badPayload = Buffer.from("nocolon").toString("base64url");
    expect(() => decodeConnectionString(`nr://${badPayload}@host.com`)).toThrow(
      "missing room_id:key separator"
    );
  });
});

// ── isConnectionString ──────────────────────────────────────────────────────

describe("isConnectionString", () => {
  test("returns true for nr:// prefix", () => {
    expect(isConnectionString("nr://abc@host")).toBe(true);
  });

  test("returns false for a phrase", () => {
    expect(isConnectionString("alpha-bravo-charlie-delta")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isConnectionString("")).toBe(false);
  });

  test("returns false for other URLs", () => {
    expect(isConnectionString("https://example.com")).toBe(false);
  });
});

// ── isPhrase ────────────────────────────────────────────────────────────────

describe("isPhrase", () => {
  test("returns true for valid 4-word phrase", () => {
    expect(isPhrase("alpha-bravo-charlie-delta")).toBe(true);
  });

  test("returns false for 3 words", () => {
    expect(isPhrase("alpha-bravo-charlie")).toBe(false);
  });

  test("returns false for 5 words", () => {
    expect(isPhrase("alpha-bravo-charlie-delta-echo")).toBe(false);
  });

  test("returns false for uppercase words", () => {
    expect(isPhrase("Alpha-bravo-charlie-delta")).toBe(false);
  });

  test("returns false for words with numbers", () => {
    expect(isPhrase("alpha-bravo-charlie-delta1")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isPhrase("")).toBe(false);
  });

  test("returns false for connection string", () => {
    expect(isPhrase("nr://abc@host")).toBe(false);
  });
});

// ── parseConnectionInput ────────────────────────────────────────────────────

describe("parseConnectionInput", () => {
  test("parses a phrase as type 'phrase'", () => {
    const result = parseConnectionInput("alpha-bravo-charlie-delta");
    expect(result.type).toBe("phrase");
    expect(result.value).toBe("alpha-bravo-charlie-delta");
  });

  test("parses a connection string as type 'connection_string'", () => {
    const result = parseConnectionInput("nr://abc@host.com");
    expect(result.type).toBe("connection_string");
    expect(result.value).toBe("nr://abc@host.com");
  });

  test("throws on invalid input", () => {
    expect(() => parseConnectionInput("random-garbage")).toThrow("Invalid connection input");
  });

  test("throws on empty string", () => {
    expect(() => parseConnectionInput("")).toThrow("Invalid connection input");
  });

  test("throws on single word", () => {
    expect(() => parseConnectionInput("hello")).toThrow("Invalid connection input");
  });
});
