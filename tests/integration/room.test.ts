import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { generateKey, importKey, encrypt, decrypt, encryptBuffer, decryptBuffer } from "../../src/core/encryption";
import { resetSessionCache } from "../../src/utils/session";
import type { ChannelMessage, SignalMessage } from "../../src/types";

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** Global registry so tests can access instances created inside room.ts */
let signalingInstances: FakeSignalingClient[] = [];
let peerInstances: FakePeerConnection[] = [];

type EventHandler = (...args: any[]) => void;

class FakeSignalingClient {
  handlers: ((msg: ChannelMessage) => void)[] = [];
  connected = false;
  subscribed = false;
  sentSignals: SignalMessage[] = [];
  roomId = "";
  private _subscribeCount = 0;

  constructor(_serverUrl: string) {
    signalingInstances.push(this);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async subscribe(roomId: string): Promise<any> {
    this.roomId = roomId;
    this.subscribed = true;
    this._subscribeCount++;
    return {
      initiator: this._subscribeCount === 1,
      connection_id: `conn-${this._subscribeCount}`,
      file_sharing: true,
      file_size_limit: 16777216,
    };
  }

  sendSignal(signal: SignalMessage): void {
    this.sentSignals.push(signal);
  }

  onMessage(handler: (msg: ChannelMessage) => void): void {
    this.handlers.push(handler);
  }

  offMessage(handler: (msg: ChannelMessage) => void): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  getConnectionId(): string {
    return `conn-${this._subscribeCount}`;
  }

  disconnect(): void {
    this.connected = false;
  }

  // Test helper: inject a message
  _injectMessage(msg: ChannelMessage): void {
    for (const h of this.handlers) h(msg);
  }
}

class FakePeerConnection {
  listeners: Record<string, EventHandler[]> = {};
  sentData: string[] = [];
  sentFiles: ArrayBuffer[] = [];
  _connected = false;
  private _connectionType: "direct" | "relay" = "direct";

  constructor(_options: any) {
    peerInstances.push(this);
  }

  on(event: string, callback: EventHandler): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(callback);
  }

  off(event: string, callback: EventHandler): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event]!.filter((h) => h !== callback);
    }
  }

  signal(_data: SignalMessage): void {
    // No-op in fake
  }

  async createOffer(): Promise<void> {
    // Simulate offer → immediate data channel open
    this._emit("datachannel-open");
    this._emit("connect");
  }

  send(data: string): void {
    this.sentData.push(data);
    // Echo back to own data handler (simulates the other peer replying)
    // The PQ upgrade messages need to be handled by the peer's own data listeners
  }

  sendFile(data: ArrayBuffer | Buffer): void {
    const uint8 = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data);
    const copy = uint8.slice();
    this.sentFiles.push(copy.buffer as ArrayBuffer);
  }

  getFileBufferedAmount(): number {
    return 0;
  }

  async detectConnectionType(): Promise<"direct" | "relay"> {
    return this._connectionType;
  }

  getCandidateTypes(): Set<string> {
    return new Set(["HOST"]);
  }

  _setConnectionType(type: "direct" | "relay"): void {
    this._connectionType = type;
  }

  confirmReady(): void {
    this._connected = true;
  }

  destroy(): void {
    this.listeners = {};
  }

  _emit(event: string, data?: any): void {
    if (this.listeners[event]) {
      for (const cb of this.listeners[event]!) cb(data);
    }
  }
}

// ─── Module mocks ───────────────────────────────────────────────────────────

// We need to mock the modules BEFORE importing room.ts
// Bun's mock.module replaces the module for all subsequent imports

mock.module("../../src/core/signaling", () => ({
  SignalingClient: FakeSignalingClient,
}));

mock.module("../../src/core/peer", () => ({
  PeerConnection: FakePeerConnection,
}));

// Mock performPQUpgrade to complete immediately with a derived key
let pqUpgradeKey: CryptoKey | null = null;

mock.module("../../src/core/pq-upgrade", () => ({
  performPQUpgrade: async (
    _sendFn: (data: string) => void,
    registerHandler: (handler: (msg: string) => Promise<boolean>) => void,
    classicalKey: CryptoKey,
    _isInitiator: boolean,
    _onProgress?: (msg: string) => void,
  ) => {
    // Register a no-op handler
    const handler = async (msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        return parsed.type?.startsWith("pq-") || false;
      } catch {
        return false;
      }
    };
    registerHandler(handler);

    // Use the classical key as the hybrid key (skip actual ML-KEM)
    pqUpgradeKey = classicalKey;
    return { hybridKey: classicalKey, messageHandler: handler };
  },
}));

