// HTTP API (payload v2) behind a Cognito JWT authorizer. The user is always the token's `sub`.
import { randomUUID } from "node:crypto";
import {
  GetDurableExecutionCommand, InvokeCommand, LambdaClient, SendDurableExecutionCallbackSuccessCommand,
} from "@aws-sdk/client-lambda";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import {
  clearPendingApproval, createConversation, deleteConversation, detail, failRun, getConversation, listConversations,
  loadMessages, setExecutionArn, startRun, type ConversationItem,
} from "./store.js";
import type { WorkerRequest } from "./worker.js";

const lambda = new LambdaClient({});
const workerAliasArn = process.env.WORKER_ALIAS_ARN!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A run that has not changed for this long is checked against its durable execution. */
const STALE_MS = 60_000;
/** Callback errors that mean the approval is no longer pending (answered, expired, or execution gone). */
const STALE_CALLBACK_ERRORS: Record<string, true> = {
  CallbackTimeoutException: true,
  InvalidParameterValueException: true,
  ResourceNotFoundException: true,
};

type Result = APIGatewayProxyStructuredResultV2;

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function json(statusCode: number, body?: unknown): Result {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  };
}

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  if (!event.body) return {};
  try {
    const parsed: unknown = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "リクエスト本文が不正な JSON です");
}

async function requireConversation(userId: string, conversationId: string): Promise<ConversationItem> {
  const conversation = await getConversation(userId, conversationId);
  if (!conversation) throw new HttpError(404, "会話が見つかりません");
  return conversation;
}

export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Result> => {
  try {
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (typeof userId !== "string" || userId.length === 0) throw new HttpError(401, "認証が必要です");
    const conversationId = event.pathParameters?.id;
    if (conversationId !== undefined && !UUID.test(conversationId)) throw new HttpError(404, "会話が見つかりません");

    switch (event.routeKey) {
      case "GET /api/conversations":
        return json(200, { conversations: await listConversations(userId) });
      case "POST /api/conversations":
        return json(201, await createConversation(userId, randomUUID()));
      case "GET /api/conversations/{id}":
        return json(200, await getDetail(userId, conversationId!));
      case "DELETE /api/conversations/{id}": {
        const outcome = await deleteConversation(userId, conversationId!);
        if (outcome === "not_found") throw new HttpError(404, "会話が見つかりません");
        if (outcome === "busy") throw new HttpError(409, "実行中の会話は削除できません");
        return json(204);
      }
      case "POST /api/conversations/{id}/messages":
        return json(202, await postMessage(userId, conversationId!, parseBody(event)));
      case "POST /api/conversations/{id}/approval":
        await answerApproval(userId, conversationId!, parseBody(event));
        return json(204);
      default:
        throw new HttpError(404, "見つかりません");
    }
  } catch (error) {
    if (error instanceof HttpError) return json(error.statusCode, { error: error.message });
    console.error(JSON.stringify({ message: "Unhandled API error", routeKey: event.routeKey, error: String(error), stack: (error as Error)?.stack }));
    return json(500, { error: "サーバーエラーが発生しました" });
  }
};

/**
 * The conversation and its messages. A run that has been quiet for a while is checked against its durable
 * execution, so a worker that died without reporting (timeout, stop) does not leave the conversation stuck.
 */
async function getDetail(userId: string, conversationId: string) {
  let conversation = await requireConversation(userId, conversationId);
  const active = conversation.status === "running" || conversation.status === "waiting_approval";
  if (active && conversation.activeRunId && conversation.executionArn
    && Date.now() - Date.parse(conversation.updatedAt) > STALE_MS) {
    try {
      const execution = await lambda.send(new GetDurableExecutionCommand({
        DurableExecutionArn: conversation.executionArn,
        IncludeExecutionData: false,
      }));
      if (execution.Status === "FAILED" || execution.Status === "TIMED_OUT" || execution.Status === "STOPPED") {
        const reason = execution.Error?.ErrorMessage ?? `Durable execution ${execution.Status}`;
        await failRun(userId, conversationId, conversation.activeRunId, reason);
        conversation = await requireConversation(userId, conversationId);
      }
    } catch (error) {
      // The check is a courtesy; the stored state is still a valid answer.
      console.warn(JSON.stringify({ message: "Durable execution check failed", conversationId, error: String(error) }));
    }
  }
  return { conversation: detail(conversation), messages: await loadMessages(conversationId) };
}

async function postMessage(userId: string, conversationId: string, body: Record<string, unknown>): Promise<{ runId: string }> {
  const { text } = body;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 4000) {
    throw new HttpError(400, "text は 1〜4000 文字で指定してください");
  }
  const runId = randomUUID();
  const started = await startRun(userId, conversationId, runId, text);
  if (started === "not_found") throw new HttpError(404, "会話が見つかりません");
  if (started === "busy") throw new HttpError(409, "この会話は実行中です");

  const payload: WorkerRequest = { userId, conversationId, runId, baseSeq: started.baseSeq, text };
  let executionArn: string | undefined;
  try {
    const invoked = await lambda.send(new InvokeCommand({
      FunctionName: workerAliasArn,
      InvocationType: "Event",
      DurableExecutionName: runId,
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    executionArn = invoked.DurableExecutionArn;
  } catch (error) {
    console.error(JSON.stringify({ message: "Worker invoke failed", runId, error: String(error) }));
    await failRun(userId, conversationId, runId, "エージェントを開始できませんでした");
    throw new HttpError(502, "エージェントを開始できませんでした");
  }
  // Used by getDetail to detect a run that ended without reporting. The run may already be finished.
  if (executionArn) await setExecutionArn(userId, conversationId, runId, executionArn);
  return { runId };
}

async function answerApproval(userId: string, conversationId: string, body: Record<string, unknown>): Promise<void> {
  const { callbackId, approved } = body;
  if (typeof callbackId !== "string" || callbackId.length === 0 || typeof approved !== "boolean") {
    throw new HttpError(400, "callbackId (文字列) と approved (真偽値) を指定してください");
  }
  const conversation = await requireConversation(userId, conversationId);
  if (conversation.status !== "waiting_approval" || conversation.pendingApproval?.callbackId !== callbackId || !conversation.activeRunId) {
    throw new HttpError(409, "この承認リクエストは保留中ではありません");
  }
  try {
    await lambda.send(new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: callbackId,
      Result: Buffer.from(JSON.stringify({ approved })),
    }));
  } catch (error) {
    if (error instanceof Error && STALE_CALLBACK_ERRORS[error.name]) {
      throw new HttpError(409, "この承認リクエストは既に処理済みか期限切れです");
    }
    throw error;
  }
  // The resumed run may already have raised a new approval; the condition leaves that one in place.
  await clearPendingApproval(userId, conversationId, conversation.activeRunId, callbackId);
}
