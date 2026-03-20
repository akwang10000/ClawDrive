import WebSocket from "ws";
import { randomUUID } from "crypto";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64Url,
  signPayload,
} from "./device-identity";
import { log, logError } from "./logger";
import { PendingRequestStore } from "./gateway-pending";

const PROTOCOL_VERSION = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type InvokeHandler = (
  command: string,
  params: unknown,
  timeoutMs?: number
) => Promise<
  | { ok: true; payload?: unknown }
  | { ok: false; error: { code: string; message: string } }
>;

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface GatewayClientOptions {
  host: string;
  port: number;
  tls: boolean;
  token?: string;
  displayName: string;
  commands: string[];
  caps: string[];
  clientVersion: string;
  deviceIdentityPath: string;
  legacyDeviceIdentityPaths?: string[];
  onInvoke: InvokeHandler;
  onStateChange: (state: ConnectionState) => void;
  requestTimeoutMs?: number;
}

interface InvokeRequestPayload {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private readonly pending = new PendingRequestStore();
  private readonly nodeId = randomUUID();
  private readonly opts: GatewayClientOptions;
  private closed = false;
  private backoffMs = 1_000;
  private _state: ConnectionState = "disconnected";
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  get state(): ConnectionState {
    return this._state;
  }

  start(): void {
    if (this._state === "connecting" || this._state === "connected") {
      return;
    }
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.pending.clear(new Error("client stopped"));
    this.setState("disconnected");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected"));
        return;
      }

      const id = randomUUID();
      const timeoutMs = Math.max(1_000, this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.add(
        id,
        method,
        timeoutMs,
        (value) => resolve(value as T),
        reject,
        (timedOutMethod, durationMs) => {
          logError(`Gateway request timed out: ${timedOutMethod} (${durationMs}ms)`);
        }
      );

      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (error) {
        const entry = this.pending.take(id);
        if (entry) {
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private setState(state: ConnectionState): void {
    this._state = state;
    this.opts.onStateChange(state);
  }

  private connect(): void {
    if (this.closed) {
      return;
    }

    const scheme = this.opts.tls ? "wss" : "ws";
    const url = `${scheme}://${this.opts.host}:${this.opts.port}`;
    this.setState("connecting");
    log(`Connecting to ${url}`);

    const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
    this.ws = ws;

    ws.on("open", () => {
      log("WebSocket connected, waiting for challenge");
      this.queueConnect();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        this.handleMessage(data.toString());
      } catch (error) {
        logError(`Failed to parse Gateway frame: ${String(error)}`);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      log(`WebSocket closed (${code}): ${reason.toString()}`);
      this.ws = null;
      this.pending.clear(new Error(`closed (${code})`));
      this.setState("disconnected");
      this.scheduleReconnect();
    });

    ws.on("error", (error: Error) => {
      logError(`WebSocket error: ${error.message}`);
    });
  }

  private queueConnect(): void {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
    }
    this.connectTimer = setTimeout(() => this.sendConnect(), 750);
  }

  private sendConnect(): void {
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const token = this.opts.token?.trim() || undefined;
    const signedAtMs = Date.now();
    const nonce = this.connectNonce ?? undefined;
    const identity = loadOrCreateDeviceIdentity(
      this.opts.deviceIdentityPath,
      this.opts.legacyDeviceIdentityPaths ?? []
    );
    const version = nonce ? "v2" : "v1";
    const clientId = "node-host";
    const payloadParts = [
      version,
      identity.deviceId,
      clientId,
      "node",
      "node",
      "",
      String(signedAtMs),
      token ?? "",
    ];
    if (nonce) {
      payloadParts.push(nonce);
    }
    const payload = payloadParts.join("|");
    const signature = signPayload(identity.privateKeyPem, payload);

    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: clientId,
        displayName: this.opts.displayName,
        version: this.opts.clientVersion,
        platform: process.platform,
        mode: "node",
        instanceId: this.nodeId,
      },
      caps: this.opts.caps,
      commands: this.opts.commands,
      auth: token ? { token } : undefined,
      role: "node",
      scopes: [] as string[],
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };

    void this.request("connect", params)
      .then(() => {
        this.backoffMs = 1_000;
        this.setState("connected");
        log("Connected to Gateway");
      })
      .catch((error) => {
        logError(`Connect rejected: ${error instanceof Error ? error.message : String(error)}`);
        this.ws?.close(1008, "connect failed");
      });
  }

  private handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.type === "event" || typeof parsed.event === "string") {
      const event = typeof parsed.event === "string" ? parsed.event : "";
      if (event === "connect.challenge") {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        const nonce = typeof payload?.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          this.sendConnect();
        }
        return;
      }

      if (event === "node.invoke.request") {
        const payload = this.coerceInvokePayload(parsed.payload);
        if (payload) {
          void this.handleInvoke(payload);
        }
      }
      return;
    }

    if (parsed.type === "res" || typeof parsed.id === "string") {
      const id = typeof parsed.id === "string" ? parsed.id : "";
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }

      const payload = parsed.payload as Record<string, unknown> | undefined;
      if (payload?.status === "accepted") {
        return;
      }

      this.pending.take(id);
      if (parsed.ok) {
        entry.resolve(parsed.payload);
      } else {
        const error = parsed.error as Record<string, unknown> | undefined;
        entry.reject(new Error(typeof error?.message === "string" ? error.message : "unknown error"));
      }
    }
  }

  private coerceInvokePayload(payload: unknown): InvokeRequestPayload | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const frame = payload as Record<string, unknown>;
    const id = typeof frame.id === "string" ? frame.id.trim() : "";
    const nodeId = typeof frame.nodeId === "string" ? frame.nodeId.trim() : "";
    const command = typeof frame.command === "string" ? frame.command.trim() : "";
    if (!id || !nodeId || !command) {
      return null;
    }

    const paramsJSON =
      typeof frame.paramsJSON === "string"
        ? frame.paramsJSON
        : frame.params !== undefined
          ? JSON.stringify(frame.params)
          : null;

    return {
      id,
      nodeId,
      command,
      paramsJSON,
      timeoutMs: typeof frame.timeoutMs === "number" ? frame.timeoutMs : null,
    };
  }

  private async handleInvoke(frame: InvokeRequestPayload): Promise<void> {
    let params: unknown = {};
    if (frame.paramsJSON) {
      try {
        params = JSON.parse(frame.paramsJSON);
      } catch {
        params = {};
      }
    }

    log(`invoke request: ${frame.command}`);
    try {
      const result = await this.opts.onInvoke(frame.command, params, frame.timeoutMs ?? undefined);
      await this.sendInvokeResult(frame, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendInvokeResult(frame, {
        ok: false,
        error: { code: "INTERNAL_ERROR", message },
      });
    }
  }

  private async sendInvokeResult(
    frame: InvokeRequestPayload,
    result:
      | { ok: true; payload?: unknown }
      | { ok: false; error: { code: string; message: string } }
  ): Promise<void> {
    const params: Record<string, unknown> = {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: result.ok,
    };

    if (result.ok) {
      if (result.payload !== undefined) {
        params.payloadJSON = JSON.stringify(result.payload);
      }
    } else {
      params.error = result.error;
    }

    log(`invoke result: ${frame.command} ok=${result.ok}`);
    try {
      await this.request("node.invoke.result", params);
    } catch (error) {
      logError(`Failed to send invoke result: ${String(error)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    log(`Reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (!this.closed) {
        this.connect();
      }
    }, delay);
  }
}
