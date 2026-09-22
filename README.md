# Strands on Lambda Durable Functions (TypeScript PoC)

A Strands TypeScript agent runs inside an AWS Lambda durable function. Each model request and each tool use has its own durable step. Bedrock text deltas are sent to DynamoDB while the model step runs, and a local web viewer presents them over server-sent events (SSE).

This repository is an early integration experiment, not a production package. The two research notes in this repository explain the starting point and the streaming tradeoffs: [TypeScript agent research](durable-functions-ts-research.md) and [streaming research](durable-functions-streaming.md).

## Why this exists

The [AWS AI workflows sample](https://github.com/aws-samples/sample-ai-workflows-in-aws-lambda-durable-functions) already runs Strands in a durable function, but puts the entire agent invocation in one step. A crash during an invocation can repeat its model and tool work. Its separate TypeScript agent-loop example checkpoints model and tool calls, but does not use the Strands loop. Strands' experimental checkpoints are separate from the Lambda durable journal. This PoC joins Strands' public `Model.stream` and `Tool.stream` extension points to Lambda's step journal.

```text
Local browser → local viewer → Lambda Invoke (async, published alias)
                              → Strands Agent
                                 ├─ durable model step → Bedrock ConverseStream
                                 └─ durable tool step  → add_numbers
                              → DynamoDB live events → local viewer SSE → browser
```

The model step records the completed Strands event sequence. On replay the adapter yields that sequence to the normal Strands loop without calling Bedrock again. Each tool result is likewise serialized and restored. A fresh Agent and fresh adapters are constructed for each Lambda invocation. Live text is a provisional side channel: if an incomplete model step retries, a new `attempt` identifier replaces its previous displayed text.

## Requirements

- Node.js 22+, npm, AWS SAM CLI, AWS CLI, and AWS credentials with CloudFormation, Lambda, IAM, DynamoDB, and Bedrock access.
- A region with Lambda durable functions and access to the selected Bedrock model. The template defaults to `amazon.nova-lite-v1:0` and was tested in `us-east-1`.

## Deploy and run

```bash
npm ci
npm run typecheck
sam build --template-file template.yaml
sam deploy --template-file .aws-sam/build/template.yaml \
  --stack-name strands-lambda-durable-poc --resolve-s3 \
  --capabilities CAPABILITY_IAM --region us-east-1 \
  --no-confirm-changeset
```

Read `DurableFunctionArn` and `EventsTableName` from the stack outputs, then run:

```bash
npm run build:viewer
export DURABLE_FUNCTION_ARN='arn:aws:lambda:REGION:ACCOUNT:function:STACK-worker:live'
export EVENTS_TABLE='STACK-EventsTable-...'
npm run viewer
```

Open <http://127.0.0.1:8787>. The viewer binds only to localhost and uses your local AWS credentials. The Lambda function has no public URL. Choose the replay checkbox to make the first model call finish, wait two seconds, and resume in a new Lambda invocation. The browser should display the text as it arrives and show the `add_numbers` tool result.

To check the durable journal, use the `durableExecutionArn` returned by `POST /runs`:

```bash
aws lambda get-durable-execution --durable-execution-arn "$DURABLE_EXECUTION_ARN"
aws lambda get-durable-execution-history --durable-execution-arn "$DURABLE_EXECUTION_ARN" \
  --query 'Events[].{type:EventType,name:Name}'
```

For the replay probe, expect one `model-1` step, one `replay-after-model` wait, two `InvocationCompleted` events, then one `tool-add_numbers-*` step and one `model-2` step. This is direct evidence that the completed first model call was not billed again on resume.

Delete the stack when finished:

```bash
sam delete --stack-name strands-lambda-durable-poc --region us-east-1
```

## Current scope and next work

| Area | PoC | Required for a reusable Strands integration |
| --- | --- | --- |
| Model replay | One checkpoint per complete model stream | Versioned codec for all providers, binary blocks, stateful model state, and large histories |
| Tools | One checkpoint per tool use; sequential executor | Explicit business-error versus retryable-error policy, app state reconstruction, idempotency keys for external effects |
| Streaming | Live text in DynamoDB; local SSE viewer | Batching, durable event cursor, hosted auth, retention policy, and a push channel such as AppSync Events |
| Agent flow | Standard Strands loop, four-turn cap | MCP discovery, callbacks, subagents, parallel tools, provider-independent tests |
| Deployment | SAM stack with a published alias | CI, multi-region tests, IAM tightening, version migration and release packaging |

AWS steps record completed operations, but cannot guarantee exactly-once execution of an external side effect if the process stops after that effect and before its checkpoint. Real tools need stable idempotency keys. The sample `add_numbers` tool has no external side effect. Each text delta currently causes a DynamoDB write, which keeps the PoC simple but is not suitable for high-volume production traffic. DynamoDB TTL removes events after roughly one day; TTL deletion is asynchronous.

The viewer is meant for one short session. Its SSE connection lasts up to two minutes. It is not a long-running browser session or callback transport. Store durable conversation state separately and use an authenticated push channel for long waits or multiple viewers. The PoC's model event codec uses JSON and is limited to stateless, text/tool-use model events. Model or tool callbacks that change Strands state outside their returned values need additional replay handling.

## Verified deployment

On 2026-09-22, the stack `strands-lambda-durable-poc` was deployed in `us-east-1`. A replay-probe run completed with `SUCCEEDED`, two Lambda invocations, one model step before the wait, one tool step, and a second model step after the wait. A live SSE run delivered its first text about 0.9 seconds after start and completed about 5 seconds after start; `add_numbers` returned `15` for `7 + 8`.

## License

MIT. See [LICENSE](LICENSE).
