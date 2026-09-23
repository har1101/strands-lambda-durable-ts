# Lambda Durable Functions と AppSync Events の検討メモ

作成日: 2026-09-22

このメモは、今回のハンズオンで確認したDurable Functionsの動作、`context.step()`とリプレイの関係、Function URLとAppSync Eventsの使い分け、および次のサンプル実装の調査結果をまとめたものです。

- 対象サンプル: [sample-multi-agent-orchestration-chat-on-agentcore](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore)
- このメモのコードパスは、2026-09-22に`main`のcommit [`1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8`](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/tree/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8)を調査したものです。サンプルの実装は変更される可能性があります。

## 先に結論

今回の用途では、次の役割分担が理解しやすいです。

```text
Function URL / API Gateway
        |
        | 受付・dispatcher Lambda
        | Durable FunctionをInvocationType=Eventで開始
        v
Lambda Durable Function
        |
        | context.step()、context.wait()、context.wait_for_callback()
        | 各ステップの意味のある状態をDynamoDBへ保存
        v
DynamoDB
        |
        | DynamoDB Streams
        v
通知用Lambda
        |
        | AppSync EventsへHTTP publish
        v
AppSync Events
        |
        | WebSocket subscribe
        v
ブラウザ
```

Durable Functionの開始要求を受け付ける入口と、長時間動く処理の進捗を通知する経路は分けるのが自然です。Function URLは処理開始や短時間のレスポンスに向いています。AppSync Eventsは、処理が一度中断・再開されても、別タブや別端末にも進捗を届ける経路に向いています。

ただしこのサンプルでは、AppSync EventsがDynamoDBの変更を直接監視しているわけではありません。DynamoDBへの書き込みをDynamoDB Streamsでイベント化し、LambdaがそのイベントをAppSync Eventsへ転送します。DynamoDBは現在状態や履歴の保存先、AppSync Eventsはリアルタイム通知の経路です。AppSync Eventsにはイベントハンドラーやデータソース連携もあるため、別構成ではAppSync側で処理する設計もできます。[AppSync Eventsのイベントハンドラーとデータソース](https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-concepts.html)

## 1. ハンズオンで起きていたこと

### `sam deploy` の `No changes to deploy`

次の出力は、関数が環境に存在しないという意味ではありません。

```text
Error: No changes to deploy. Stack assessment-order-fulfillment is up to date
```

SAMが生成したテンプレートとアーティファクトの内容が、デプロイ済みのCloudFormationスタックと同じだったという意味です。今回のように関数自体は存在していて、Lambdaコンソールの表示が更新されていないケースもあります。関数があるのに古い動作に見える場合は、コンソールの更新、対象リージョン、対象バージョンまたはエイリアス、CloudWatch Logsを確認します。

### UUIDを`context.step()`の外で生成してはいけない理由

最初のAssessmentでは、`payment_id`を次のように生成するとリプレイ時に値が変わることを確認します。

```python
payment_id = f"PAY-{uuid.uuid4().hex[:8]}"
```

`uuid.uuid4()`は呼び出すたびに別の値を返します。Durable Functionは、待機や障害から再開すると、Pythonプロセスのメモリをそのまま再開するのではなく、ハンドラーを再実行して、完了済みのdurable operationの結果をチェックポイントから再現します。そのため、`context.step()`の外にあるランダム値、現在時刻、外部API呼び出しなどは再実行時に別の結果になり得ます。

修正後はUUIDの生成自体をstepに含めます。

```python
def generate_payment_id(_):
    return f"PAY-{uuid.uuid4().hex[:8]}"

payment_id = context.step(generate_payment_id, name="generate-payment-id")
```

