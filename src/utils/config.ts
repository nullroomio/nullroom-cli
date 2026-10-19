/**
 * Configuration constants for nullroom-cli
 */

/** Legacy host, now 301-redirected to the apex (breaks POSTs and WebSockets) */
const LEGACY_HOST = "www.nullroom.io";
const CANONICAL_HOST = "nullroom.io";

/**
 * Normalize a server URL to `protocol//host` with no path or trailing slash.
 * Rewrites the legacy www.nullroom.io host to the apex; other hosts are left alone.
 */
export function normalizeServerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid server URL "${url}": include the scheme, e.g. https://nullroom.io`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid server URL "${url}": scheme must be http or https`);
  }
  const host = parsed.host === LEGACY_HOST ? CANONICAL_HOST : parsed.host;
  return `${parsed.protocol}//${host}`;
}

/** Default server URL (configurable via NR_SERVER env or --server flag) */
export const DEFAULT_SERVER = normalizeServerUrl(process.env.NR_SERVER || "https://nullroom.io");

/** WebSocket path for ActionCable */
export const CABLE_PATH = "/cable";

/** Room TTL in seconds (matches server default) */
export const ROOM_TTL_SECONDS = 900; // 15 minutes

/** File transfer chunk size in bytes */
export const CHUNK_SIZE = 65_536; // 64 KB

/**
 * Maximum P2P file transfer size for the relay path (protects TURN bandwidth).
 * Override with NR_FILE_TRANSFER_SIZE_LIMIT_RELAY_BYTES.
 */
export const FILE_SIZE_LIMIT_RELAY =
  Number(process.env.NR_FILE_TRANSFER_SIZE_LIMIT_RELAY_BYTES) || 100 * 1024 * 1024; // 100 MiB

/**
 * Maximum P2P file transfer size for direct connections (data never touches the server).
 * Override with NR_FILE_TRANSFER_SIZE_LIMIT_DIRECT_BYTES.
 */
export const FILE_SIZE_LIMIT_DIRECT =
  Number(process.env.NR_FILE_TRANSFER_SIZE_LIMIT_DIRECT_BYTES) || 1 * 1024 * 1024 * 1024; // 1 GiB

/**
 * Legacy alias — the conservative (relay) limit. Kept for back-compat; the active
 * limit is chosen at runtime from the confirmed connection type.
 */
export const FILE_SIZE_LIMIT = FILE_SIZE_LIMIT_RELAY;

/** WebRTC DataChannel backpressure thresholds */
export const MAX_BUFFER = 16_777_216; // 16 MB — pause above this
export const LOW_BUFFER = 8_388_608; // 8 MB — resume below this

/** Post-quantum upgrade timeout */
export const PQ_TIMEOUT_MS = 10_000; // 10 seconds

/** Handshake TTL on server (seconds) */
export const HANDSHAKE_TTL_SECONDS = 180; // 3 minutes

/** HKDF info string for hybrid key derivation */
export const HKDF_INFO = "nullroom-hybrid-v1";

/** HMAC labels for PQ confirmation (prevent reflection attacks) */
export const CONFIRM_LABEL_RESPONDER = "nullroom-pq-confirm-responder";
export const CONFIRM_LABEL_INITIATOR = "nullroom-pq-confirm-initiator";

/** PBKDF2 parameters for handshake key derivation */
export const PBKDF2_SALT = "nullroom-handshake";
export const PBKDF2_ITERATIONS = 100_000;

/** Control message prefix (SOH byte distinguishes from chat) */
export const CONTROL_PREFIX = "\x01";

/** CLI name for binary */
export const CLI_NAME = "nr";

/** CLI version */
export const CLI_VERSION = "0.1.1";
