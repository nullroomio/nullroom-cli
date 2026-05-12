#!/usr/bin/env bun
/**
 * nullroom-cli — Post-quantum encrypted P2P communication from the terminal
 *
 * A CLI client for nullroom.io. Fully interoperable with the web app.
 * Compiles to a single standalone binary via `bun build --compile`.
 */

import { Command } from "commander";
import { CLI_NAME, CLI_VERSION, DEFAULT_SERVER } from "./utils/config";
import { createCommand } from "./commands/create";
import { joinCommand } from "./commands/join";
import { sendCommand } from "./commands/send";
import { receiveCommand } from "./commands/receive";
import { pipeCommand } from "./commands/pipe";

// ── Global SIGINT handler for graceful shutdown ───────────────────────────────
let cleanupFn: (() => void) | null = null;

/** Register a cleanup function to be called on SIGINT */
export function registerCleanup(fn: () => void): void {
  cleanupFn = fn;
}

process.on("SIGINT", () => {
  if (cleanupFn) {
    cleanupFn();
  }
  // Give a brief moment for cleanup, then exit
  setTimeout(() => process.exit(0), 200);
});

process.on("SIGTERM", () => {
  if (cleanupFn) {
    cleanupFn();
  }
  setTimeout(() => process.exit(0), 200);
});

const program = new Command();

program
  .name(CLI_NAME)
  .description("Post-quantum encrypted P2P communication")
  .version(CLI_VERSION);

// ── nr create ─────────────────────────────────────────────────────────────────
program
  .command("create")
  .description("Create a new secure room")
  .option("--json", "Output connection info as JSON (agent mode)")
  .option("--server <url>", "Server URL", DEFAULT_SERVER)
  .action(async (options) => {
    await createCommand(options);
  });

// ── nr join <code> ────────────────────────────────────────────────────────────
program
  .command("join")
  .description("Join an existing room via phrase or connection string")
  .argument("<code>", "4-word phrase or nr:// connection string")
  .option("--json", "JSON lines mode (agent mode)")
  .option("--server <url>", "Server URL", DEFAULT_SERVER)
  .action(async (code, options) => {
    await joinCommand(code, options);
  });

// ── nr send <file> ────────────────────────────────────────────────────────────
program
  .command("send")
  .description("Send a file through an encrypted tunnel")
  .argument("<file>", "Path to file to send")
  .option("--json", "Output progress as JSON lines")
  .option("--server <url>", "Server URL", DEFAULT_SERVER)
  .option("--code <phrase>", "Use a specific phrase instead of generating one")
  .action(async (file, options) => {
    await sendCommand(file, options);
  });

// ── nr receive <code> ─────────────────────────────────────────────────────────
program
  .command("receive")
  .description("Receive a file from a sender")
  .argument("<code>", "4-word phrase or connection string from sender")
  .option("--json", "Output progress as JSON lines")
  .option("--server <url>", "Server URL", DEFAULT_SERVER)
  .option("--output <dir>", "Output directory", ".")
  .action(async (code, options) => {
    await receiveCommand(code, options);
  });

// ── nr pipe ───────────────────────────────────────────────────────────────────
program
  .command("pipe")
  .description("Pipe stdin/stdout through an encrypted tunnel")
  .argument("[code]", "Join code (omit to create a new tunnel)")
  .option("--json", "Output connection info as JSON to stderr")
  .option("--server <url>", "Server URL", DEFAULT_SERVER)
  .action(async (code, options) => {
    await pipeCommand(code, options);
  });

// Parse and execute
program.parse();
