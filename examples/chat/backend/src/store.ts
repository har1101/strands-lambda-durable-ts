// Conversation and message persistence shared by the API and the worker. DynamoDB is the source of truth;
// live events are provisional.
import { setTimeout as sleep } from "node:timers/promises";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const DEFAULT_TITLE = "新しいチャット";

export type ConversationStatus = "idle" | "running" | "waiting_approval" | "failed";
export type PendingApproval = { callbackId: string; interrupt: { id: string; name: string; reason?: unknown } };
export type ConversationSummary = {
  conversationId: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
};
/** `pendingText`: the prompt of the active (or last failed) run. The run saves it as a message only when it completes. */
export type ConversationDetail = ConversationSummary & {
  pendingApproval?: PendingApproval; lastError?: string; activeRunId?: string; pendingText?: string;
};
export type ChatMessage = { seq: number; role: "user" | "assistant"; content: unknown[]; createdAt: string };

/** A Conversations row. `baseSeq` and `executionArn` describe the active run and never leave the API. */
export type ConversationItem = ConversationDetail & {
  userId: string;
  messageCount: number;
  baseSeq?: number;
  executionArn?: string;
};

/** A Messages row. `content` is JSON; content larger than {@link OFFLOAD_BYTES} lives in S3 at `contentKey`. */
type MessageItem = { conversationId: string; seq: number; role: ChatMessage["role"]; createdAt: string; content?: string; contentKey?: string };

/** DynamoDB items are limited to 400 KB; larger message content is stored in S3. */
const OFFLOAD_BYTES = 300 * 1024;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const conversationsTable = () => env("CONVERSATIONS_TABLE");
const messagesTable = () => env("MESSAGES_TABLE");
const bucket = () => env("OFFLOAD_BUCKET");

const now = () => new Date().toISOString();

