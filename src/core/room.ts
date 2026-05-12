/**
 * Room lifecycle orchestrator for nullroom-cli
 *
 * Coordinates signaling, WebRTC, PQ upgrade, and data flow.
 * This is the "glue" that wires together all core modules.
 */

import { SignalingClient } from "./signaling";
import { PeerConnection } from "./peer";
import { performPQUpgrade } from "./pq-upgrade";
import { generateKey, importKey, encrypt, decrypt, encryptBuffer, decryptBuffer } from "./encryption";
import {
  createHandshake,
  publishHandshake,
  lookupHandshake,
  computeIdentifier,
  decryptUrl,
} from "./handshake";
import {
  encodeConnectionString,
  decodeConnectionString,
  parseConnectionInput,
} from "../utils/connection-string";
import { CONTROL_PREFIX } from "../utils/config";
import type {
  ConnectionInfo,
  ChannelMessage,
  SignalMessage,
  RoomState,
  IceServer,
} from "../types";

export interface RoomCallbacks {
  onState?: (state: RoomState, detail?: string) => void;
  onMessage?: (msg: string) => void;
  onProgress?: (msg: string) => void;
  onError?: (err: Error) => void;
}

export interface RoomSession {
  /** The connection info (room ID, key, server) */
  connectionInfo: ConnectionInfo;
  /** The 4-word phrase for sharing */
  phrase: string;
  /** The raw connection string */
  connectionString: string;
  /** Send a chat message */
  sendMessage: (msg: string) => Promise<void>;
  /** Send a file from path */
  sendFile: (path: string) => Promise<void>;
  /** Send raw data (for pipe mode) */
  sendData: (data: ArrayBuffer) => Promise<void>;
  /** Register a handler for incoming messages */
  onMessage: (handler: (msg: string) => void) => void;
  /** Register a handler for incoming file data */
  onFileData: (handler: (data: ArrayBuffer) => void) => void;
  /** Register a handler for control messages (file-start/end) */
  onControlMessage: (handler: (msg: string) => boolean) => void;
  /** Destroy the session */
  destroy: () => void;
  /** Wait for peer to connect (resolves when PQ upgrade completes) */
  waitForConnection: () => Promise<void>;
}

/**
 * Create a new room and wait for a peer to join.
 */
