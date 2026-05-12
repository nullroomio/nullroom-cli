/**
 * Terminal UI helpers for nullroom-cli
 * Uses @clack/prompts for pretty terminal output
 */

import * as p from "@clack/prompts";

/**
 * Display a room creation/join header with connection info.
 */
export function showRoomHeader(phrase: string, connectionString: string): void {
  p.note(
    `Share this code with your peer:\n  ${phrase}\n\nOr share the connection string:\n  ${connectionString}`,
    "nullroom"
  );
}

/**
 * Show a spinner with a message.
 */
export function createSpinner() {
  return p.spinner();
}

/**
 * Format a file size for display.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Show a progress bar in the terminal.
 */
export function showProgress(name: string, percent: number): void {
  const width = 30;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  process.stderr.write(`\r  ${name} [${bar}] ${percent}%`);
  if (percent >= 100) {
    process.stderr.write("\n");
  }
}

/**
 * Output JSON to stdout (for --json mode).
 */
export function outputJson(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/**
 * Log a message to stderr (so stdout remains clean for data/json).
 */
export function log(msg: string): void {
  process.stderr.write(`  ${msg}\n`);
}

/**
 * Log an error to stderr.
 */
export function logError(msg: string): void {
  process.stderr.write(`  \x1b[31merror\x1b[0m ${msg}\n`);
}

/**
 * Log a success message to stderr.
 */
export function logSuccess(msg: string): void {
  process.stderr.write(`  \x1b[32m✓\x1b[0m ${msg}\n`);
}

/**
 * Log an info/progress message to stderr.
 */
export function logInfo(msg: string): void {
  process.stderr.write(`  \x1b[36m●\x1b[0m ${msg}\n`);
}
