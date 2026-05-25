/**
 * WebRTC Peer Connection wrapper for nullroom-cli
 *
 * Uses werift (pure TypeScript WebRTC) to provide DataChannel connectivity.
 * Mirrors the browser API used in the web app.
 *
 * Ported from app/javascript/modules/peer_connection.js
 */

import { RTCPeerConnection, RTCSessionDescription } from "werift";
import type { RTCDataChannel } from "werift";
import type { IceServer, SignalMessage } from "../types";

type EventHandler = (...args: any[]) => void;

export class PeerConnection {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private fileChannel: RTCDataChannel | null = null;
  private listeners: Record<string, EventHandler[]> = {};
  private _connected: boolean = false;
  private _pendingCandidates: any[] = [];
  private _candidateTypes: Set<string> = new Set();
  private initiator: boolean;

  constructor(options: {
    initiator: boolean;
    iceServers?: IceServer[];
  }) {
    this.initiator = options.initiator;

    // werift expects { urls: string } (single URL string, not an array)
    // Flatten multiple URLs into separate ICE server entries
    const flatIceServers: { urls: string; username?: string; credential?: string }[] = [];
    for (const s of options.iceServers || []) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      for (const url of urls) {
        flatIceServers.push({
          urls: url,
          username: s.username,
          credential: s.credential,
        });
      }
    }

    // Create RTCPeerConnection with ICE servers
    this.pc = new RTCPeerConnection({
      iceServers: flatIceServers,
    });

    // Handle ICE candidates
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        const cType = this._extractCandidateType(candidate);
        if (cType) {
          this._candidateTypes.add(cType.toUpperCase());
          this._emit("ice-candidate", cType);
        }

