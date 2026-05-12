/**
 * Server session helper for nullroom-cli
 *
 * Fetches a CSRF token and session cookie from the server.
 * Required because the handshakes controller enforces CSRF verification.
 * The rooms controller skips CSRF, so room creation doesn't need this.
 */

interface ServerSession {
  csrfToken: string;
  sessionCookie: string;
}

let cachedSession: ServerSession | null = null;
let cachedServer: string | null = null;

/**
 * Reset the cached session (for testing).
 */
export function resetSessionCache(): void {
  cachedSession = null;
  cachedServer = null;
}

/**
 * Fetch a CSRF token and session cookie from the server.
 * Caches the result for the lifetime of the process (per server).
 */
export async function getServerSession(serverUrl: string): Promise<ServerSession> {
  if (cachedSession && cachedServer === serverUrl) {
    return cachedSession;
  }

  const res = await fetch(serverUrl + "/", {
    headers: { Accept: "text/html" },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch session from server: ${res.status}`);
  }

  const html = await res.text();
  const csrfMatch = html.match(/csrf-token.*?content="([^"]+)"/);
  const csrfToken = csrfMatch?.[1] ?? "";

  const setCookie = res.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";")[0] ?? "";

  if (!csrfToken) {
    throw new Error("Could not extract CSRF token from server");
  }

  const session: ServerSession = { csrfToken, sessionCookie };
  cachedSession = session;
  cachedServer = serverUrl;
  return session;
}

/**
 * Get headers required for authenticated POST requests to the server.
 * These are needed for handshake endpoints that enforce CSRF.
 */
export async function getAuthHeaders(serverUrl: string): Promise<Record<string, string>> {
  const session = await getServerSession(serverUrl);
  return {
    "X-CSRF-Token": session.csrfToken,
    "Cookie": session.sessionCookie,
  };
}
