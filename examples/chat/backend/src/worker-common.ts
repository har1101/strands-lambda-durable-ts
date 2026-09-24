// Shared by both worker implementations (worker.ts: Strands, worker-minamo.ts: minamo): the request the API
// sends, the system prompt, and the fake shop behind the tools.
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export type WorkerRequest = {
  userId: string;
  conversationId: string;
  runId: string;
  /** Messages with seq <= baseSeq are the history; this run's messages are stored after it. */
  baseSeq: number;
  text: string;
  /** Smoke test: suspend for 2 s after the first model call so the rest of the run replays in a new invocation. */
  replayProbe?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validate(request: WorkerRequest): void {
  if (typeof request.userId !== "string" || !/^[A-Za-z0-9-]{1,50}$/.test(request.userId)) throw new Error("Invalid userId");
  if (typeof request.conversationId !== "string" || !UUID.test(request.conversationId)) throw new Error("Invalid conversationId");
  if (typeof request.runId !== "string" || !UUID.test(request.runId)) throw new Error("Invalid runId");
  if (!Number.isInteger(request.baseSeq) || request.baseSeq < 0) throw new Error("Invalid baseSeq");
  if (typeof request.text !== "string" || request.text.length < 1 || request.text.length > 4000) throw new Error("Invalid text");
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const SYSTEM_PROMPT = [
  "あなたはオンラインストアのサポートアシスタントです。ユーザーと同じ言語で、簡潔に答えてください。",
  "注文の確認には lookup_order を使います。複数の注文など互いに独立した照会は、1回の応答でまとめて並列に呼び出してください。",
  "返金には必ず issue_refund を呼び出してください。担当者の承認後に実行されます。結果の status と refundId を伝えてください。",
  "計算には add_numbers を使ってください。",
  "ユーザー向けの本文だけを出力し、<thinking> などの内部タグは出力しないでください。",
].join("\n");

/** Tool descriptions, identical for both workers so the model sees the same tools. */
export const TOOL_DESCRIPTIONS = {
  add_numbers: "2つの数値を正確に足し算します。合計を答えるときに使います。",
  lookup_order: "注文ID (例: A-1001) から注文のステータス、金額、商品を取得します。",
  issue_refund: "注文の返金を実行します。すべての返金は担当者の承認が必要です。呼び出して結果を報告してください。",
} as const;

type Order = {
  status: string;
  amount: number;
  currency: string;
  orderedAt: string;
  items: { name: string; quantity: number; price: number }[];
};

/** Fake order data; stands in for a real order API. */
const ORDERS: Record<string, Order> = {
  "A-1001": {
    status: "delivered", amount: 12800, currency: "JPY", orderedAt: "2026-08-02",
    items: [{ name: "ワイヤレスイヤホン", quantity: 1, price: 9800 }, { name: "充電ケーブル", quantity: 2, price: 1500 }],
  },
  "B-2002": {
    status: "shipped", amount: 4500, currency: "JPY", orderedAt: "2026-09-15",
    items: [{ name: "ステンレスボトル", quantity: 1, price: 4500 }],
  },
  "C-3003": {
    status: "processing", amount: 23600, currency: "JPY", orderedAt: "2026-09-21",
    items: [{ name: "デスクライト", quantity: 1, price: 18600 }, { name: "電球", quantity: 2, price: 2500 }],
  },
};

export async function lookupOrder(orderId: string) {
  await sleep(500); // latency of a real order API; makes parallel tool execution visible
  const order = ORDERS[orderId.trim().toUpperCase()];
  return order ? { found: true, orderId, ...order } : { found: false, orderId };
}

/** A real payment API would receive the idempotency key, so a retried or replayed call cannot refund twice. */
export function issueRefund(orderId: string, amount: number, idempotencyKey: string) {
  const refundId = `rf-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12)}`;
  return { status: "issued", orderId, amount, refundId };
}
