// Worker smoke test against a deployed stack, bypassing the HTTP API.
// Usage: node scripts/smoke.mjs <replay|approval|parallel>
//   Env: WORKER_ALIAS_ARN, CONVERSATIONS_TABLE, MESSAGES_TABLE (stack outputs), AWS_REGION / AWS_PROFILE.
//   replay   - the first model call's step completes, the execution waits 2 s, and the rest runs in a second
//              invocation that replays model-1 from its checkpoint.
//   approval - issue_refund raises an interrupt; the execution suspends on a durable callback, this script approves,
//              and the same tool use resumes with the answer.
//   parallel - two lookup_order calls from one model turn run as separate child contexts of that turn.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  GetDurableExecutionCommand, GetDurableExecutionHistoryCommand, InvokeCommand, LambdaClient,
  SendDurableExecutionCallbackSuccessCommand,
} from "@aws-sdk/client-lambda";

const PROMPTS = {
  replay: "add_numbers を使って 7 と 8 を足して、結果を日本語の一文で答えて。",
  approval: "注文 A-1001 に 3000 円を返金して",
  parallel: "注文 A-1001 と B-2002 を同時に調べて、それぞれのステータスと金額を教えて。",
};

const scenario = process.argv[2] ?? "replay";
if (!(scenario in PROMPTS)) throw new Error(`Unknown scenario: ${scenario} (replay | approval | parallel)`);
const { WORKER_ALIAS_ARN: workerAliasArn, CONVERSATIONS_TABLE: conversationsTable, MESSAGES_TABLE: messagesTable } = process.env;
if (!workerAliasArn || !conversationsTable || !messagesTable) {
  throw new Error("Set WORKER_ALIAS_ARN, CONVERSATIONS_TABLE and MESSAGES_TABLE");
}

const lambda = new LambdaClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const userId = `smoke-${randomUUID()}`;
const conversationId = randomUUID();
const runId = randomUUID();
const key = { userId, conversationId };
const start = Date.now();

async function history(arn) {
  const events = [];
  let marker;
  do {
    const page = await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: arn, Marker: marker }));
    events.push(...(page.Events ?? []));
    marker = page.NextMarker;
  } while (marker);
  return events;
}

async function messages() {
  const items = [];
  let startKey;
  do {
    const page = await dynamo.send(new QueryCommand({
      TableName: messagesTable,
      KeyConditionExpression: "conversationId = :id",
      ExpressionAttributeValues: { ":id": conversationId },
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

try {
  // The row the API would have created and marked running (startRun).
  const now = new Date().toISOString();
  await dynamo.send(new PutCommand({
    TableName: conversationsTable,
    Item: {
      ...key, title: "新しいチャット", status: "running", activeRunId: runId, baseSeq: 0, messageCount: 0,
      createdAt: now, updatedAt: now,
    },
  }));
  const invoked = await lambda.send(new InvokeCommand({
    FunctionName: workerAliasArn,
    InvocationType: "Event",
    DurableExecutionName: runId,
    Payload: Buffer.from(JSON.stringify({
      userId, conversationId, runId, baseSeq: 0, text: PROMPTS[scenario], ...(scenario === "replay" && { replayProbe: true }),
    })),
  }));
  const arn = invoked.DurableExecutionArn;
  if (!arn) throw new Error("Lambda did not return a durable execution ARN");

  let conversation;
  let approval;
  for (const deadline = Date.now() + 240_000; ; await sleep(1000)) {
    if (Date.now() > deadline) throw new Error(`Timed out; last status ${conversation?.status}: ${arn}`);
    conversation = (await dynamo.send(new GetCommand({ TableName: conversationsTable, Key: key, ConsistentRead: true }))).Item;
    if (conversation?.status === "idle" || conversation?.status === "failed") break;
    if (conversation?.status === "waiting_approval" && !approval) {
      if (scenario !== "approval") throw new Error(`Unexpected approval request: ${JSON.stringify(conversation.pendingApproval)}`);
      // Give the invocation time to end, then confirm the execution is suspended rather than holding a handler.
      await sleep(5000);
      const suspendedInvocations = (await history(arn)).filter(e => e.EventType === "InvocationCompleted").length;
      if (suspendedInvocations < 1) throw new Error("The execution did not end its invocation while waiting for approval");
      approval = { ...conversation.pendingApproval, suspendedInvocations, waitingAtMs: Date.now() - start };
      await lambda.send(new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: approval.callbackId,
        Result: Buffer.from(JSON.stringify({ approved: true })),
      }));
    }
  }

  let execution;
  for (let i = 0; i < 30; i++) {
    execution = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn }));
    if (execution.Status !== "RUNNING") break;
    await sleep(1000);
  }
  const events = await history(arn);
  const saved = await messages();
  const steps = events.filter(e => e.EventType === "StepStarted");
  const stepNames = steps.map(e => e.Name);
  const contextName = new Map(events.filter(e => e.EventType === "ContextStarted").map(e => [e.Id, e.Name]));
  const invocations = events.filter(e => e.EventType === "InvocationCompleted").length;
  // Message content is stored as JSON text; a tool result may nest the tool's JSON output as escaped text.
  const savedText = saved.map(m => m.content ?? "").join("\n");
  const summary = {
    scenario, runId, durableExecutionArn: arn, status: execution?.Status, conversationStatus: conversation.status,
    lastError: conversation.lastError, totalMs: Date.now() - start, invocations, steps: stepNames,
    contexts: [...contextName.values()], savedMessages: saved.length, title: conversation.title,
  };

  const failures = [];
  if (execution?.Status !== "SUCCEEDED") failures.push(`execution ${execution?.Status}`);
  if (conversation.status !== "idle") failures.push(`conversation ${conversation.status}`);
  if (stepNames.filter(name => name === "model-1").length !== 1) failures.push("model-1 must start exactly once");
  if (scenario === "replay") {
    const waits = events.filter(e => e.EventType === "WaitStarted" && e.Name === "replay-after-model").length;
    if (waits !== 1) failures.push(`replay-after-model waits: ${waits}`);
    if (invocations !== 2) failures.push(`invocations: ${invocations} (expected 2)`);
  } else if (scenario === "approval") {
    const refundSteps = stepNames.filter(name => name?.startsWith("tool-issue_refund-"));
    if (refundSteps.length !== 2) failures.push(`issue_refund steps: ${refundSteps.length} (interrupted + resumed)`);
    if (invocations < 2) failures.push("the callback must resume in a new invocation");
    if (!/\\*"status\\*":\\*"issued/.test(savedText)) failures.push("saved messages do not contain an issued refund");
    summary.approval = approval;
  } else {
    const lookups = steps.filter(e => e.Name?.startsWith("tool-lookup_order-"));
    const parents = lookups.map(e => contextName.get(e.ParentId));
    if (lookups.length < 2) failures.push(`lookup_order steps: ${lookups.length}`);
    if (!parents.every(name => /^tools-1-\d+$/.test(name ?? "")) || new Set(parents).size !== parents.length) {
      failures.push(`lookup_order steps must run in distinct tools-1-* child contexts: ${JSON.stringify(parents)}`);
    }
    summary.lookupContexts = parents;
  }
  summary.failures = failures;
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  const keys = await messages();
  for (let i = 0; i < keys.length; i += 25) {
    await dynamo.send(new BatchWriteCommand({
      RequestItems: { [messagesTable]: keys.slice(i, i + 25).map(({ seq }) => ({ DeleteRequest: { Key: { conversationId, seq } } })) },
    }));
  }
  await dynamo.send(new DeleteCommand({ TableName: conversationsTable, Key: key }));
}