        this._emit("signal", {
          type: "candidate",
          candidate: {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          },
        });
      }
    });

    // Handle connection state changes
    this.pc.iceConnectionStateChange.subscribe((state) => {
      if (state === "connected") {
        if (this._connected) this._emit("connect");
      } else if (state === "failed") {
        this._emit("connection-failed");
        this._emit("close");
      } else if (state === "closed") {
        this._emit("close");
      }
    });

    // If initiator, create data channels
    if (this.initiator) {
      this._createDataChannels();
    } else {
      // Wait for data channels from the initiator
      this.pc.onDataChannel.subscribe((channel) => {
        if (channel.label === "nullroom-files") {
          this.fileChannel = channel;
          this._setupFileChannel();
        } else if (channel.label === "nullroom") {
          this.dataChannel = channel;
          this._setupDataChannel();
        }
      });
    }
  }

  /**
   * Detect whether the active path is direct or relayed.
   */
  async detectConnectionType(): Promise<"direct" | "relay"> {
    try {
      const stats = await this.pc.getStats();
      let activePairId: string | null = null;

      for (const report of stats.values()) {
        const r = report as any;
        if (r.type === "transport" && r.selectedCandidatePairId) {
          activePairId = r.selectedCandidatePairId;
          break;
        }
      }

      if (!activePairId) {
        for (const report of stats.values()) {
          const r = report as any;
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) {
            activePairId = r.id;
            break;
          }
        }
      }

      if (!activePairId) {
        return "direct";
      }

      const pair = stats.get(activePairId) as any;
      if (!pair) return "direct";

      const localCandidate = pair.localCandidateId
        ? (stats.get(pair.localCandidateId) as any)
        : undefined;
      const remoteCandidate = pair.remoteCandidateId
        ? (stats.get(pair.remoteCandidateId) as any)
        : undefined;

      const localType = localCandidate?.candidateType;
      const remoteType = remoteCandidate?.candidateType;

      return localType === "relay" || remoteType === "relay" ? "relay" : "direct";
    } catch {
      return "direct";
    }
  }

  /**
   * Return gathered ICE candidate types in uppercase form.
   */
  getCandidateTypes(): Set<string> {
    return new Set(this._candidateTypes);
  }

  private _createDataChannels(): void {
    this.dataChannel = this.pc.createDataChannel("nullroom", {
      ordered: true,
    });
    this._setupDataChannel();

    this.fileChannel = this.pc.createDataChannel("nullroom-files", {
      ordered: true,
    });
    this._setupFileChannel();
  }

  private _setupDataChannel(): void {
    if (!this.dataChannel) return;

    // werift uses stateChanged event and onMessage event
    this.dataChannel.stateChanged.subscribe((state) => {
      if (state === "open") {
        this._emit("datachannel-open");
      } else if (state === "closed") {
        this._emit("close");
      }
    });

    this.dataChannel.onMessage.subscribe((msg) => {
      if (typeof msg === "string") {
        this._emit("data", msg);
      } else {
        // Buffer → string
        this._emit("data", msg.toString("utf-8"));
      }
    });
  }

  private _setupFileChannel(): void {
    if (!this.fileChannel) return;

    this.fileChannel.stateChanged.subscribe((state) => {
      if (state === "open") {
        this._emit("file-channel-ready");
      }
    });

    this.fileChannel.onMessage.subscribe((msg) => {
      if (typeof msg === "string") {
        // String data on file channel — could be control JSON
        this._emit("data", msg);
      } else {
        // Binary data - extract ArrayBuffer
        const buf = msg instanceof Buffer ? msg : Buffer.from(msg);
        this._emit(
          "file-data",
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        );
      }
    });
  }

  /**
   * Create and send an SDP offer (initiator only).
   */
  async createOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this._emit("signal", {
      type: "offer",
      sdp: {
        type: this.pc.localDescription!.type,
        sdp: this.pc.localDescription!.sdp,
      },
    });
  }

  /**
   * Process an incoming signal (offer/answer/candidate).
   */
  async signal(data: SignalMessage): Promise<void> {
    try {
      if (data.type === "offer" && data.sdp) {
        await this.pc.setRemoteDescription(
          new RTCSessionDescription(data.sdp.sdp, data.sdp.type as any)
        );
        await this._flushPendingCandidates();
        await this._createAnswer();
      } else if (data.type === "answer" && data.sdp) {
        await this.pc.setRemoteDescription(
          new RTCSessionDescription(data.sdp.sdp, data.sdp.type as any)
        );
        await this._flushPendingCandidates();
      } else if (data.type === "candidate" && data.candidate) {
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate({
            candidate: data.candidate.candidate,
            sdpMid: data.candidate.sdpMid ?? undefined,
            sdpMLineIndex: data.candidate.sdpMLineIndex ?? undefined,
          } as any);
        } else {
          this._pendingCandidates.push(data.candidate);
        }
      }
    } catch (error) {
      this._emit("error", error);
    }
  }

  private async _createAnswer(): Promise<void> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this._emit("signal", {
      type: "answer",
      sdp: {
        type: this.pc.localDescription!.type,
        sdp: this.pc.localDescription!.sdp,
      },
    });
  }

  private async _flushPendingCandidates(): Promise<void> {
    if (!this._pendingCandidates.length) return;
    const queued = this._pendingCandidates;
    this._pendingCandidates = [];

    for (const candidate of queued) {
      await this.pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      } as any);
    }
  }

  /**
   * Mark the connection as fully ready (post PQ-upgrade).
   * Emits the "connect" event that enables messaging.
   */
  confirmReady(): void {
    this._connected = true;
    this._emit("connect");
  }

  /**
   * Send a string message on the primary data channel.
   */
  send(data: string): void {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(data);
    }
  }

  /**
   * Send binary data on the file channel.
   */
  sendFile(data: ArrayBuffer | Buffer): void {
    if (this.fileChannel && this.fileChannel.readyState === "open") {
      const buf = data instanceof Buffer ? data : Buffer.from(new Uint8Array(data));
      this.fileChannel.send(buf);
    }
  }

  /**
   * Get the buffered amount on the file channel (for backpressure).
   */
  getFileBufferedAmount(): number {
    return this.fileChannel?.bufferedAmount ?? 0;
  }

  /**
   * Register an event handler.
   */
  on(event: string, callback: EventHandler): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, callback: EventHandler): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((h) => h !== callback);
    }
  }

  private _emit(event: string, data?: any): void {
    if (this.listeners[event]) {
      for (const callback of this.listeners[event]) {
        callback(data);
      }
    }
  }

  private _extractCandidateType(candidate: any): string | null {
    if (candidate?.type && typeof candidate.type === "string") {
      return candidate.type;
    }
    if (candidate?.candidate && typeof candidate.candidate === "string") {
      const match = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(candidate.candidate);
      const candidateType = match?.[1];
      if (candidateType) {
        return candidateType.toLowerCase();
      }
    }
    return null;
  }

  /**
   * Destroy the peer connection and all channels.
   */
  destroy(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.fileChannel) {
      this.fileChannel.close();
    }
    this.pc.close();
    this.listeners = {};
  }
}