/** Runs a conditional write. Returns false when the condition did not hold. */
async function conditional(write: Promise<unknown>): Promise<boolean> {
  try {
    await write;
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/** After a failed condition: a missing conversation is `not_found`, an existing one is in the wrong state. */
async function missingOrBusy(error: unknown, userId: string, conversationId: string): Promise<"not_found" | "busy"> {
  if (!(error instanceof ConditionalCheckFailedException)) throw error;
  return await getConversation(userId, conversationId) ? "busy" : "not_found";
}

export function summary(item: ConversationItem): ConversationSummary {
  const { conversationId, title, status, createdAt, updatedAt } = item;
  return { conversationId, title, status, createdAt, updatedAt };
}

export function detail(item: ConversationItem): ConversationDetail {
  const { pendingApproval, lastError, activeRunId, pendingText } = item;
  return { ...summary(item), pendingApproval, lastError, activeRunId, pendingText };
}

export async function getConversation(userId: string, conversationId: string): Promise<ConversationItem | undefined> {
  const response = await dynamo.send(new GetCommand({
    TableName: conversationsTable(),
    Key: { userId, conversationId },
    ConsistentRead: true,
  }));
  return response.Item as ConversationItem | undefined;
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const items: ConversationItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(new QueryCommand({
      TableName: conversationsTable(),
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
      ExclusiveStartKey: startKey,
    }));
    items.push(...(page.Items as ConversationItem[] | undefined ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items.map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createConversation(userId: string, conversationId: string): Promise<ConversationSummary> {
  const at = now();
  const item: ConversationItem = {
    userId, conversationId, title: DEFAULT_TITLE, status: "idle", createdAt: at, updatedAt: at, messageCount: 0,
  };
  await dynamo.send(new PutCommand({
    TableName: conversationsTable(),
    Item: item,
    ConditionExpression: "attribute_not_exists(conversationId)",
  }));
  return summary(item);
}

/** Deletes an idle or failed conversation and its messages. */
export async function deleteConversation(userId: string, conversationId: string): Promise<"deleted" | "not_found" | "busy"> {
  try {
    await dynamo.send(new DeleteCommand({
      TableName: conversationsTable(),
      Key: { userId, conversationId },
      ConditionExpression: "attribute_exists(conversationId) AND NOT #status IN (:running, :waiting)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":running": "running", ":waiting": "waiting_approval" },
    }));
  } catch (error) {
    return missingOrBusy(error, userId, conversationId);
  }
  const keys: Pick<MessageItem, "seq" | "contentKey">[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(new QueryCommand({
      TableName: messagesTable(),
      KeyConditionExpression: "conversationId = :id",
      ExpressionAttributeValues: { ":id": conversationId },
      ProjectionExpression: "seq, contentKey",
      ExclusiveStartKey: startKey,
    }));
    keys.push(...(page.Items as MessageItem[] | undefined ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  await Promise.all(keys.filter(key => key.contentKey).map(key =>
    s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key.contentKey }))));
  await batchWrite(messagesTable(), keys.map(({ seq }) => ({ DeleteRequest: { Key: { conversationId, seq } } })));
  return "deleted";
}

/**
 * Marks an idle or failed conversation as running `runId`. `baseSeq` is the number of stored messages; the worker
 * reads history up to it and writes the run's messages after it.
 */
export async function startRun(userId: string, conversationId: string, runId: string, text: string):
  Promise<{ baseSeq: number } | "not_found" | "busy"> {
  try {
    const response = await dynamo.send(new UpdateCommand({
      TableName: conversationsTable(),
      Key: { userId, conversationId },
      ConditionExpression: "attribute_exists(conversationId) AND #status IN (:idle, :failed)",
      UpdateExpression: "SET #status = :running, activeRunId = :runId, baseSeq = if_not_exists(messageCount, :zero), updatedAt = :now,"
        + " pendingText = :text"
        + " REMOVE pendingApproval, lastError, executionArn",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":idle": "idle", ":failed": "failed", ":running": "running", ":runId": runId, ":zero": 0, ":now": now(), ":text": text,
      },
      ReturnValues: "ALL_NEW",
    }));
    return { baseSeq: (response.Attributes as ConversationItem).baseSeq ?? 0 };
  } catch (error) {
    return missingOrBusy(error, userId, conversationId);
  }
}

export function setExecutionArn(userId: string, conversationId: string, runId: string, executionArn: string): Promise<boolean> {
  return conditional(dynamo.send(new UpdateCommand({
    TableName: conversationsTable(),
    Key: { userId, conversationId },
    ConditionExpression: "activeRunId = :runId",
    UpdateExpression: "SET executionArn = :arn",
    ExpressionAttributeValues: { ":runId": runId, ":arn": executionArn },
  })));
}

export function failRun(userId: string, conversationId: string, runId: string, error: string): Promise<boolean> {
  return conditional(dynamo.send(new UpdateCommand({
    TableName: conversationsTable(),
    Key: { userId, conversationId },
    ConditionExpression: "activeRunId = :runId",
    UpdateExpression: "SET #status = :failed, lastError = :error, updatedAt = :now REMOVE pendingApproval",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":runId": runId, ":failed": "failed", ":error": error.slice(0, 2000), ":now": now() },
  })));
}

export function setPendingApproval(userId: string, conversationId: string, runId: string, pending: PendingApproval): Promise<boolean> {
  return conditional(dynamo.send(new UpdateCommand({
    TableName: conversationsTable(),
    Key: { userId, conversationId },
    ConditionExpression: "activeRunId = :runId",
    UpdateExpression: "SET #status = :waiting, pendingApproval = :pending, updatedAt = :now",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":runId": runId, ":waiting": "waiting_approval", ":pending": pending, ":now": now() },
  })));
}

/** After the callback was answered. The condition keeps a newer approval request raised by the resumed run. */
export function clearPendingApproval(userId: string, conversationId: string, runId: string, callbackId: string): Promise<boolean> {
  return conditional(dynamo.send(new UpdateCommand({
    TableName: conversationsTable(),
    Key: { userId, conversationId },
    ConditionExpression: "activeRunId = :runId AND pendingApproval.callbackId = :callbackId",
    UpdateExpression: "SET #status = :running, updatedAt = :now REMOVE pendingApproval",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":runId": runId, ":callbackId": callbackId, ":running": "running", ":now": now() },
  })));
}

/** Messages in `seq` order, optionally only up to `maxSeq`. */
export async function loadMessages(conversationId: string, maxSeq?: number): Promise<ChatMessage[]> {
  const items: MessageItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(new QueryCommand({
      TableName: messagesTable(),
      KeyConditionExpression: maxSeq === undefined ? "conversationId = :id" : "conversationId = :id AND seq <= :max",
      ExpressionAttributeValues: maxSeq === undefined ? { ":id": conversationId } : { ":id": conversationId, ":max": maxSeq },
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }));
    items.push(...(page.Items as MessageItem[] | undefined ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return Promise.all(items.map(async item => {
    const content = item.contentKey
      ? await (await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: item.contentKey }))).Body!.transformToString("utf-8")
      : item.content!;
    return { seq: item.seq, role: item.role, content: JSON.parse(content) as unknown[], createdAt: item.createdAt };
  }));
}

