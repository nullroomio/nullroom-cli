/**
 * Terminal UI helpers for nullroom-cli
 * Uses @clack/prompts for pretty terminal output
 */

import * as p from "@clack/prompts";
import type { Interface as ReadlineInterface } from "readline";

// ANSI escape codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[97m";

/**
 * Display the nullroom banner (null symbol + brand).
 */
export function showBanner(): void {
  process.stderr.write(`\n  ${BOLD}${WHITE}\u2205${RESET} ${DIM}nullroom.io${RESET}\n\n`);
}

/**
 * Display a session separator line with a label.
 */
export function showSeparator(label: string): void {
  process.stderr.write(`  ${DIM}\u2500\u2500 ${label} \u2500\u2500${RESET}\n`);
}

/**
 * Format a timestamp as HH:MM.
 */
function formatTime(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, "0");
  const m = now.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Print a chat message to stderr with sender label and timestamp.
 * Clears the current readline prompt, prints the message, then restores the prompt.
 *
 * @param sender "you" or "peer"
 * @param message The message text
 * @param rl Optional readline interface to clear/restore the prompt
 */
export function printChatMessage(sender: "you" | "peer", message: string, rl?: ReadlineInterface): void {
  const time = formatTime();
  const labelColor = sender === "you" ? GREEN : CYAN;
  const line = `  ${BOLD}${labelColor}${sender}${RESET} ${DIM}${time}${RESET} ${message}\n`;

  if (rl) {
    // Clear the current prompt line, print message, restore prompt
    process.stdout.write(`\r\x1b[K`);
    process.stdout.write(line);
    rl.prompt(true);
  } else {
    process.stdout.write(line);
  }
}

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
  process.stderr.write(`  ${RED}error${RESET} ${msg}\n`);
}

/**
 * Log a success message to stderr.
 */
export function logSuccess(msg: string): void {
  process.stderr.write(`  ${GREEN}\u2713${RESET} ${msg}\n`);
}

/**
 * Log an info/progress message to stderr.
 */
export function logInfo(msg: string): void {
  process.stderr.write(`  ${CYAN}\u25CF${RESET} ${msg}\n`);
}
