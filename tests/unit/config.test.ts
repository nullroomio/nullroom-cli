import { describe, test, expect } from "bun:test";
import { normalizeServerUrl } from "../../src/utils/config";

// ── normalizeServerUrl ──────────────────────────────────────────────────────

describe("normalizeServerUrl", () => {
  test("rewrites www.nullroom.io to the apex host", () => {
    expect(normalizeServerUrl("https://www.nullroom.io")).toBe("https://nullroom.io");
  });

  test("leaves the apex host unchanged", () => {
    expect(normalizeServerUrl("https://nullroom.io")).toBe("https://nullroom.io");
  });

  test("strips a trailing slash", () => {
    expect(normalizeServerUrl("https://nullroom.io/")).toBe("https://nullroom.io");
    expect(normalizeServerUrl("https://www.nullroom.io/")).toBe("https://nullroom.io");
  });

  test("leaves other hosts unchanged", () => {
    expect(normalizeServerUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServerUrl("https://example.com")).toBe("https://example.com");
  });

  test("does not rewrite other www hosts", () => {
    expect(normalizeServerUrl("https://www.example.com")).toBe("https://www.example.com");
  });

  test("throws a clear error when the scheme is missing", () => {
    expect(() => normalizeServerUrl("nullroom.io")).toThrow("include the scheme");
  });

  test("throws on non-http schemes", () => {
    expect(() => normalizeServerUrl("ftp://nullroom.io")).toThrow("scheme must be http or https");
  });
});