export type CompleteRunInput = {
  userId: string;
  conversationId: string;
  runId: string;
  baseSeq: number;
  /** The run's new messages (Strands MessageData), stored as seq baseSeq+1, baseSeq+2, ... */
  messages: { role: ChatMessage["role"]; content: unknown[] }[];
  /** The run's user text; becomes the title while the conversation still has the default one. */
  text: string;
};

/**
 * Stores a finished run's messages and returns the conversation to idle. Idempotent: a retry rewrites the same
 * seqs. Does nothing when `runId` is no longer the conversation's active run.
 */
export async function completeRun(input: CompleteRunInput): Promise<{ saved: boolean; messageCount: number }> {
  const { userId, conversationId, runId, baseSeq, messages, text } = input;
  const current = await getConversation(userId, conversationId);
  if (!current || current.activeRunId !== runId) return { saved: false, messageCount: current?.messageCount ?? 0 };
  const at = now();
  const items = await Promise.all(messages.map(async (message, index): Promise<MessageItem> => {
    const seq = baseSeq + 1 + index;
    const content = JSON.stringify(message.content);
    const item: MessageItem = { conversationId, seq, role: message.role, createdAt: at };
    if (Buffer.byteLength(content) <= OFFLOAD_BYTES) return { ...item, content };
    const contentKey = `messages/${conversationId}/${seq}.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: contentKey, Body: content, ContentType: "application/json" }));
    return { ...item, contentKey };
  }));
  await batchWrite(messagesTable(), items.map(item => ({ PutRequest: { Item: item } })));
  const messageCount = baseSeq + messages.length;
  const saved = await conditional(dynamo.send(new UpdateCommand({
    TableName: conversationsTable(),
    Key: { userId, conversationId },
    ConditionExpression: "activeRunId = :runId",
    UpdateExpression: "SET #status = :idle, messageCount = :count, title = :title, updatedAt = :now"
      + " REMOVE activeRunId, pendingApproval, lastError, baseSeq, executionArn, pendingText",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":runId": runId, ":idle": "idle", ":count": messageCount, ":now": at,
      ":title": current.title === DEFAULT_TITLE ? titleFrom(text) : current.title,
    },
  })));
  return { saved, messageCount };
}

function titleFrom(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length === 0) return DEFAULT_TITLE;
  return chars.length > 30 ? `${chars.slice(0, 30).join("")}…` : chars.join("");
}

type WriteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];

/** BatchWriteItem in chunks of 25, resubmitting unprocessed items with a short backoff. */
async function batchWrite(table: string, requests: WriteRequest[]): Promise<void> {
  for (let start = 0; start < requests.length; start += 25) {
    let pending = requests.slice(start, start + 25);
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000, 50 * 2 ** attempt));
      if (attempt >= 8) throw new Error(`BatchWriteItem left ${pending.length} unprocessed items in ${table}`);
      const response = await dynamo.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = response.UnprocessedItems?.[table] ?? [];
    }
  }
}
