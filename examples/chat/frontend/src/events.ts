// Minimal AppSync Events WebSocket client (Cognito user pool auth), following
// https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html

export type ConnectionState = "disconnected" | "connecting" | "connected";

type Subscription = {
  channel: string;
  onEvent: (event: unknown) => void;
  onError?: (message: string) => void;
};

type ServerMessage = {
  type: string;
  id?: string;
  connectionTimeoutMs?: number;
  event?: unknown;
  errors?: { errorType?: string; message?: string }[];
};

const MAX_BACKOFF_MS = 30_000;

function errorText(message: ServerMessage): string {
  return message.errors?.map(e => e.message ?? e.errorType).join("; ") || message.type;
}

export class EventsClient {
  private socket?: WebSocket;
  private state: ConnectionState = "disconnected";
  private readonly listeners = new Set<() => void>();
  private readonly subscriptions = new Map<string, Subscription>();
  private keepAliveTimer?: ReturnType<typeof setTimeout>;
  private keepAliveMs = 300_000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private closed = false;

  constructor(
    private readonly httpDomain: string,
    private readonly realtimeDomain: string,
    private readonly getIdToken: () => string | undefined,
  ) {}

  getState = (): ConnectionState => this.state;

  onStateChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Subscribes to a channel; the returned function unsubscribes. Survives reconnects. */
  subscribe(channel: string, onEvent: (event: unknown) => void, onError?: (message: string) => void): () => void {
    const id = crypto.randomUUID();
    this.subscriptions.set(id, { channel, onEvent, onError });
    this.closed = false;
    if (this.state === "connected") this.sendSubscribe(id, channel);
    else this.connect();
    return () => {
      if (!this.subscriptions.delete(id)) return;
      if (this.state === "connected") this.send({ type: "unsubscribe", id });
    };
  }

  /** Closes the connection and drops every subscription (sign-out). */
  close(): void {
    this.closed = true;
    this.subscriptions.clear();
    clearTimeout(this.reconnectTimer);
    this.teardown();
    this.setState("disconnected");
  }

  private connect(): void {
    if (this.closed || this.socket || this.reconnectTimer) return;
    const token = this.getIdToken();
    if (!token) {
      this.scheduleReconnect();
      return;
    }
    this.setState("connecting");
    // Connection auth travels as a subprotocol: `header-` + base64url(JSON {host, Authorization}).
    const header = btoa(JSON.stringify({ host: this.httpDomain, Authorization: token }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const socket = new WebSocket(`wss://${this.realtimeDomain}/event/realtime`, [
      "aws-appsync-event-ws",
      `header-${header}`,
    ]);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
    socket.onmessage = message => {
      if (this.socket === socket) this.handleMessage(JSON.parse(String(message.data)) as ServerMessage);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.teardown();
      this.setState("disconnected");
      this.scheduleReconnect();
    };
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "connection_ack":
        this.attempts = 0;
        this.keepAliveMs = message.connectionTimeoutMs ?? this.keepAliveMs;
        this.resetKeepAlive();
        this.setState("connected");
        for (const [id, subscription] of this.subscriptions) this.sendSubscribe(id, subscription.channel);
        return;
      case "ka":
        this.resetKeepAlive();
        return;
      case "data": {
        const subscription = message.id ? this.subscriptions.get(message.id) : undefined;
        if (!subscription) return;
        // The doc shows `event` as an array of JSON strings; the service sends a single JSON string. Accept both.
        const payloads = Array.isArray(message.event) ? message.event : [message.event];
        for (const payload of payloads) {
          try {
            subscription.onEvent(typeof payload === "string" ? JSON.parse(payload) : payload);
          } catch (error) {
            console.warn("Failed to handle event", error);
          }
        }
        return;
      }
      case "subscribe_error": {
        const subscription = message.id ? this.subscriptions.get(message.id) : undefined;
        if (!subscription || !message.id) return;
        this.subscriptions.delete(message.id);
        console.warn(`Subscription to ${subscription.channel} failed: ${errorText(message)}`);
        subscription.onError?.(errorText(message));
        return;
      }
      case "broadcast_error":
        console.warn(`Broadcast error: ${errorText(message)}`);
        return;
      case "connection_error":
      case "error":
        // Typically an expired or invalid token; reconnecting picks up the renewed token.
        console.warn(`AppSync Events error: ${errorText(message)}`);
        this.socket?.close();
        return;
      default:
        return; // subscribe_success, unsubscribe_success, unsubscribe_error
    }
  }

  private sendSubscribe(id: string, channel: string): void {
    const token = this.getIdToken();
    if (!token) return;
    this.send({ type: "subscribe", id, channel, authorization: { host: this.httpDomain, Authorization: token } });
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private resetKeepAlive(): void {
    clearTimeout(this.keepAliveTimer);
    // No "ka" within connectionTimeoutMs: the connection is dead; close it and reconnect.
    this.keepAliveTimer = setTimeout(() => this.socket?.close(), this.keepAliveMs);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subscriptions.size === 0 || this.reconnectTimer) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts);
    this.attempts += 1;
    const delay = base / 2 + Math.random() * (base / 2); // jittered exponential backoff
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private teardown(): void {
    clearTimeout(this.keepAliveTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
