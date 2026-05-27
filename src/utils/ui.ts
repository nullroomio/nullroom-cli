/**
 * Terminal UI helpers for nullroom-cli
 * Minimal left-gutter design inspired by nullroom.io
 */

import * as p from "@clack/prompts";
import type { Interface as ReadlineInterface } from "readline";

// ANSI escape codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[97m";

// Left gutter: dim pipe with spacing
const GUTTER = `${DIM}│${RESET} `;

const CONTENT_MAX_WIDTH = 140;

interface SessionUIState {
  active: boolean;
  command: string;
  contentWidth: number;
  progressActive: boolean;
  footerPrinted: boolean;
  exitHookRegistered: boolean;
}

const sessionUI: SessionUIState = {
  active: false,
  command: "",
  contentWidth: 0,
  progressActive: false,
  footerPrinted: false,
  exitHookRegistered: false,
};

function clearTerminal(): void {
  const stream = process.stdout.isTTY ? process.stdout : process.stderr;
  stream.write("\x1b[2J\x1b[H");
}

function resolveContentWidth(): number {
  const columns = process.stderr.columns ?? process.stdout.columns ?? 100;
  // Leave room for gutter (4 chars: "  │ ") and some right margin
  return Math.min(columns - 6, CONTENT_MAX_WIDTH);
}