export async function createRoom(
  serverUrl: string,
  callbacks: RoomCallbacks
): Promise<RoomSession> {
  const { onState, onProgress, onError } = callbacks;

  onState?.("created");

  // 1. Create room on server
  const res = await fetch(`${serverUrl}/rooms`, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to create room: ${res.status} ${res.statusText}`);
  }

  const { room_id, turn_servers } = await res.json() as {
    room_id: string;
    turn_servers: IceServer[];
  };

  // 2. Generate encryption key
  const keyString = await generateKey();
  const encryptionKey = await importKey(keyString);

  // 3. Build room URL and create handshake
  const roomUrl = `${serverUrl}/rooms/${room_id}#${keyString}`;
  const { phrase, identifier, encryptedBlob } = await createHandshake(roomUrl);

  // 4. Publish handshake to server
  await publishHandshake(serverUrl, identifier, encryptedBlob);

  // 5. Build connection info
  const connectionInfo: ConnectionInfo = {
    roomId: room_id,
    key: keyString,
    server: serverUrl,
  };
  const connectionString = encodeConnectionString(connectionInfo);

  // 6. Set up signaling and peer connection
  const session = await setupSession(
    serverUrl,
    room_id,
    encryptionKey,
    turn_servers,
    callbacks
  );

  return {
    connectionInfo,
    phrase,
    connectionString,
    ...session,
  };
}

/**
 * Join an existing room using a phrase or connection string.
 */
export async function joinRoom(
  input: string,
  serverUrl: string,
  callbacks: RoomCallbacks
): Promise<RoomSession> {
  const { onState, onProgress, onError } = callbacks;

  onState?.("connecting");

  const parsed = parseConnectionInput(input);
  let connectionInfo: ConnectionInfo;

  if (parsed.type === "phrase") {
    // Look up handshake from server
    onProgress?.("Looking up room...");
    const identifier = await computeIdentifier(parsed.value);
    const encryptedBlob = await lookupHandshake(serverUrl, identifier);
    const roomUrl = await decryptUrl(encryptedBlob, parsed.value);

    // Parse room URL to extract room_id and key
    const url = new URL(roomUrl);
    const roomId = url.pathname.split("/").pop()!;
    const key = url.hash.slice(1); // Remove the # prefix
    const server = `${url.protocol}//${url.host}`;

    connectionInfo = { roomId: roomId, key, server };
  } else {
    connectionInfo = decodeConnectionString(parsed.value);
  }

  // Use the server from connection info (could differ from the default)
  const actualServer = connectionInfo.server;

  // Import the encryption key
  const encryptionKey = await importKey(connectionInfo.key);

  // Get TURN servers by hitting the room show endpoint
  const showRes = await fetch(`${actualServer}/rooms/${connectionInfo.roomId}`, {
    headers: { "Accept": "application/json" },
  });

  let turnServers: IceServer[] = [];
  if (showRes.ok) {
    const showData = await showRes.json() as { turn_servers?: IceServer[] };
    turnServers = showData.turn_servers || [];
  }

  // Set up signaling and peer connection
  const session = await setupSession(
    actualServer,
    connectionInfo.roomId,
    encryptionKey,
    turnServers,
    callbacks
  );

  return {
    connectionInfo,
    phrase: "", // Not available when joining
    connectionString: encodeConnectionString(connectionInfo),
    ...session,
  };
}

/**
 * Internal: Set up signaling, WebRTC, and PQ upgrade for a room.
 */
async function setupSession(
  serverUrl: string,
  roomId: string,
  encryptionKey: CryptoKey,
  turnServers: IceServer[],
  callbacks: RoomCallbacks
): Promise<{
  sendMessage: (msg: string) => Promise<void>;
  sendFile: (path: string) => Promise<void>;
  sendData: (data: ArrayBuffer) => Promise<void>;
  onMessage: (handler: (msg: string) => void) => void;
  onFileData: (handler: (data: ArrayBuffer) => void) => void;
  onControlMessage: (handler: (msg: string) => boolean) => void;
  destroy: () => void;
  waitForConnection: () => Promise<void>;
}> {
  const { onState, onProgress, onError } = callbacks;

  let hybridKey: CryptoKey = encryptionKey; // Starts as classical, upgraded after PQ
  let pqMessageHandler: ((msg: string) => Promise<boolean>) | null = null;
  const messageHandlers: ((msg: string) => void)[] = [];
  const fileDataHandlers: ((data: ArrayBuffer) => void)[] = [];
  const controlMessageHandlers: ((msg: string) => boolean)[] = [];
  let connectionResolve: (() => void) | null = null;
  let connectionReject: ((err: Error) => void) | null = null;

  const connectionPromise = new Promise<void>((resolve, reject) => {
    connectionResolve = resolve;
    connectionReject = reject;
  });

  // 1. Connect signaling
  onState?.("waiting");
  const signaling = new SignalingClient(serverUrl);
  await signaling.connect();

  // 2. Subscribe to room
  const initData = await signaling.subscribe(roomId);
  const isInitiator = initData.initiator;

  // 3. Create peer connection
  const peer = new PeerConnection({
    initiator: isInitiator,
    iceServers: turnServers,
  });

  // 4. Wire up signaling relay
  peer.on("signal", (signal: SignalMessage) => {
    signaling.sendSignal(signal);
  });

  signaling.onMessage((msg: ChannelMessage) => {
    if (msg.type === "signal" && msg.data) {
      peer.signal(msg.data as SignalMessage);
    } else if (msg.type === "peer_ready") {
      onProgress?.("Peer joined, establishing connection...");
      if (isInitiator) {
        peer.createOffer();
      }
    } else if (msg.type === "peer_left") {
      onState?.("closed", "Peer disconnected");
      destroy();
    }
  });

  // 5. Handle data channel open → PQ upgrade
  peer.on("datachannel-open", async () => {
    onState?.("pq_upgrade");
    onProgress?.("Data channel open, starting PQ upgrade...");

    try {
      const result = await performPQUpgrade(
        (data) => peer.send(data),
        encryptionKey,
        isInitiator,
        onProgress
      );

      hybridKey = result.hybridKey;
      pqMessageHandler = result.messageHandler;

      // Mark connection as ready
      peer.confirmReady();
      onState?.("connected");
      onProgress?.("Post-quantum encryption active");
      connectionResolve?.();
    } catch (err) {
      onError?.(err as Error);
      connectionReject?.(err as Error);
    }
  });

  // 6. Handle incoming data messages
  peer.on("data", async (rawMsg: string) => {
    // First, let PQ handler try to consume it
    if (pqMessageHandler) {
      const consumed = await pqMessageHandler(rawMsg);
      if (consumed) return;
    }

    // Check if it's a control message (e.g., file-start/end sent as plaintext JSON on data channel)
    for (const handler of controlMessageHandlers) {
      if (handler(rawMsg)) return;
    }

    // Try to decrypt as an encrypted chat message
    try {
      let plaintext: string;
      if (rawMsg.startsWith(CONTROL_PREFIX)) {
        // Control message (e.g., timer_sync) — decrypt the rest
        const encrypted = rawMsg.slice(1);
        plaintext = CONTROL_PREFIX + await decrypt(encrypted, hybridKey);
      } else {
        plaintext = await decrypt(rawMsg, hybridKey);
      }

      for (const handler of messageHandlers) {
        handler(plaintext);
      }
    } catch {
      // If decryption fails, it might be a plaintext control message
      for (const handler of messageHandlers) {
        handler(rawMsg);
      }
    }
  });

  // 7. Handle incoming file data
  peer.on("file-data", (data: ArrayBuffer) => {
    for (const handler of fileDataHandlers) {
      handler(data);
    }
  });

  // 8. Handle connection close
  peer.on("close", () => {
    onState?.("closed", "Connection closed");
  });

  peer.on("error", (err: Error) => {
    onError?.(err);
  });

  // ── Public API ──────────────────────────────────────────────────────

  async function sendMessage(msg: string): Promise<void> {
    const encrypted = await encrypt(msg, hybridKey);
    peer.send(encrypted);
  }

  async function sendFile(path: string): Promise<void> {
    // Import here to avoid circular deps
    const { FileTransferSender } = await import("./file-transfer");
    const sender = new FileTransferSender(
      peer,
      (buf) => encryptBuffer(buf, hybridKey),
      (name, percent) => callbacks.onProgress?.(`${name}: ${percent}%`),
      (errMsg) => callbacks.onError?.(new Error(errMsg))
    );
    await sender.sendFromPath(path);
  }

  async function sendData(data: ArrayBuffer): Promise<void> {
    const { FileTransferSender } = await import("./file-transfer");
    const sender = new FileTransferSender(
      peer,
      (buf) => encryptBuffer(buf, hybridKey),
      () => {},
      (errMsg) => callbacks.onError?.(new Error(errMsg))
    );
    await sender.sendFromBuffer(data);
  }

  function onMessage(handler: (msg: string) => void): void {
    messageHandlers.push(handler);
  }

  function onFileData(handler: (data: ArrayBuffer) => void): void {
    fileDataHandlers.push(handler);
  }

  function onControlMessage(handler: (msg: string) => boolean): void {
    controlMessageHandlers.push(handler);
  }

  function destroy(): void {
    peer.destroy();
    signaling.disconnect();
  }

  function waitForConnection(): Promise<void> {
    return connectionPromise;
  }

  return {
    sendMessage,
    sendFile,
    sendData,
    onMessage,
    onFileData,
    onControlMessage,
    destroy,
    waitForConnection,
  };
}