このとき初回実行ではstep関数が実行され、その戻り値がDurable Executionの履歴に保存されます。リプレイ時には同じstepがもう一度UUIDを生成するのではなく、保存済みの戻り値が`payment_id`へ返されます。AWSのドキュメントでも、完了済みcheckpointは再実行せず、保存済みの結果を使って続行すると説明されています。[Lambda Durable Functionsの基本概念](https://docs.aws.amazon.com/lambda/latest/dg/durable-basic-concepts.html)

## 2. Assessment 1の実行順序とIDの引き継ぎ

現在の`assessment_debug_replay.py`は、おおむね次の順序です。

```text
1. eventからorder_idを読む
2. context.step("generate-payment-id")でpayment_idを生成
3. context.step("step-one")でpayment_idを含む結果を作る
4. context.wait("force-replay")で5秒待つ
5. context.step("step-two")でpayment_idが一致することを確認
6. 完了結果を返す
```

初回の呼び出しでは、1から3まで進み、`context.wait()`で実行が一時停止します。wait中はLambdaの計算を保持し続けるのではなく、指定時間の後にDurable Functionを再開できる状態になります。再開時にはハンドラーが先頭から評価されますが、完了済みの`generate-payment-id`と`step-one`の結果は履歴から再現されます。

```text
初回呼び出し
  ├─ order_id = eventのorder_id
  ├─ generate-payment-idを実行 → payment_idをcheckpoint
  ├─ step-oneを実行 → 結果をcheckpoint
  └─ force-replayで一時停止

再開時のリプレイ
  ├─ order_id = 同じ入力eventから取得
  ├─ generate-payment-idは再実行せず、保存済みpayment_idを返す
  ├─ step-oneも再実行せず、保存済みstep_one_resultを返す
  ├─ waitの後から処理を続ける
  └─ step-twoで同じpayment_idであることを確認
```

この例で引き継がれている値は、Python変数のメモリではありません。

| 値 | 由来 | 再開時の扱い |
|---|---|---|
| `order_id` | 開始時の入力イベント | 同じ実行入力から再取得 |
| `payment_id` | `generate-payment-id` stepの戻り値 | checkpoint済みの値を再利用 |
| `step_one_result` | `step-one` stepの戻り値 | checkpoint済みの値を再利用 |
| Durable Execution ID | Lambdaが実行開始時に割り当てる識別子 | 実行全体を識別する外部ID |

`context.step()`の戻り値を次のstepの入力や最終結果に含めることで、step間のデータを引き継げます。外部サービスにもIDを渡したい場合は、stepの戻り値や`context.invoke()`のpayloadに明示的に入れます。

現在のAssessment 1のファイルにはAssessment 2用のcallback処理がTODOとして残っています。`notify_customer`はcallback IDを受け取る送信関数の例であり、`WaitForCallbackConfig`の設定、承認APIからのcallback完了通知、timeout時の処理を追加して初めて承認待ちのフローになります。

実行開始時に`DurableExecutionName`を指定すると、開始要求のリトライ時に同じ実行を重複作成しないためのidempotency keyとして使えます。指定しなければLambdaが実行IDを生成します。[Durable Functionsのidempotency](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)

実装では、次の識別子を混同しないようにします。

| 識別子 | 役割 |
|---|---|
| `orderId` | 業務上の注文ID。ユーザーや画面が追跡するID |
| `DurableExecutionName` | 実行開始の冪等性キー。注文IDをそのまま使うか、`order-{orderId}`のように構成する |
| `DurableExecutionArn` | Lambdaが実行開始時に返すDurable ExecutionのARN。実行を一意に追跡するID |
| `eventId` | AppSync通知を重複排除するためのID。例えば`DurableExecutionArn + sequence` |

Lambda Invoke APIのレスポンスには、Durable Functionを呼び出した場合の`X-Amz-Durable-Execution-Arn`が含まれます。非同期開始APIはこのARNを受け取り、`orderId`や`DurableExecutionName`とDynamoDBへ保存しておくと、画面・ログ・通知を同じ実行へ結び付けられます。[Lambda Invoke APIのレスポンス](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html)

### `context.step()`が保証する範囲

`context.step()`は、stepの戻り値をcheckpointしてリプレイ時に再利用する仕組みです。通常のPythonコード全体を自動的に一回だけ実行する仕組みではありません。

外部APIへの副作用をstep内で行っても、外部処理の成功直後からcheckpoint保存までの間に障害が起きると、stepが再試行される可能性があります。決済、在庫引当、注文作成などは、`execution_id`や業務上の注文IDを使ったidempotency keyを外部サービス側にも渡します。

## 3. Durable Functionの同期呼び出しと非同期呼び出し

Lambda Durable Functionsは、通常のLambdaと同様に同期呼び出しと非同期呼び出しの両方に対応します。[AWSの呼び出し方法](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html)

### 同期呼び出し

`InvocationType`を指定しないLambda Invokeは、通常は`RequestResponse`です。呼び出し側は最終結果を待ちます。Durable Function内にwaitがあっても、論理的には実行全体の完了を待ちます。ただし同期呼び出しは通常のLambda呼び出しとして接続を維持するため、15分以内などの呼び出し側の制約を受けます。

短時間で完了する処理の結果をその場で返す場合は、Function URLやAPI Gatewayから同期的に呼び出せます。

### 非同期呼び出し

`InvocationType=Event`で呼び出すと、Lambdaは要求をキューに入れてすぐに戻り、Durable Functionはバックグラウンドで実行されます。長い処理、外部承認待ち、数時間後の再開などはこちらが適しています。呼び出し側は、開始時に返された`DurableExecutionArn`や、受付APIが発行した`trackingId`、`orderId`、`executionName`をDynamoDBに保存して進捗を追跡します。

Lambda Invoke APIは、同期・非同期のいずれでもDurable Functionの実行ARNをレスポンスヘッダーで返します。注文処理では、受付API側で`orderId`や`executionName`を先に決め、Invokeレスポンスの`DurableExecutionArn`とともにDynamoDBへ保存すると、画面の追跡IDとDurable Execution APIの対象を対応付けられます。[Lambda Invoke API](https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html)

同じ`DurableExecutionName`が既に存在し、payloadも同じなら既存executionの情報が返ります。payloadが異なる場合は`DurableExecutionAlreadyStartedException`になります。実行が完了していても、履歴の保持期間が終わって名前が再利用可能になる場合があるため、注文IDを永続的に一意なexecution nameとして扱えるかは保持期間と業務要件を合わせて決めます。[実行名と冪等性の条件](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)

### `context.invoke()`との違い

Durable Function内の`context.invoke()`は、外部からLambda Invoke APIを呼ぶこととは別のdurable operationです。呼び出し先のLambdaの結果を論理的に待ちますが、待機中に呼び出し元のLambda計算を消費し続けるわけではありません。呼び出し先が完了すると、結果をcheckpointして新しいLambda invocationで続きを実行します。[Durable SDKのinvoke operation](https://docs.aws.amazon.com/durable-execution/sdk-reference/operations/invoke/)

Python SDKの`context.step()`や`context.invoke()`はコード上は同期メソッドに見えますが、Durable Execution全体は複数のLambda invocationにまたがって進みます。この「コード上の同期性」と「実行基盤上の中断・再開」は分けて考えます。

## 4. Function URLとAppSync Eventsの役割

### Function URLでできること

Function URLはHTTPの入口です。次の用途に向いています。

- 注文処理の開始
- `trackingId`、`executionName`、受付結果を返す
- 15分以内に完了する処理の同期レスポンス
- 接続が維持されている間のHTTPストリーミング

ただし、Durable Functionが`wait()`や`wait_for_callback()`で中断すると、同じHTTP接続を何時間も保持して、再開後の結果をその接続へ送り続けることはできません。Lambda invocationが終わった後に、別のinvocationで同じHTTPレスポンスを再開する仕組みではないためです。

Function URL自体は、対象Lambdaに対するHTTPの同期呼び出しです。Function URLからDurable Functionを直接呼ぶと、`wait()`を含む実行全体の完了を待つ形になります。受付だけをすぐ返したい場合は、Function URLの対象を短いdispatcher Lambdaにし、そのdispatcherがDurable Functionを`InvocationType=Event`で呼び出して`202 Accepted`と追跡用IDを返す構成にします。短時間の処理なら、Function URLからDurable Functionを直接同期呼び出しして最終結果を返しても構いません。Function URLのresponse streamingを使う場合は、対応runtimeと`InvokeMode=RESPONSE_STREAM`などの対応設定が必要です。

### AppSync Eventsでできること

AppSync Eventsは、HTTPでイベントをpublishし、クライアントがWebSocketでチャンネルをsubscribeする仕組みです。[AWS AppSync Eventsの概要](https://docs.aws.amazon.com/appsync/latest/eventapi/)

次の用途に向いています。

- Durable Functionのステップ完了通知
- 長時間処理の進捗表示
- 別タブや別端末への同期
- ブラウザ再接続後に以後の通知を受ける経路
- 処理完了、失敗、承認待ちなどの状態イベント

AppSync Eventsは履歴や現在状態の正本ではありません。クライアント接続中に配送するイベントなので、画面はAppSyncの購読を確立してから現在状態を取得し、取得した`sequence`と受信イベントの`sequence`を統合する設計にします。先に状態を取得してから購読すると、その間に発生したイベントを取りこぼす可能性があります。購読後の再取得で状態が進んでいた場合は、すでに表示済みのイベントを`sequence`で重複排除します。状態にsequenceの欠落があれば、現在状態またはイベント履歴をAPIから再取得します。

### 使い分け

| 要件 | 適した経路 |
|---|---|
| 処理を開始して受付IDを返す | Function URL / API Gateway → dispatcher Lambda → 非同期Durable Function |
| 短時間の最終結果を同期で返す | Function URL / API Gateway → 同期呼び出し |
| 数分から数日後の進捗を通知する | DynamoDB Streams → AppSync Events |
| 別端末・別タブにも通知する | AppSync Events |
| 文字単位・token単位の低遅延表示 | 実行中のHTTPストリーム、または専用のイベント配信 |
| 再接続後にも完全な内容を復元する | DBまたはオブジェクトストレージに保存し、APIで取得 |

## 5. AWSサンプルのAppSync Events実装

対象サンプルは、AppSync Eventsを一つの経路だけで使っていません。セッション情報と会話メッセージで経路が違います。

### セッション情報: DynamoDB Streams経由

```text
AgentCore Runtime
        |
        | SessionsテーブルをINSERT/MODIFY/REMOVE
        v
DynamoDB Sessions
        |
        | DynamoDB Streams
        v
session-stream-handler Lambda
        |
        | SigV4署名付きHTTP POST
        v
AppSync Events /sessions/{userId}
        |
        | WebSocket
        v
Frontendのセッション一覧
```

サンプルのStream relayは、`Sessions`テーブルの変更を受け取り、`/sessions/{userId}`チャンネルへpublishします。なお、このサンプルのrelayはpublishエラーをログへ出して処理を継続する実装です。実運用で通知の再送を保証したい場合は、publish失敗時にLambdaが失敗を返してStreamのretry対象にするか、別の再送・DLQ・outbox設計を追加します。

このrelayは、DynamoDBのpartition keyである`userId`をそのままチャンネル名に使っていません。サンプルでは、AppSyncのチャンネルパスに使うCognito User Poolの`sub`を`channelUserId`としてセッションレコードへ保存し、Streamレコードから取り出して利用しています。これはDynamoDBのidentity IDに含まれる`:`がチャンネルパスで扱いにくいためです。

- [DynamoDB StreamsからAppSync Eventsへ転送する実装](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/session-stream-handler/src/index.ts)
- [Stream LambdaのCDK定義](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/cdk/lib/constructs/triggers/session-stream-handler.ts)
- [Stream relayのREADME](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/session-stream-handler/README.md)

したがって、アーキテクチャ図の「DBから画面へ配信」は、より正確には次の意味です。

```text
DynamoDBへ書き込む
  ↓
DynamoDB Streamsが変更レコードを作る
  ↓
LambdaがレコードをAppSync Eventsへ転送する
  ↓
WebSocket購読中の画面に届く
```

AppSync EventsがDynamoDBをポーリングしているわけではありません。

### 会話メッセージ: AgentCore Runtimeから直接publish

会話メッセージは別経路です。AgentCore Runtimeの`SessionPersistenceHook`が、メッセージ追加時に履歴を保存し、セッションメタデータを更新し、`MESSAGE_ADDED`をAppSync Eventsへ直接publishします。

```text
AgentCore Runtime
   ├─ 会話履歴をストレージへ保存
   ├─ セッションメタデータをDynamoDBへ保存
   └─ AppSync Events /messages/{userId}/{sessionId} へ直接publish
```

関連ファイルは次の通りです。

- [セッション永続化フック](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/agent/src/services/session/session-persistence-hook.ts)
- [AppSync Events publisher](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/agent/src/services/appsync-events-publisher.ts)
- [AppSync Events APIのCDK定義](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/cdk/lib/constructs/api/appsync-events.ts)

AppSync Events APIはCDKで構成され、`sessions`と`messages`のチャンネル名前空間を持ちます。バックエンドのpublishはIAM認証とSigV4署名を使い、フロントエンドの接続・subscribeはCognito認証を使う構成です。つまり、ブラウザにpublish権限を持たせず、バックエンドだけがイベントを書き込める形になっています。メッセージのpublisherはpublish失敗を警告ログにして呼び出し元へ再送を要求しないため、このサンプルではメッセージ通知がbest effortである点にも注意します。

### 現在のタブ: HTTPストリーミング

AgentCore Runtimeは、実行中のエージェントイベントをHTTPレスポンスへNDJSON形式で書き出します。

```text
AgentCore Runtime
   |
   | HTTP NDJSON stream
   v
現在リクエストを送ったブラウザのタブ
```

フロントエンドはHTTPストリームとAppSync Eventsの両方を受け取ります。現在のタブではHTTPストリームを高速表示に使い、AppSync Eventsは別タブ、別端末、再接続後の同期に使います。同じメッセージが両方から届く可能性があるため、フロントエンドには重複を抑える処理があります。

- [AgentCore RuntimeのHTTPストリーム](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/agent/src/handlers/stream-handler.ts)
- [メッセージイベント購読と重複制御](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/frontend/src/hooks/useMessageEventsSubscription.ts)
- [セッションイベント購読](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore/blob/1d6e204eb29ecfe96e6d28e32f21c2c2d30d85e8/packages/frontend/src/hooks/useSessionEventsSubscription.ts)

READMEにはAppSync Eventsによるリアルタイムストリーミングと表現されていますが、実装を細かく見ると、tokenやagent eventの低遅延表示はHTTPストリーム、状態同期や別クライアントへの通知はAppSync Eventsという二重構成です。

## 6. 今回のDurable Order Processingへの適用案

### 推奨構成

```text
ブラウザ
   |
   | POST /start
   v
Function URLまたはAPI Gateway
   |
   | HTTP受付
   v
受付・dispatcher Lambda
   |
   | Lambda Invoke: 非同期 + DurableExecutionName
   v
Durable Order Processor
   |
   ├─ validate-order
   ├─ process-payment
   ├─ create-order
   └─ 各ステップの状態をDynamoDBへ保存
              |
              v
       DynamoDB Streams
              |
              v
       AppSync relay Lambda
              |
              v
       AppSync Events /orders/{orderId}
              |
              v
       ブラウザの進捗表示
```

開始用LambdaまたはAPIはLambda Invoke APIでDurable Functionを非同期起動し、レスポンスから実行ARNを取得して、処理を開始したらすぐに次のような受付情報を返します。

```json
{
  "trackingId": "order-123",
  "orderId": "order-123",
  "executionName": "order-order-123",
  "durableExecutionArn": "arn:aws:lambda:...:durable-execution/order-order-123/...",
  "status": "RECEIVED"
}
```

ここで`orderId`は業務ID、`executionName`は開始時の冪等性キー、`durableExecutionArn`はLambdaが割り当てた実行の追跡IDです。フロントエンドで短いIDだけを扱いたい場合は、別名の`trackingId`を用意しても構いませんが、DynamoDBには実行ARNとの対応を保存します。

DynamoDBには、例えば次のような現在状態を保存します。

```json
{
  "orderId": "order-123",
  "executionName": "order-order-123",
  "durableExecutionArn": "arn:aws:lambda:...:durable-execution/order-order-123/...",
  "status": "PAYMENT_COMPLETED",
  "sequence": 3,
  "updatedAt": "2026-09-22T12:00:00Z"
}
```

状態遷移として通知したい値は、次のように限定します。

```text
RECEIVED
VALIDATING
ORDER_VALIDATED
PAYMENT_PROCESSING
PAYMENT_COMPLETED
ORDER_CREATED
COMPLETED
FAILED
WAITING_FOR_APPROVAL
```

クライアントは、まず`/orders/{orderId}`の購読を確立し、その後に現在状態をAPIから読みます。受け取ったイベントと現在状態を`sequence`で統合すれば、購読確立前後の状態更新を取りこぼさずに済みます。sequenceに欠落がある場合は、イベント履歴または現在状態をAPIから再取得します。

### 外部承認のcallback

時間を置くだけの`context.wait()`と、ユーザーや外部サービスからの返答を待つ`context.wait_for_callback()`は別物です。承認待ちでは、Durable Functionがcallback IDを発行し、そのIDを承認画面や承認サービスへ渡します。画面の承認APIは、そのcallback IDを使って次のどちらかを呼び出します。

```text
承認API
  └─ SendDurableExecutionCallbackSuccess(callbackId, result)
     または SendDurableExecutionCallbackFailure(callbackId, error)
        ↓
Durable backendが新しいLambda invocationを起動
        ↓
checkpointからリプレイして承認結果の後から続行
```

Pythonの`wait_for_callback()`は、submitterがcallback IDを外部へ渡し、callbackの結果を返すまで実行を中断します。callbackには必ずtimeoutを設定します。[Callback operation](https://docs.aws.amazon.com/durable-execution/sdk-reference/operations/callback/) [Callback成功API](https://docs.aws.amazon.com/lambda/latest/api/API_SendDurableExecutionCallbackSuccess.html)

### 現在状態とイベント履歴を分ける

画面に最新状態だけが必要なら、注文ごとに現在状態を持つテーブルで十分です。すべての状態遷移を後から監査・再生したい場合は、別のイベントテーブルへ追記します。

```text
OrderState table
  orderId -> 現在のstatus

OrderEvents table
  orderId + sequence -> 状態遷移の履歴
```

どちらのテーブルもDynamoDB Streamsの対象にできます。AppSync Eventsだけに履歴を任せると、接続していなかったクライアントや長時間後の画面を復元できません。

### Durable Functionから直接AppSync Eventsへpublishする案

サンプルのメッセージ経路のように、Durable Function内からAppSync Eventsへ直接publishすることもできます。この場合はAppSyncへのHTTP呼び出しを`context.step()`の中に置きます。

```text
context.step(publish_progress_event, name="publish-payment-completed")
```

ただし、AppSync publishは外部副作用なので、stepが再実行されると同じイベントが重複する可能性があります。イベントに次のようなIDを付け、フロントエンドや中継側で重複排除します。

```text
eventId = durableExecutionArn + ":" + sequence
```

Durable Functionを業務処理に集中させ、DynamoDBへの状態保存からStream relayで通知する方式の方が、状態の正本と通知の責務を分けやすくなります。

### token単位のストリーミングが必要な場合

DynamoDBへtokenごとに書き込んでDynamoDB StreamsからAppSync Eventsへ流す設計は避けます。書き込み量、コスト、順序制御、重複処理が大きくなり、Durable Executionのcheckpointとは別の問題が増えるためです。

token単位の表示が必要な場合は、次のように分けます。

- 現在のHTTPリクエスト中だけ低遅延表示する: Function URLやAPI GatewayのHTTPストリーム
- 長時間処理の進捗を表示する: AppSync Events
- 再接続後に全文を復元する: S3、DynamoDB、AgentCore Memoryなどへ保存してAPIで取得

AppSync Eventsでメッセージ断片を配信する場合は、`durableExecutionArn`、`messageId`、`sequence`、`eventId`を含めて、順序と重複をクライアントが判断できるようにします。

## 7. 実装時の注意点

### Durable Function側

- Durable Functionは公開済みversionまたはaliasを指定して呼び出す。実行中にコードが変わると、過去のcheckpointとの対応が不安定になります。
- リクエスト開始時には`DurableExecutionName`を指定し、注文IDなどをidempotency keyとして使う。
- UUID、乱数、現在時刻、外部API呼び出しなど、再実行で値が変わる処理はstep内に置く。
- DynamoDBへの状態更新も外部I/Oなので、`context.step()`または`context.invoke()`の中に置く。状態イベントの`sequence`はstepの論理順序などから決定的に作る。
- step名とstepの並びは安定させる。既存executionの途中でコードの順番やstep名を不用意に変えない。
- 決済や注文作成などは、step化だけでexactly-onceになると考えず、外部側にもidempotency keyを渡す。
- 大きなstep結果や会話履歴は、S3などに保存してstep結果には参照先だけを持たせる。
- `context.wait()`や`context.wait_for_callback()`で中断した後は、新しいLambda invocationで再開される前提で設計する。

### DynamoDB Streams relay側

- Stream Lambdaはリトライされ得るため、publishが重複しても画面が壊れないようにする。
- `eventId`や`sequence`をイベントに含め、フロントエンドで重複排除する。
- Streamの遅延や失敗を考慮し、失敗時のretry、partial batch failure、必要ならDLQを設計する。
- 状態保存と通知は最終的に整合するが、DynamoDBへの書き込みとAppSync publishが同一トランザクションになるわけではない。

### AppSync Events側

- バックエンドpublishにはIAM、ブラウザのsubscribeにはCognitoなど、用途ごとに認証を分けられる。
- チャンネル名にユーザーID、注文ID、`durableExecutionArn`などを含める。ただしチャンネル名だけでは認可にならないため、AppSync EventsのIAM policy、Cognito identity、namespaceの`onSubscribe` handlerなどで、要求者がその注文を購読できることを検証する。[AppSync Eventsの購読認可](https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespace-handlers.html)
- AppSync Eventsを現在状態の保存先として扱わない。初期表示用のAPIまたはDB読み出しを用意する。
- 再接続、同じイベントの重複、順序が遅れて届くケースをフロントエンドで扱う。

## 8. 最終的な判断

今回の注文処理では、まず次の構成から始めるのがよいです。

1. Function URLまたはAPI Gatewayで注文処理を受け付ける。
2. APIのdispatcher LambdaはDurable Functionを非同期で開始し、`trackingId`、`executionName`、`durableExecutionArn`、`orderId`を返す。
3. Durable Functionは各業務ステップの完了時にDynamoDBへ状態を保存する。
4. DynamoDB Streamsのrelay LambdaがAppSync Eventsへ通知する。
5. ブラウザはAppSync Eventsの購読を確立してから初期状態をAPIから取得し、`sequence`でイベントと統合する。
6. 短時間のtoken表示が必要な画面だけ、別途HTTPストリーミングを追加する。

この構成なら、Durable Functionsの中断・再開と、ブラウザへのリアルタイム通知を同じHTTP接続に依存させずに済みます。サンプルリポジトリの「DynamoDB StreamsからAppSync Eventsへ転送する経路」と、「実行中のHTTPストリームを別に持つ経路」を、注文処理向けに整理して利用する形です。

## 参考リンク

- [AWS Lambda Durable Functions: 基本概念](https://docs.aws.amazon.com/lambda/latest/dg/durable-basic-concepts.html)
- [AWS Lambda Durable Functions: 呼び出し方法](https://docs.aws.amazon.com/lambda/latest/dg/durable-invoking.html)
- [AWS Lambda Durable Functions: idempotency](https://docs.aws.amazon.com/lambda/latest/dg/durable-execution-idempotency.html)
- [AWS Durable Execution SDK: invoke operation](https://docs.aws.amazon.com/durable-execution/sdk-reference/operations/invoke/)
- [AWS AppSync Events](https://docs.aws.amazon.com/appsync/latest/eventapi/)
- [サンプルリポジトリ](https://github.com/aws-samples/sample-multi-agent-orchestration-chat-on-agentcore)
