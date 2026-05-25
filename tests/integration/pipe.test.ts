import { describe, test, expect, beforeEach, afterEach } from "bun:test";

const PIPE_READY_MARKER = "\x04PIPE_READY";

const originalStderrWrite = process.stderr.write;

class FakePipeSession {
  phrase = "alpha-bravo-charlie-delta";
  connectionString = "nr://fake-connection";
  sendMessageCalls: string[] = [];
  destroyed = false;
  private incomingHandler: ((msg: string) => void) | null = null;

  async waitForConnection(): Promise<void> {
    // Immediate for tests.
  }

  async sendMessage(msg: string): Promise<void> {
    this.sendMessageCalls.push(msg);
  }

  onMessage(handler: (msg: string) => void): void {
    this.incomingHandler = handler;
  }

  emitIncoming(msg: string): void {
    this.incomingHandler?.(msg);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

let createSession: FakePipeSession;
let joinSession: FakePipeSession;

const { createPipeCommand } = await import("../../src/commands/pipe");

describe("pipe readiness handshake", () => {
  const originalExit = process.exit;
  const originalStdinStream = Bun.stdin.stream;
  const originalStdoutWrite = process.stdout.write;

  let exitCodes: number[];
  let capturedStdout: string;

  beforeEach(() => {
    createSession = new FakePipeSession();
    joinSession = new FakePipeSession();
    exitCodes = [];
    capturedStdout = "";

    (process as any).exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as any;

    process.stderr.write = (() => true) as any;
  });

  afterEach(() => {
    (process as any).exit = originalExit;
    (Bun.stdin as any).stream = originalStdinStream;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  });

  test("sender waits for receiver-ready marker before sending payload", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const pipeCommand = createPipeCommand({
      createRoom: async () => createSession as any,
      joinRoom: async () => joinSession as any,
    });

    const payload = new TextEncoder().encode("pipe-smoke");
    (Bun.stdin as any).stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      });

    const runPromise = pipeCommand(undefined, { json: true, server: "https://test.server" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createSession.sendMessageCalls).toHaveLength(0);

    createSession.emitIncoming(PIPE_READY_MARKER);

    await runPromise;

    expect(createSession.sendMessageCalls).toHaveLength(2);
    expect(createSession.sendMessageCalls[0]!.startsWith("\x02")).toBe(true);
    expect(createSession.sendMessageCalls[1]).toBe("\x03");

    const decoded = Buffer.from(createSession.sendMessageCalls[0]!.slice(1), "base64").toString("utf-8");
    expect(decoded).toBe("pipe-smoke");
    expect(exitCodes).toContain(0);
  });

  test("receiver does not emit readiness/control frames to stdout", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const pipeCommand = createPipeCommand({
      createRoom: async () => createSession as any,
      joinRoom: async () => joinSession as any,
    });

    process.stdout.write = ((chunk: string | Uint8Array) => {
      capturedStdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as any;

    await pipeCommand("test-code", { json: true, server: "https://test.server" });

    // Receiver sends marker to sender after setup completes.
    expect(joinSession.sendMessageCalls).toContain(PIPE_READY_MARKER);

    // Incoming marker and unrelated text should not be written to stdout.
    joinSession.emitIncoming(PIPE_READY_MARKER);
    joinSession.emitIncoming("plain-text-control");

    // Only framed pipe payload chunks are emitted.
    const encodedPayload = Buffer.from("hello-pipe").toString("base64");
    joinSession.emitIncoming(`\x02${encodedPayload}`);
    joinSession.emitIncoming("\x03");

    expect(capturedStdout).toBe("hello-pipe");
    expect(exitCodes).toContain(0);
  });
});