function wrapLine(line: string, maxWidth: number): string[] {
  if (!line) return [""];
  if (stripAnsi(line).length <= maxWidth) return [line];

  const wrapped: string[] = [];
  let remaining = line;

  while (stripAnsi(remaining).length > maxWidth) {
    let splitAt = remaining.lastIndexOf(" ", maxWidth);
    if (splitAt <= 0) splitAt = maxWidth;

    wrapped.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  wrapped.push(remaining);
  return wrapped;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderGutterLine(content: string): string {
  return `  ${GUTTER} ${content}`;
}

function ensureProgressClosed(): void {
  if (!sessionUI.active || !sessionUI.progressActive) return;
  process.stderr.write("\n");
  sessionUI.progressActive = false;
}

function gutterWrite(text: string): void {
  if (!sessionUI.active) {
    process.stderr.write(`${text}\n`);
    return;
  }

  ensureProgressClosed();
  // Clear any readline prompt residue on the current line
  process.stdout.write(`\r\x1b[K`);

  const rawLines = text.split("\n");
  for (const rawLine of rawLines) {
    const wrappedLines = wrapLine(rawLine, sessionUI.contentWidth);
    for (const wrapped of wrappedLines) {
      process.stderr.write(`${renderGutterLine(wrapped)}\n`);
    }
  }
}

function gutterRule(label: string): void {
  if (!sessionUI.active) return;

  const ruleWidth = Math.min(sessionUI.contentWidth, 56);
  const labelText = label ? ` ${label} ` : "";
  const dashCount = ruleWidth - labelText.length;

  if (dashCount <= 0) {
    gutterWrite(label);
    return;
  }

  const left = Math.floor(dashCount / 2);
  const right = dashCount - left;
  gutterWrite(`${DIM}${"─".repeat(left)}${labelText}${"─".repeat(right)}${RESET}`);
}

/**
 * Enable the session UI for interactive commands.
 */
export function initSessionUI(commandName: string, options?: { json?: boolean }): void {
  if (options?.json) return;
  if (commandName === "pipe") return;
  if (!process.stdout.isTTY || !process.stderr.isTTY) return;
  if (sessionUI.active) return;

  sessionUI.active = true;
  sessionUI.command = commandName;
  sessionUI.contentWidth = resolveContentWidth();
  sessionUI.progressActive = false;
  sessionUI.footerPrinted = false;

  clearTerminal();

  // Header
  process.stderr.write(`\n  ${BOLD}${WHITE}\u2205${RESET}  ${DIM}nullroom.io${RESET} ${DIM}│${RESET} ${CYAN}${commandName}${RESET}\n`);
  // Horizontal rule separating header from body
  const ruleWidth = Math.min(sessionUI.contentWidth + 4, 60);
  process.stderr.write(`  ${DIM}${"─".repeat(ruleWidth)}${RESET}\n`);

  if (!sessionUI.exitHookRegistered) {
    process.once("exit", () => {
      finishSessionUI();
    });
    sessionUI.exitHookRegistered = true;
  }
}

/**
 * Close the session UI.
 */
export function finishSessionUI(): void {
  if (!sessionUI.active || sessionUI.footerPrinted) return;

  ensureProgressClosed();
  process.stderr.write(`\n`);
  sessionUI.footerPrinted = true;
  sessionUI.active = false;
}

/**
 * Display the nullroom banner (null symbol + brand).
 */
export function showBanner(): void {
  if (sessionUI.active) return;

  process.stderr.write(`\n  ${BOLD}${WHITE}\u2205${RESET} ${DIM}nullroom.io${RESET}\n\n`);
}

/**
 * Input prompt helper for chat mode.
 */
export function getInputPrompt(): string {
  return sessionUI.active ? `  ${DIM}│${RESET} ${DIM}>${RESET} ` : "> ";
}

/**
 * Display a session separator line with a label.
 */
export function showSeparator(label: string): void {
  if (sessionUI.active) {
    gutterRule(label);
    return;
  }

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

  if (sessionUI.active) {
    if (rl) {
      // For "you" messages, move up to overwrite the readline echo line
      if (sender === "you") {
        process.stdout.write(`\x1b[A`);
      }
    }

    const labelColor = sender === "you" ? GREEN : CYAN;
    gutterWrite(`${DIM}[${time}]${RESET} ${BOLD}${labelColor}${sender}${RESET} ${message}`);

    if (rl) {
      rl.prompt(true);
    }
    return;
  }

  const labelColor = sender === "you" ? GREEN : CYAN;
  const line = `  ${BOLD}${labelColor}${sender}${RESET} ${DIM}${time}${RESET} ${message}\n`;

  if (rl) {
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
  if (sessionUI.active) {
    gutterWrite("");
    gutterWrite(`${DIM}Share this code with your peer:${RESET}`);
    gutterWrite(`  ${BOLD}${WHITE}${phrase}${RESET}`);
    gutterWrite("");
    gutterWrite(`${DIM}Or share the connection string:${RESET}`);
    gutterWrite(`  ${DIM}${connectionString}${RESET}`);
    gutterWrite("");
    gutterRule("waiting");
    return;
  }

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
  if (sessionUI.active) {
    const barWidth = Math.max(10, Math.min(32, sessionUI.contentWidth - 24));
    const filled = Math.round((percent / 100) * barWidth);
    const empty = barWidth - filled;
    const bar = `${GREEN}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(empty)}${RESET}`;

    const maxNameWidth = Math.max(8, sessionUI.contentWidth - barWidth - 9);
    const displayName = name.length > maxNameWidth
      ? `${name.slice(0, maxNameWidth - 1)}…`
      : name;

    const line = renderGutterLine(`${displayName} [${bar}] ${percent.toString().padStart(3)}%`);
    process.stderr.write(`\r${line}`);

    if (percent >= 100) {
      process.stderr.write("\n");
      sessionUI.progressActive = false;
    } else {
      sessionUI.progressActive = true;
    }

    return;
  }

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
  if (sessionUI.active) {
    gutterWrite(msg);
    return;
  }

  process.stderr.write(`  ${msg}\n`);
}

/**
 * Log an error to stderr.
 */
export function logError(msg: string): void {
  if (sessionUI.active) {
    gutterWrite(`${RED}error${RESET} ${msg}`);
    return;
  }

  process.stderr.write(`  ${RED}error${RESET} ${msg}\n`);
}

/**
 * Log a success message to stderr.
 */
export function logSuccess(msg: string): void {
  if (sessionUI.active) {
    gutterWrite(`${GREEN}\u2713${RESET} ${msg}`);
    return;
  }

  process.stderr.write(`  ${GREEN}\u2713${RESET} ${msg}\n`);
}

/**
 * Log an info/progress message to stderr.
 */
export function logInfo(msg: string): void {
  if (sessionUI.active) {
    gutterWrite(`${BLUE}\u25CF${RESET} ${msg}`);
    return;
  }

  process.stderr.write(`  ${CYAN}\u25CF${RESET} ${msg}\n`);
}
