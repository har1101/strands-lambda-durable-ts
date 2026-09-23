// Publishes live events to AppSync Events over its HTTP endpoint with SigV4 (IAM) auth. Live events are
// provisional: publishing is advisory and never fails the durable step it runs in.
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { DurableLiveEvent, EventSink } from "strands-lambda-durable";

/** The event shapes on `/chat/{userId}/{conversationId}`, without `runId`. */
export type ChatEvent =
  | DurableLiveEvent
  | { kind: "run_started" }
  | { kind: "approval"; callbackId: string; interrupt: { id: string; name: string; reason?: unknown } }
  | { kind: "done" }
  | { kind: "failed"; error: string };

export type LiveEvent = { runId: string } & ChatEvent;

/** AppSync Events accepts at most 240 KB per event; oversized tool results are sent without `result`. */
const MAX_EVENT_BYTES = 200 * 1024;

export class AppSyncPublisher {
  private readonly signer: SignatureV4;

  constructor(private readonly httpDomain: string, region: string) {
    this.signer = new SignatureV4({ service: "appsync", region, credentials: defaultProvider(), sha256: Sha256 });
  }

  /** POSTs one event to `channel`. Logs and swallows every error. */
  async publish(channel: string, event: LiveEvent): Promise<void> {
    try {
      let payload = JSON.stringify(event);
      if (Buffer.byteLength(payload) > MAX_EVENT_BYTES && event.kind === "tool") {
        const { result: _omitted, ...rest } = event;
        payload = JSON.stringify(rest);
      }
      const body = JSON.stringify({ channel, events: [payload] });
      const signed = await this.signer.sign(new HttpRequest({
        method: "POST",
        protocol: "https:",
        hostname: this.httpDomain,
        path: "/event",
        headers: { "content-type": "application/json", host: this.httpDomain },
        body,
      }));
      // fetch sets Host itself from the URL; the signed value is identical.
      const { host: _host, ...headers } = signed.headers;
      const response = await fetch(`https://${this.httpDomain}/event`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      // A 200 response can still report per-event failures in `failed`.
      if (!response.ok || (JSON.parse(text) as { failed?: unknown[] }).failed?.length) {
        console.warn(JSON.stringify({ message: "AppSync publish rejected", channel, kind: event.kind, status: response.status, body: text }));
      }
    } catch (error) {
      console.warn(JSON.stringify({ message: "AppSync publish failed", channel, kind: event.kind, error: String(error) }));
    }
  }
}

/** Live events of one run of one conversation. Also the library's {@link EventSink} for model and tool events. */
export class ChatChannel implements EventSink {
  readonly channel: string;

  constructor(private readonly publisher: AppSyncPublisher, userId: string, conversationId: string, private readonly runId: string) {
    this.channel = `/chat/${userId}/${conversationId}`;
  }

  put(event: DurableLiveEvent): Promise<void> {
    return this.publish(event);
  }

  publish(event: ChatEvent): Promise<void> {
    return this.publisher.publish(this.channel, { runId: this.runId, ...event });
  }
}