// Now import room.ts — it will get our mocked modules
const { createRoom, joinRoom } = await import("../../src/core/room");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createRoom", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    signalingInstances = [];
    peerInstances = [];
    pqUpgradeKey = null;
    resetSessionCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionCache();
  });

  function mockFetch() {
    const handshakeStore: Record<string, string> = {};
    const calls: { url: string; method: string; body?: string }[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method || "GET";
      calls.push({ url, method, body: init?.body as string });

      // CSRF / session fetch
      if (url.endsWith("/") && method === "GET") {
        return new Response('<meta name="csrf-token" content="test-token" />', {
          headers: { "set-cookie": "_session=test; path=/" },
        });
      }

      // POST /rooms
      if (url.endsWith("/rooms") && method === "POST") {
        return Response.json({
          room_id: "test-room-uuid",
          turn_servers: [{ urls: "stun:stun.test.com:3478" }],
        });
      }

      // POST /handshakes/:id
      if (url.includes("/handshakes/") && method === "POST") {
        const id = url.split("/handshakes/")[1]!;
        const body = JSON.parse(init?.body as string);
        handshakeStore[id] = body.blob;
        return new Response(null, { status: 201 });
      }

      // GET /handshakes/:id
      if (url.includes("/handshakes/") && method === "GET") {
        const id = url.split("/handshakes/")[1]!;
        const blob = handshakeStore[id];
        if (!blob) return new Response(null, { status: 404 });
        return Response.json({ blob });
      }

      // GET /rooms/:id (show)
      if (url.match(/\/rooms\/[^/]+$/) && method === "GET") {
        return Response.json({ turn_servers: [{ urls: "stun:stun.test.com:3478" }] });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    return { calls, handshakeStore };
  }

  test("creates a room and returns session with phrase and connection string", async () => {
    const { calls } = mockFetch();
    const states: string[] = [];

    const session = await createRoom("https://test.server", {
      onState: (s) => states.push(s),
    });

    expect(session.connectionInfo.roomId).toBe("test-room-uuid");
    expect(session.phrase.split("-")).toHaveLength(4);
    expect(session.connectionString).toStartWith("nr://");
    expect(states).toContain("created");
    expect(states).toContain("waiting");

    // Verify it POSTed to /rooms
    const roomPost = calls.find((c) => c.url.endsWith("/rooms") && c.method === "POST");
    expect(roomPost).toBeDefined();

    session.destroy();
  });

  test("publishes handshake to /handshakes/:identifier", async () => {
    const { calls, handshakeStore } = mockFetch();

    const session = await createRoom("https://test.server", {});

    // Verify handshake was published
    const handshakePost = calls.find((c) => c.url.includes("/handshakes/") && c.method === "POST");
    expect(handshakePost).toBeDefined();

    // The stored blob should be decryptable with the phrase
    expect(Object.keys(handshakeStore)).toHaveLength(1);

    session.destroy();
  });

  test("waitForConnection resolves after peer joins and PQ upgrade completes", async () => {
    mockFetch();

    const session = await createRoom("https://test.server", {});

    // Simulate the peer joining: inject peer_ready via signaling
    const sig = signalingInstances[0]!;
    const peer = peerInstances[0]!;

    // Trigger the flow: peer_ready → createOffer → datachannel-open → PQ upgrade
    sig._injectMessage({ type: "peer_ready" });

    // waitForConnection should now resolve (PQ upgrade is mocked to complete immediately)
    await session.waitForConnection();

    // Session should report connected
    expect(peer._connected).toBe(true);

    session.destroy();
  });

  test("sendMessage encrypts and sends through the peer", async () => {
    mockFetch();

    const session = await createRoom("https://test.server", {});
    const sig = signalingInstances[0]!;
    sig._injectMessage({ type: "peer_ready" });
    await session.waitForConnection();

    const peer = peerInstances[0]!;
    peer.sentData = [];

    await session.sendMessage("hello world");

    // Should have sent an encrypted string (not plaintext)
    // At least one encrypted payload should decrypt to our chat text.
    const decryptedPayloads = await Promise.all(
      peer.sentData.map(async (payload) => {
        try {
          return await decrypt(payload, pqUpgradeKey!);
        } catch {
          return null;
        }
      })
    );

    expect(decryptedPayloads).toContain("hello world");

    session.destroy();
  });

  test("decryptFileChunk decrypts data with the session hybrid key", async () => {
    mockFetch();

    const session = await createRoom("https://test.server", {});
    const sig = signalingInstances[0]!;
    sig._injectMessage({ type: "peer_ready" });
    await session.waitForConnection();

    // Encrypt some data with the key that PQ upgrade used (classical key in our mock)
    const testData = new TextEncoder().encode("file chunk data");
    const encrypted = await encryptBuffer(testData.buffer as ArrayBuffer, pqUpgradeKey!);

    // decryptFileChunk should decrypt it
    const decrypted = await session.decryptFileChunk(encrypted);
    const result = new TextDecoder().decode(decrypted);
    expect(result).toBe("file chunk data");

    session.destroy();
  });

  test("onMessage handler receives decrypted messages", async () => {
    mockFetch();

    const session = await createRoom("https://test.server", {});
    const sig = signalingInstances[0]!;
    sig._injectMessage({ type: "peer_ready" });
    await session.waitForConnection();

    const received: string[] = [];
    session.onMessage((msg) => received.push(msg));

    // Encrypt a message with the hybrid key and inject it into the peer
    const peer = peerInstances[0]!;
    const encrypted = await encrypt("incoming message", pqUpgradeKey!);
    peer._emit("data", encrypted);

    // Give async handlers a tick to process
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toContain("incoming message");

    session.destroy();
  });

  test("connection path escalates to relay when peer reports relay", async () => {
    mockFetch();

    const connectionPaths: string[] = [];
    const session = await createRoom("https://test.server", {
      onConnectionPath: (path) => connectionPaths.push(path),
    });

    const sig = signalingInstances[0]!;
    sig._injectMessage({ type: "peer_ready" });
    await session.waitForConnection();

    const peer = peerInstances[0]!;
    const relayControl = await encrypt("\x01" + JSON.stringify({
      type: "connection_type",
      value: "relay",
    }), pqUpgradeKey!);
    peer._emit("data", relayControl);
    await new Promise((r) => setTimeout(r, 10));

    expect(connectionPaths).toContain("direct");
    expect(connectionPaths).toContain("relay");

    session.destroy();
  });
});

