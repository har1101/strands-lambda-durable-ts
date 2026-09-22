import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

export type LiveEvent = {
  runId: string;
  key: string;
  kind: "model_start" | "text" | "tool" | "done" | "failed";
  call?: number;
  attempt?: string;
  text?: string;
  tool?: string;
  status?: string;
  result?: unknown;
};

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export class EventWriter {
  private sequence = 0;
  constructor(readonly runId: string, private readonly table: string) {}

  async put(event: Omit<LiveEvent, "runId" | "key">): Promise<void> {
    const key = `${Date.now().toString().padStart(13, "0")}-${(++this.sequence).toString().padStart(8, "0")}-${randomUUID()}`;
    await client.send(new PutCommand({
      TableName: this.table,
      Item: { ...event, runId: this.runId, key, expiresAt: Math.floor(Date.now() / 1000) + 86400 },
    }));
  }
}

export async function readEvents(table: string, runId: string, after?: string): Promise<LiveEvent[]> {
  const events: LiveEvent[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await client.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: after ? "runId = :runId AND #k > :after" : "runId = :runId",
      ExpressionAttributeNames: after ? { "#k": "key" } : undefined,
      ExpressionAttributeValues: after ? { ":runId": runId, ":after": after } : { ":runId": runId },
      ExclusiveStartKey: lastKey,
      ConsistentRead: true,
    }));
    events.push(...(response.Items as LiveEvent[] | undefined ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return events;
}
