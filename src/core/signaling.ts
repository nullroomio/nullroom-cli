/**
 * ActionCable WebSocket client for nullroom-cli
 *
 * Implements the Rails ActionCable wire protocol over native WebSocket.
 * The web app uses @rails/actioncable (browser-specific); this is a
 * standalone implementation.
 *
 * Protocol:
 *   Connect → ws(s)://server/cable
 *   ← {"type":"welcome"}
 *   → {"command":"subscribe","identifier":"{\"channel\":\"RoomsChannel\",\"room_id\":\"...\"}"}
 *   ← {"type":"confirm_subscription",...}
 *   → {"command":"message","identifier":"...","data":"{\"action\":\"...\",\"data\":{...}}"}
 *   ← {"message":{...},"identifier":"..."}
 */

import { CABLE_PATH } from "../utils/config";
import type {
  ChannelInitData,
  ChannelMessage,
  SignalMessage,
} from "../types";

type MessageHandler = (msg: ChannelMessage) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private identifier: string = "";
  private connectionId: string = "";
  private handlers: MessageHandler[] = [];
  private connected: boolean = false;
  private subscribed: boolean = false;

  constructor(serverUrl: string) {
    // Convert https:// to wss:// and http:// to ws://
    const wsUrl = serverUrl
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");
    this.serverUrl = wsUrl.replace(/\/$/, "") + CABLE_PATH;
  }

  /**
   * Connect to the ActionCable WebSocket server.
   * Resolves when the server sends the "welcome" message.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timed out"));
      }, 10_000);

      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => {
        // Wait for welcome message
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const data = JSON.parse(String(event.data));

        if (data.type === "welcome" && !this.connected) {
          this.connected = true;
          clearTimeout(timeout);
          resolve();
          return;
        }

        if (data.type === "confirm_subscription") {
          this.subscribed = true;
          return;
        }

        if (data.type === "ping") {
          // ActionCable sends pings to keep the connection alive
          return;
        }

        if (data.type === "disconnect") {
          this._handleDisconnect(data.reason);
          return;
        }

        // Route channel messages
        if (data.message && data.identifier === this.identifier) {
          this._dispatch(data.message as ChannelMessage);
        }
      };

      this.ws.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${event}`));
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.connected = false;
        this.subscribed = false;
        if (!this.connected) {
          clearTimeout(timeout);
          reject(new Error(`WebSocket closed: ${event.code} ${event.reason}`));
        }
      };
    });
  }

  /**
   * Subscribe to a RoomsChannel for the given room ID.
   * Returns the init data (initiator flag, connection_id, etc.)
   */
  subscribe(roomId: string): Promise<ChannelInitData> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected to server"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Subscription timed out"));
      }, 10_000);

      this.identifier = JSON.stringify({
        channel: "RoomsChannel",
        room_id: roomId,
      });

      // Listen for the init message (transmitted on subscribe)
      const initHandler = (msg: ChannelMessage) => {
        if (msg.type === "init") {
          clearTimeout(timeout);
          this.connectionId = (msg as unknown as ChannelInitData).connection_id;
          // Remove this one-shot handler
          this.handlers = this.handlers.filter((h) => h !== initHandler);
          resolve(msg as unknown as ChannelInitData);
        }
      };
      this.handlers.push(initHandler);

      // Send subscribe command
      this.ws.send(
        JSON.stringify({
          command: "subscribe",
          identifier: this.identifier,
        })
      );
    });
  }

  /**
   * Send a WebRTC signaling message (offer/answer/candidate) through the server.
   */
  sendSignal(signal: SignalMessage): void {
    this._perform("send_signal", { data: signal });
  }

  /**
   * Request server authorization for a file transfer.
   */
  requestFileTransfer(metadata: { file_name: string; file_size: number }): void {
    this._perform("initiate_file_transfer", { metadata });
  }

  /**
   * Register a message handler for channel messages.
   */
  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Remove a message handler.
   */
  offMessage(handler: MessageHandler): void {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /**
   * Get the current connection ID.
   */
  getConnectionId(): string {
    return this.connectionId;
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    if (this.ws) {
      // Unsubscribe first
      if (this.subscribed && this.identifier) {
        try {
          this.ws.send(
            JSON.stringify({
              command: "unsubscribe",
              identifier: this.identifier,
            })
          );
        } catch {
          // Ignore send errors during disconnect
        }
      }
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.subscribed = false;
    this.handlers = [];
  }

  /**
   * Perform an ActionCable action on the subscribed channel.
   */
  private _perform(action: string, data: Record<string, unknown>): void {
    if (!this.ws || !this.subscribed) {
      throw new Error("Not subscribed to channel");
    }

    this.ws.send(
      JSON.stringify({
        command: "message",
        identifier: this.identifier,
        data: JSON.stringify({ action, ...data }),
      })
    );
  }

  /**
   * Dispatch a channel message to all handlers.
   */
  private _dispatch(msg: ChannelMessage): void {
    // Filter out our own signal messages
    if (msg.type === "signal" && msg.connection_id === this.connectionId) {
      return;
    }

    for (const handler of this.handlers) {
      handler(msg);
    }
  }

  /**
   * Handle server-initiated disconnect.
   */
  private _handleDisconnect(reason?: string): void {
    this._dispatch({
      type: "peer_left",
      data: { reason },
    });
  }
}