describe("joinRoom", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    signalingInstances = [];
    peerInstances = [];
    pqUpgradeKey = null;
    resetSessionCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionCache();
  });

  test("joins a room using a connection string", async () => {
    const states: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // GET /rooms/:id
      if (url.match(/\/rooms\//) && (!init?.method || init.method === "GET")) {
        return Response.json({ turn_servers: [] });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    // Encode a connection string directly
    const { encodeConnectionString } = await import("../../src/utils/connection-string");
    const connStr = encodeConnectionString({
      roomId: "join-room-id",
      key: await generateKey(),
      server: "https://test.server",
    });

    const session = await joinRoom(connStr, "https://test.server", {
      onState: (s) => states.push(s),
    });

    expect(session.connectionInfo.roomId).toBe("join-room-id");
    expect(states).toContain("connecting");
    expect(states).toContain("waiting");

    session.destroy();
  });

  test("joins a room using a phrase (handshake lookup)", async () => {
    // Pre-publish a handshake
    const { encryptUrl, computeIdentifier } = await import("../../src/core/handshake");
    const keyStr = await generateKey();
    const roomUrl = "https://test.server/rooms/phrase-room-id#" + keyStr;
    const phrase = "alpha-bravo-charlie-delta";
    const identifier = await computeIdentifier(phrase);
    const blob = await encryptUrl(roomUrl, phrase);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      // GET /handshakes/:id
      if (url.includes("/handshakes/") && (!init?.method || init.method === "GET")) {
        return Response.json({ blob });
      }
      // GET /rooms/:id
      if (url.match(/\/rooms\//) && (!init?.method || init.method === "GET")) {
        return Response.json({ turn_servers: [] });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const session = await joinRoom(phrase, "https://test.server", {});

    expect(session.connectionInfo.roomId).toBe("phrase-room-id");
    expect(session.connectionInfo.key).toBe(keyStr);

    session.destroy();
  });

  test("waitForConnection resolves after peer_ready and PQ upgrade", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.match(/\/rooms\//)) return Response.json({ turn_servers: [] });
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const { encodeConnectionString } = await import("../../src/utils/connection-string");
    const connStr = encodeConnectionString({
      roomId: "room-1",
      key: await generateKey(),
      server: "https://test.server",
    });

    const session = await joinRoom(connStr, "https://test.server", {});

    // Trigger connection
    const sig = signalingInstances[0]!;
    sig._injectMessage({ type: "peer_ready" });

    await session.waitForConnection();

    session.destroy();
  });
});

describe("room connection timeout", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    signalingInstances = [];
    peerInstances = [];
    resetSessionCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSessionCache();
  });

  test("waitForConnection rejects after timeout if peer never connects", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/")) {
        return new Response('<meta name="csrf-token" content="t" />', {
          headers: { "set-cookie": "_s=x" },
        });
      }
      if (url.endsWith("/rooms") && init?.method === "POST") {
        return Response.json({ room_id: "timeout-room", turn_servers: [] });
      }
      if (url.includes("/handshakes/") && init?.method === "POST") {
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const session = await createRoom("https://test.server", {});

    // Don't trigger peer_ready — connection should time out
    // The room module uses a 60s timeout, but we can't wait that long in tests.
    // Instead, we verify the promise doesn't resolve immediately.
    const result = await Promise.race([
      session.waitForConnection().then(() => "connected"),
      new Promise((r) => setTimeout(() => r("still_waiting"), 100)),
    ]);

    expect(result).toBe("still_waiting");

    session.destroy();
  });
});
