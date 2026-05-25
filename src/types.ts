/**
 * Shared TypeScript types for nullroom-cli
 */

// ── Signaling ────────────────────────────────────────────────────────────────

export interface RoomCreatedResponse {
  room_id: string;
  turn_servers: IceServer[];
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SignalMessage {
  type: "offer" | "answer" | "candidate";
  sdp?: RTCSessionDescriptionLike;
  candidate?: RTCIceCandidateLike;
}

export interface RTCSessionDescriptionLike {
  type: string;
  sdp: string;
}

export interface RTCIceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export type ChannelMessageType =
  | "init"
  | "peer_ready"
  | "peer_left"
  | "signal"
  | "file_transfer_authorized"
  | "file_transfer_error";

export interface ChannelInitData {
  initiator: boolean;
  connection_id: string;
  file_sharing: boolean;
  file_size_limit: number;
}

export interface ChannelMessage {
  type: ChannelMessageType;
  data?: unknown;
  connection_id?: string;
}

// ── PQ Upgrade ───────────────────────────────────────────────────────────────

export interface PQMessage {
  type: "pq-pubkey" | "pq-encap" | "pq-confirm";
  data: string; // base64
  confirm?: string; // base64 HMAC (only on pq-encap)
}

// ── File Transfer ────────────────────────────────────────────────────────────

export interface FileMetadata {
  type: "file-start";
  transferId: string;
  name: string;
  size: number;
  totalChunks: number;
  mimeType: string;
}

export interface FileEndMessage {
  type: "file-end";
  transferId: string;
}

export interface FileTransferComplete {
  name: string;
  size: number;
  mimeType: string;
  outputPath: string;
}

// ── Handshake ────────────────────────────────────────────────────────────────

export interface HandshakeResult {
  phrase: string;
  identifier: string;
  encryptedBlob: string;
}

// ── Connection String ────────────────────────────────────────────────────────

export interface ConnectionInfo {
  roomId: string;
  key: string;
  server: string;
}

// ── Room State ───────────────────────────────────────────────────────────────

export type RoomState =
  | "created"
  | "waiting"
  | "connecting"
  | "pq_upgrade"
  | "connected"
  | "transferring"
  | "closed"
  | "error";

export interface RoomOptions {
  server: string;
  json?: boolean;
  onState?: (state: RoomState, detail?: string) => void;
  onConnectionPath?: (path: ConnectionPath) => void;
  onMessage?: (msg: string) => void;
  onFileProgress?: (name: string, percent: number) => void;
  onFileComplete?: (info: FileTransferComplete) => void;
  onError?: (err: Error) => void;
}

export type ConnectionPath = "direct" | "relay" | "blocked";

// ── CLI ──────────────────────────────────────────────────────────────────────

export interface CreateOptions {
  json?: boolean;
  server?: string;
}

export interface JoinOptions {
  json?: boolean;
  server?: string;
}

export interface SendOptions {
  json?: boolean;
  server?: string;
  code?: string;
}

export interface ReceiveOptions {
  json?: boolean;
  server?: string;
  output?: string;
}

export interface PipeOptions {
  json?: boolean;
  server?: string;
}
