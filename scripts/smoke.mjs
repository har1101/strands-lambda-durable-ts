import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand, GetDurableExecutionCommand, GetDurableExecutionHistoryCommand } from "@aws-sdk/client-lambda";

const functionArn = process.env.DURABLE_FUNCTION_ARN;
const table = process.env.EVENTS_TABLE;
if (!functionArn || !table) throw new Error("Set DURABLE_FUNCTION_ARN and EVENTS_TABLE");

const lambda = new LambdaClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const runId = randomUUID();
const start = Date.now();
const invoked = await lambda.send(new InvokeCommand({
  FunctionName: functionArn,
  InvocationType: "Event",
  DurableExecutionName: runId,
  Payload: new TextEncoder().encode(JSON.stringify({
    runId,
    prompt: "Use add_numbers to add 7 and 8. Give the result in one Japanese sentence.",
    replayProbe: true,
  })),
}));
const arn = invoked.DurableExecutionArn;
if (!arn) throw new Error("Lambda did not return a durable execution ARN");

let cursor;
let firstTextMs;
let done;
const counts = { model_start: 0, text: 0, tool: 0, done: 0 };
while (!done && Date.now() - start < 90000) {
  const response = await dynamo.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: cursor ? "runId = :r AND #k > :c" : "runId = :r",
    ...(cursor ? { ExpressionAttributeNames: { "#k": "key" } } : {}),
    ExpressionAttributeValues: cursor ? { ":r": runId, ":c": cursor } : { ":r": runId },
    ConsistentRead: true,
  }));
  for (const event of response.Items ?? []) {
    cursor = event.key;
    if (event.kind in counts) counts[event.kind]++;
    if (event.kind === "text" && firstTextMs === undefined) firstTextMs = Date.now() - start;
    if (event.kind === "done") done = event;
  }
  if (!done) await new Promise(resolve => setTimeout(resolve, 250));
}
if (!done) throw new Error(`No completion event in 90 seconds: ${arn}`);

let execution;
for (let i = 0; i < 20; i++) {
  execution = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: arn }));
  if (execution.Status !== "RUNNING" && execution.Status !== "PENDING") break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
const history = await lambda.send(new GetDurableExecutionHistoryCommand({ DurableExecutionArn: arn }));
const events = history.Events ?? [];
const stepNames = events.filter(e => e.EventType === "StepStarted").map(e => e.Name);
const countStep = name => stepNames.filter(s => s === name).length;
const toolSteps = stepNames.filter(s => s?.startsWith("tool-add_numbers-"));
const invocations = events.filter(e => e.EventType === "InvocationCompleted").length;
const waits = events.filter(e => e.EventType === "WaitStarted" && e.Name === "replay-after-model").length;
if (execution?.Status !== "SUCCEEDED" || countStep("model-1") !== 1 || countStep("model-2") !== 1 || toolSteps.length !== 1 || waits !== 1 || invocations !== 2 || counts.model_start !== 2 || !firstTextMs || firstTextMs >= Date.now() - start) {
  throw new Error(`Smoke assertions failed: ${JSON.stringify({ status: execution.Status, stepNames, waits, invocations, firstTextMs, counts })}`);
}
console.log(JSON.stringify({
  runId,
  durableExecutionArn: arn,
  status: execution.Status,
  firstTextMs,
  totalMs: Date.now() - start,
  counts,
  steps: stepNames,
  invocations,
  answer: done.result.answer,
}, null, 2));
