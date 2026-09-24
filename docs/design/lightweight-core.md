# 軽量版（Strands 非依存）durable エージェントの設計

作成日: 2026-09-24（Asia/Tokyo）
状態: 設計ドラフト。プロトタイプ（[lightweight-core-spike/](./lightweight-core-spike/)）で主要な前提を検証し、advisor（GPT-6-Sol）のレビューを反映済みです（13 章）。OSS 本体は新規リポジトリに置きます（未作成）。

## 0. 結論

- **重さの正体は Strands 本体ではなく、Strands が一緒に持ち込む依存です。** Strands 版のハンドラーを esbuild でまとめると 999 KiB（AWS SDK を external にした場合）になります。内訳は zod 443 KiB、Strands 228 KiB、ajv 112 KiB、MCP SDK 72 KiB などで、durable SDK は 88 KiB です。
- **エージェントループを自前で持つと、コアは 5.4 KiB（minify 後。gzip では 2.6 KiB）で書けます。** プロトタイプのコア、Bedrock アダプター、durable SDK をまとめたハンドラーは 96 KiB で、Strands 版の約 1/10 です。import 時間は、全部を同梱した場合で 129 ms から 68 ms になり、約 60 ms 短くなります。
- **自前ループにすると、Strands 版で一番複雑だった部分がなくなります。** なくなるのは次の 4 つです。
  - `TurnCoordinator`
  - interrupt から callback への変換
  - `appState` の追跡
  - 上流の非公開 API（`ToolExecutor`、`InterruptError`）への依存
- **方針**: ゼロ依存のコアと、サブパス export のアダプターに分けます（Hono と同じ構成）。対象は当面 Lambda durable functions だけです。メッセージ形式は Bedrock Converse のサブセットにします。
- **名前の第一候補**: `tsuzuki`（続き）。9 章。

## 1. 計測

- 再現方法: `lightweight-core-spike/` で `npm install` の後に `npm run measure`（[measure.mjs](./lightweight-core-spike/measure.mjs)）を実行します。
- 結果: [results/measure.txt](./lightweight-core-spike/results/measure.txt)
- 条件:
  - esbuild で `--bundle --minify --platform=node --format=esm` を指定しました。
  - import 時間は、Node 24 の新しいプロセスで `await import()` にかかった時間で、7 回の中央値です。コールドスタートそのものではなく、目安です。

| ハンドラー | すべて同梱 | AWS SDK を external | import（同梱） |
| --- | --- | --- | --- |
| Strands 版（`Agent`、`BedrockModel`、本ライブラリ、zod） | 1,575 KiB | 999 KiB | 129 ms |
| durable SDK だけ | 594 KiB | 89 KiB | 35 ms |
| プロトタイプ（コア、Bedrock アダプター、durable SDK。スキーマは JSON Schema を直接書く） | 665 KiB | 96 KiB | 68 ms |
| 同上。スキーマに `zod` を使う | 736 KiB | 167 KiB | 76 ms |
| プロトタイプのコア単体 | 5.4 KiB | 5.4 KiB | 1 ms |

読み取れること:

- **durable SDK は `@aws-sdk/client-lambda` に依存しています。** そのため、同梱すると 594 KiB になります。Lambda の Node.js ランタイムには AWS SDK v3 が入っているので、external にすれば 89 KiB です。
- **Bedrock のクライアントは、同梱しても 70 KiB ほどしか増えません。** `@aws-sdk/client-bedrock-runtime` は、durable SDK と smithy を共有するためです。したがって、SigV4 を自前で書いて fetch で呼ぶ意味はありません。Bedrock アダプターは AWS SDK をそのまま使います。
- **zod の大きさは、使い方によって大きく変わります。** Strands 版では zod が 443 KiB を占めますが、プロトタイプで `zod` を使っても 71 KiB しか増えません。差が出る原因は調べていません。

## 2. Hono から取り入れるもの・取り入れないもの

| Hono の特徴 | このライブラリでの扱い |
| --- | --- |
| 依存ゼロのコア、Web 標準 API だけで書く | 取り入れます。コアは実行時に何も import しません。base64 は `btoa`/`atob`、ID は `crypto.randomUUID()` を使い、`node:*` は使いません |
| 機能をサブパス export に分け、必要な分だけ読み込む（`hono/aws-lambda` など） | 取り入れます。アダプターごとに optional な peer 依存にします（6 章） |
| ミドルウェアの合成 | 取り入れます。モデルは関数で、ミドルウェアは `(next) => model` の形です |
| アプリの定義はモジュールスコープに 1 回だけ書く | 取り入れます。`agent()` は不変の定義で、実行ごとの状態は `run()` の中だけに持ちます。Strands 版にあった「呼び出しごとに Agent を作り直す」という注意が要らなくなります |
| スキーマライブラリに依存しない型推論 | 取り入れます。[Standard JSON Schema](https://standardschema.dev/json-schema) を受け取ります。zod 4.2 以降、ArkType、Valibot（アダプター経由）が実装しています |
| 複数ランタイム（Workers、Deno、Bun、Lambda） | 当面は取り入れません。理由は 11 章です |

## 3. 自前ループで消える複雑さ

| Strands 版の部品 | 軽量版 | 理由 |
| --- | --- | --- |
| `DurableToolExecutor` と `TurnCoordinator`（ツールの子コンテキストを先に開く） | ループが `toolUse` の順に、ツールごとのオペレーションを同期的に開くだけ | ツールのスケジューリングを自分で持つので、Strands の executor に割り込む必要がありません |
| interrupt から `waitForCallback` への変換（`invokeDurably`）、`InterruptError` を名前で判定 | ワークフロー型のツールが、子コンテキストの中で `waitForCallback` を直接呼ぶ | 承認待ちがツールの中で完結します。エージェントを再度 invoke する必要も、上流の export（#4541）を待つ必要もありません |
| `appState` の差分の記録とロールバック（`StateStore` のメソッドの差し替えと `AsyncLocalStorage`） | 持たない | 状態は会話（メッセージ）とステップの戻り値だけです。共有する可変状態がないので、並列ツールの書き込みも競合しません |
| モデルのストリームイベントをすべて記録し、リプレイで再生する | 組み立てた後の最終メッセージ（`message`、`stopReason`、`usage`）だけを記録する | 再生する相手のフレームワークがないので、イベント列は要りません。チェックポイントも小さくなります |
| `modelState` の記録 | 持たない | 当面はステートレスなプロバイダー（Converse）だけを対象にします |

Strands 版から引き継ぐ考え方は次のとおりです。

- **リトライはステップ単位で分類します。** モデルは一時的な障害だけ、ツールは `RetryableError` だけをリトライします。
- **ツールの失敗はモデルに返すエラー結果にします。**
- **idempotency key を渡します。**
- **バイナリは `$bytes` の codec で扱います。**
- **レコードにはスキーマのバージョンを付けます。**
- **ライブイベントは暫定のものとして送り、`attempt` を付けます。**

## 4. API 草案

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { agent, tool, RetryableError, ToolError } from "tsuzuki";
import { bedrock } from "tsuzuki/bedrock";
import * as z from "zod/mini"; // Standard JSON Schema を実装していれば何でもよい

// run 型: 1 ステップで終わるツール。中で durable オペレーションは使えない。
const lookupOrder = tool({
  name: "lookup_order",
  description: "注文 ID から金額を返します。",
  input: z.object({ orderId: z.string() }),
  run: async ({ orderId }, call) => {
    const res = await fetch(`${API}/orders/${orderId}`, { headers: { "Idempotency-Key": call.idempotencyKey } });
    if (res.status >= 500) throw new RetryableError(`order API ${res.status}`); // ステップをリトライ
    if (!res.ok) throw new Error("not found");                                   // モデルにエラー結果として返す
    return await res.json();
  },
});

// workflow 型: 自分の子コンテキストを受け取り、ステップ、待機、callback、サブエージェントを使える。
const issueRefund = tool({
  name: "issue_refund",
  description: "返金します。担当者の承認が必要です。",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  workflow: async ({ orderId, amount }, ctx, call) => {
    const raw = await ctx.waitForCallback("approval",
      callbackId => notifyApprover({ callbackId, orderId, amount }), { timeout: { minutes: 30 } });
    if (!JSON.parse(raw).approved) throw new ToolError("担当者が却下しました"); // モデルにエラー結果として返す
    return await ctx.step("refund", () => payments.refund({ orderId, amount, idempotencyKey: call.idempotencyKey }));
  },
});

// モジュールスコープに 1 回だけ定義する。
const bot = agent({
  model: bedrock({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }),
  system: "あなたはサポート担当です。",
  tools: [lookupOrder, issueRefund],
  maxTurns: 8,
});

export const handler = withDurableExecution(async (event: { conversationId: string; runId: string; text: string }, context) => {
  // 履歴はステップで記録する。承認待ちの後に再開したとき、別の実行が保存した内容を読まないようにするため。
  const history = await context.step("load-history", () => loadHistory(event.conversationId, event.runId));
  const result = await bot.run(context, { messages: history, prompt: event.text, events: publishToAppSync });
  // ステップは 1 回以上実行される。保存は runId をキーにして冪等にする。
  await context.step("save", () => saveMessages(event.runId, result.newMessages));
  return { text: result.text, stopReason: result.stopReason };
});
```

主な型（プロトタイプの `src/index.ts` と同じ）:

```ts
type Model = (request: ModelRequest, options: { onDelta: (delta: Delta) => void; attempt: number }) => Promise<ModelResponse>;
type ModelMiddleware = (next: Model) => Model;          // ステップの中で動く
type ModelRequest = { system?: string | SystemBlock[]; messages: Message[]; tools: ToolSpec[] };
type ModelResponse = { message: Message; stopReason: StopReason; usage?: Usage };
type Message = { role: "user" | "assistant"; content: ContentBlock[] }; // Bedrock Converse のサブセット
type RunResult = { messages; newMessages; stopReason: StopReason | "max_turns"; usage; text };
```

- **モデルは関数です。** ストリーミングしないプロバイダーは `onDelta` を呼ばなければよいだけです。第 2 引数はオブジェクトなので、後から `signal` などを足せます。
- **ミドルウェアはモデルのステップの中で動きます。**
  - I/O を含めてかまいません。ガードレール、ログ、キャッシュ、プロンプトの加工などに使います。
  - ステップが完了した後のリプレイでは実行されません。
  - 試行（attempt）ごとには 1 回以上実行されます。
  - durable オペレーションは使えません。
- `compose(model, ...middleware)` で合成します。
- `system` は `SystemBlock[]` も受け取るので、`cachePoint` を置いてプロンプトキャッシュを使えます。

## 5. 実行モデル

```text
run(context, input)
  ├─ step  model-1           モデル呼び出し。組み立てた後の応答だけを記録する
  ├─ step  tool-1-0          run 型のツール: 入力検証、本体、tool_end イベントを 1 ステップで行う
  ├─ child tool-1-1 ─ ...    workflow 型のツール: 子コンテキスト（中で step、wait、waitForCallback、サブエージェント）
  │                  └ notify  tool_end イベント（送信先があるときだけ）
  ├─ step  model-2
  └─ ...                     stopReason が tool_use 以外になるか、maxTurns に達したら終わる
```

### オペレーションの順序

1 ターンに複数のツールがあるときは、`Promise.all(uses.map(...))` で、`toolUse` の順にツールごとのオペレーションを開きます。

- どのツールの本体よりも先に、すべてのオペレーションを開きます。`open()` は最初の `await` より前に `context.step` または `context.runInChildContext` を呼びます。
- SDK は、オペレーションを呼び出した時点で ID を採番します（`createStepId`）。そのため、ツールの完了順が変わってもオペレーション ID は変わりません。
- テストでは、遅いツールを先に、速いツールを後に並べ、途中でサスペンドさせて確認しました。

### オペレーション数

| 対象 | オペレーション数 |
| --- | --- |
| モデル呼び出し | 1 |
| run 型のツール | 1 |
| workflow 型のツール | 子コンテキスト 1 と、中で使った数、`notify` 1 |

実際の Bedrock で 3 ターン、ツール 3 回の会話は 6 オペレーションでした。上限は 1 実行あたり 3,000 です。

### 決定性の約束

- `run()` の外側のコードとループは、決定的でなければなりません。
- 履歴（`input.messages`）は、呼び出しごとに同じ内容を渡す必要があります。ステップで記録するか、ペイロードで渡してください（4 章の例）。
- workflow 型のツールでは、入力検証がステップの外で動きます。このため、検証は純粋でなければなりません（非同期の refine で I/O をしない）。run 型のツールでは、検証もステップの中で動きます。

### 会話の不変条件

`newMessages` をそのまま履歴に追記できるように、コアは次の 3 つを守ります。

- role が交互になる
- すべての `toolUse` に `toolResult` がある
- 空のメッセージを作らない

| 状況 | 扱い |
| --- | --- |
| `stopReason` が `tool_use` 以外なのに `toolUse` がある（`max_tokens` で途中で切れたなど） | `toolUse` を取り除く |
| 取り除いた結果、content が空になる（ガードレールなど） | メッセージを追加しない |
| 最終ターンで `tool_use` が返った | ツールを実行せず、「ターンの上限に達した」というエラー結果を合成し、`stopReason: "max_turns"` で終える |
| 履歴が user のメッセージで終わっている（上の場合の次の run） | `prompt` をそのメッセージに結合する。この場合は、`newMessages` の先頭が履歴の最後のメッセージを置き換える |

### エラーの扱い

| 事象 | 扱い |
| --- | --- |
| モデルのスロットリング、5xx、ストリームの途中切断 | モデルのステップをリトライする。最大 4 回試行（リトライは 3 回）、full jitter の指数バックオフ（上限 30 秒） |
| モデルのその他のエラー、リトライの使い切り | `ModelError` で実行を失敗させる。サブエージェントの中で起きた場合も同じ |
| run 型のツールが `RetryableError` を投げた | ステップをリトライする（最大 3 回試行）。使い切ったらエラー結果にする |
| run 型のツールの通常の例外 | エラー結果にする。失敗したステップはジャーナルに残るので、リプレイでも同じ結果になる |
| workflow 型のツールで、ジャーナルに残る durable の失敗（ステップの失敗、callback のタイムアウトなど）または `ToolError` | エラー結果にする |
| workflow 型のツールで、その他の例外（`TypeError` などのバグ） | 実行を失敗させる。バグがエラー結果として確定し、再デプロイしても直らなくなるのを防ぐため |
| 入力がスキーマに合わない、未知のツール | エラー結果にする。ツール本体は呼ばない |
| SDK の回復不能エラー（非決定性の検出など） | 変換せずにそのまま伝播させる |

- モデルに見せるエラー文は、`formatToolError` で差し替えられます。内部の URL や秘密情報を出さないようにするためです。

### ライブイベント

- 種類は `model_start`（`attempt` 付き）、`text`（100 ms ごとにまとめる）、`tool_end` の 3 つです。
- ステップの中からだけ送るので、リプレイでは送られません。
- 送信は best-effort です。送信先のエラーはログに出して捨て、ステップを失敗させたりリトライさせたりはしません。

### レコード形式

- モデルのステップは `{ v: 1, response }` の形で記録します。
- ツールの結果は、run 型・workflow 型のどちらも `{ status, content }` を codec に通して記録します。
- バイナリは `{ "$bytes": base64 }` として記録します。
- 形式を変えるときは `v` を上げ、旧形式も読み続けます。

## 6. パッケージ構成

単一パッケージにし、サブパス export で分けます（Hono と同じ）。アダプターの依存は optional な peer にします。

| import パス | 中身 | peer 依存 |
| --- | --- | --- |
| `tsuzuki` | `agent`、`tool`、`compose`、`ToolError`、`RetryableError`、`ModelError`、リトライ戦略、codec、型 | `@aws/durable-execution-sdk-js@^2.4`（必須） |
| `tsuzuki/bedrock` | Converse / ConverseStream のアダプター | `@aws-sdk/client-bedrock-runtime`（optional） |
| `tsuzuki/testing` | 台本どおりに応答するモデル（`LocalDurableTestRunner` 用） | `@aws/durable-execution-sdk-js-testing`（optional） |
| `tsuzuki/offload` | 大きなチェックポイントを外部に逃がす serdes。Web Crypto で書き直す | なし |
| `tsuzuki/s3` | S3 の `OffloadStore` | `@aws-sdk/client-s3`（optional） |
| `tsuzuki/mcp` | MCP のツール一覧をステップで記録し、ツールに変換する | `@modelcontextprotocol/sdk`（optional） |
| `tsuzuki/openai` | OpenAI 互換の Chat Completions を fetch で呼ぶアダプター | なし |

- **コアは SDK を実行時に import しませんが、SDK の挙動には依存しています。** 依存しているのは次の 2 点です。
  - オペレーションを呼び出した時点で ID を採番すること
  - 回復不能エラーは例外にせず、呼び出しを止めること
- このため、peer 依存の範囲は狭くし、CI では対応する最小版と最新版の両方でテストします。
- Strands 版（`strands-lambda-durable-functions`）は、別パッケージのまま残します。
  - 共有できるのは codec、リトライ、offload の 100 行ほどです。依存関係を作るほどの価値はありません。
  - Strands 版をコアの上に作り直すかどうかは、コアが安定してから改めて判断します。

## 7. メッセージ形式: Bedrock Converse のサブセット

- 独自の形式は発明せず、Converse の `Message` をそのまま使います。使うブロックは `text`、`image`、`reasoningContent`、`toolUse`、`toolResult`、`cachePoint` です。型は自前で構造的に定義し、AWS SDK は import しません。
- 利点は次の 3 つです。
  - Bedrock アダプターは、ほぼ素通しで済みます。
  - Strands のメッセージも Converse に近いので、Strands 版から移行しやすくなります。
  - AWS の利用者は、AWS のドキュメントをそのまま参照できます。
- `stopReason` は Converse の値を使います。値はスネークケース（`end_turn`、`tool_use`、`max_tokens` など）です。プロトタイプでは最初にキャメルケースで書いてしまい、実際の Bedrock の応答を見て誤りに気づきました。
- 欠点: OpenAI 形式のアダプターでは変換が必要です。変換はアダプターが受け持ちます。

## 8. プロトタイプでの検証

コードは [lightweight-core-spike/](./lightweight-core-spike/) にあります（コア 360 行、Bedrock アダプター 92 行、どちらもコメント込み）。CI の対象外です。

### ローカルでのテスト

`LocalDurableTestRunner` で `npm test` を実行し、11 件すべて成功しました。

| テスト | 確認したこと |
| --- | --- |
| 並列ツールとサスペンド | 遅いツールと速いツールを並列に動かし、3 つ目のツールの `wait` で呼び出しを終わらせました。<ul><li>2 回目の呼び出しで、モデルは再実行されず（呼び出しは 2 回だけ）、完了済みのツールも再実行されない</li><li>結果が `toolUseId` に正しく対応する</li><li>モデルの出力とワークフローの結果に含まれる `Uint8Array` が、チェックポイントを越えても `Uint8Array` のまま戻る</li><li>オペレーションは `tool-1-0`、`tool-1-1`、`tool-1-2` の順に、ツールの本体より先に開かれる</li><li>`notify` はワークフロー型のツールの分だけ</li></ul> |
| 承認待ち | ワークフロー型のツールが `waitForCallback` で待ち、呼び出しが終わります。callback の後の呼び出しで、待機より前のステップは再実行されません |
| callback のタイムアウト | エラー結果になり、実行は成功します |
| run 型のツールのエラー | <ul><li>`RetryableError` は同じ idempotency key でリトライされる</li><li>通常の例外はリトライされず、エラー結果になる</li><li>スキーマ違反と未知のツールは、本体を呼ばずにエラー結果になる</li></ul> |
| workflow 型のツールのエラー | `ToolError` はエラー結果になります。`TypeError` は実行を失敗させ、モデルには渡りません |
| サブエージェント | ワークフロー型のツールの中で `name: "sub"` を付けて別の `agent` を動かすと、そのオペレーションが `tool-1-0` の下に入ります。サブエージェントのモデルが失敗すると、実行が失敗します |
| `max_turns` | 保留中のツールは実行されず、エラー結果になります。次の run の `prompt` はそのメッセージに結合され、role は交互のままです |
| `max_tokens`、ガードレール | 途中で切れた `toolUse` は取り除かれ、空のメッセージは追加されません |
| イベント送信先の障害 | 実行は失敗せず、モデルもリトライされません |
| 履歴 | 渡した履歴がそのままモデルに渡ります。リクエストはスナップショットなので、後から追記されたメッセージが混ざりません（テストで見つけた不具合を修正しました） |
| 非決定性 | ツールの中でステップ名が呼び出しごとに変わると、`NonDeterministicExecutionError` で実行が失敗し、エラー結果には変換されません |

### 実際の Bedrock での確認

`npm run live` を us-east-1 の `us.anthropic.claude-haiku-4-5-20251001-v1:0` で実行しました。出力は `results/live-*.json` にあります。

- 2 件の注文を並列に調べ、`add_numbers` で合計する 3 ターンの会話が成功しました。オペレーションは 6 個でした。
- extended thinking（`budget_tokens: 1024`）を有効にし、ツールの中の `wait` でサスペンドさせました。2 回目の呼び出しで、ジャーナルから復元した署名付きの reasoning を含むメッセージを Bedrock に送り返し、受け付けられました。プロバイダーの呼び出しは 3 回だけでした。

### まだ確認していないこと

- 実際の Lambda へのデプロイ
- S3 オフロード
- MCP
- OpenAI 互換アダプター
- 長い会話でのオペレーション数とチェックポイントのサイズ

## 9. 名前

Hono（炎）のように、短く、日本語の響きがあり、意味が機能と結びつく名前を選びました。2026-09-24 時点で、npm では 3 つとも空いています。

| 候補 | 意味 | 評価 |
| --- | --- | --- |
| **`tsuzuki`**（続き） | 「つづく」。中断したところから再開する | 第一候補です。durable 実行の本質（サスペンドと再開）をそのまま表します。一方で、「都筑」という姓と同じ綴りなので検索で埋もれやすく、英語圏の人には `tsu` が読みにくいという難点もあります（advisor の指摘） |
| `tsuzuri`（綴り） | 書き綴る、紙を綴じる | ジャーナルに記録して束ねる、という意味になります。`tsuzuki` と紛らわしいので外します |
| `nokoribi`（残り火） | 消えずに残り、また燃え上がる火 | Hono（炎）との縁があり、サスペンド中は計算を持たずに待つ様子にも合います。長いので外します |

決めたら、次の 3 つを同時に確保します。

- npm のパッケージ名
- npm の `@tsuzuki` スコープ
- GitHub の組織名

AWS の商標（Lambda など）はパッケージ名に入れず、description と README で「for AWS Lambda durable functions」と説明します。

## 10. 未決事項と推奨（利用者の判断が必要）

| # | 論点 | 推奨 |
| --- | --- | --- |
| 1 | 名前 | `tsuzuki` |
| 2 | ループの制御 | コアに入れるのは `maxTurns` と、純粋な関数 `stopWhen({ turn, usage, messages }) => boolean` だけにします。`stopWhen` はジャーナルから戻した応答に対して評価するので、決定的です。トークン予算は `stopWhen` で書けます。コンテキストの切り詰めはミドルウェア（`tsuzuki/middleware`）で行い、コアには入れません |
| 3 | ツールの結果にバイナリ（画像など）を返す方法 | `ToolResultContent[]` を明示的に返すヘルパー（例: `content([{ image }])`）を用意します。今の自動推測（文字列 → `text`、オブジェクト → `json`）はそのまま残します |
| 4 | 大きなペイロード | SDK のチェックポイントには 1 件あたり 256 KB の上限があります。ツールの結果が大きいと、実行が失敗するおそれがあります。`maxResultBytes` で上限を超えた結果をエラー結果にするか、`/offload` を 0.1 に前倒しします |
| 5 | 並列ツールの同時実行数 | `maxConcurrency` を用意するか |

## 11. やらないこと（当面）

- **複数の durable ランタイムの抽象化はしません。** 対象として考えられるのは Cloudflare Workflows、Restate、Inngest、DBOS などです。
  - どれもステップをその場で実行するモデルなので、理屈の上では移植できます。
  - ただし、子コンテキスト、callback、オペレーションの命名の仕組みはそれぞれ違います。実装してみるまで、抽象化の形は決められません。
  - そこで、コアは Lambda の `DurableContext` の 4 つのメソッド（`step`、`runInChildContext`、`waitForCallback`、`wait`）だけに依存させ、後から差し替えられる余地だけを残します。
- **`appState` のような、共有する可変状態は持ちません。**
- **exactly-once は保証しません。** Strands 版と同じく、idempotency key で対処します。

## 12. ロードマップ案

| 版 | 内容 |
| --- | --- |
| 0.1 | <ul><li>コア、`/bedrock`、`/testing`</li><li>新規リポジトリと CI（Node 22/24、durable SDK の最小版と最新版）</li><li>リリースは Strands 版と同じ手順（tarball で配布し、npm は Trusted Publishing を用意してから公開）</li></ul> |
| 0.2 | <ul><li>`/offload`、`/s3`、`/mcp`</li><li>このリポジトリに軽量版のサンプルを追加（チャットアプリの worker を差し替えた版）し、実際の Lambda で確認</li></ul> |
| 0.3 | <ul><li>`/openai`（fetch だけで書く）</li><li>必要なら AI SDK の `LanguageModelV3` 用アダプター</li></ul> |

## 13. advisor（GPT-6-Sol）のレビューと対応

omp の `--model openai-codex/gpt-6-sol --thinking high` を読み取り専用で実行し、レビューを受けました。

| 重要度 | 指摘 | 対応 |
| --- | --- | --- |
| 高 | `max_turns`、`max_tokens`、空の応答の後に、Converse として不正な履歴が残る | 5 章の不変条件を実装し、テストを追加 |
| 高 | ツールのエラーをエラー結果に変える catch が広すぎる。バグやサブエージェントのモデル失敗まで、成功として確定する | エラー結果にするのは、ジャーナルに残る durable の失敗と `ToolError` だけに限定。回復不能エラーは再 throw し、モデルの失敗は `ModelError` にした |
| 高 | イベント送信先の障害で実行が落ち、unhandled rejection も起きうる | 送信を best-effort にし、テストを追加 |
| 高 | API 例の履歴の読み込みが、ステップの外にあって決定的でない | 4 章の例でステップに入れ、`RunInput` のコメントでも明示 |
| 中 | workflow 型のツールの結果が codec を通らない | 結果を encode/decode するようにし、テストで確認 |
| 中 | `Model` の引数に拡張の余地がない。`system` に `cachePoint` を置けない | 第 2 引数をオブジェクトにし、`SystemBlock[]` も受け取るようにした |
| 中 | スキーマを run の最中に変換している。型に input 側を使っている | 変換を `tool()` の定義時に移し、型を output 側から取るようにした |
| 中 | リトライにジッターがない。「4 回」の意味があいまい | full jitter を入れ、回数は試行回数で書いた |
| 中 | ドキュメントの主張と裏付けがずれている | 計測スクリプトと実機の出力を保存し、件数と表現を直した |
| 中 | 「SDK は型だけ」は言い過ぎ | 6 章を書き直した |
| 中 | 1 ツールあたり 3 オペレーションは多い | run 型を 1 ステップにした |
| 低 | idempotency key が、プロバイダーの toolUseId の一意性に頼っている | オペレーション名を key に含めた |
| 低 | `messageStop` が来ないまま途中で切れた応答を、正常とみなす | 例外にした（リトライの対象） |
| 低 | エラー文に秘密情報が漏れるおそれ | `formatToolError` を追加した |
| 低 | 並列ツールの同時実行数に上限がない | 10 章の未決事項に回した |

レビューの過程で分かった SDK の挙動（2.4.0）: 非決定性を検出しても、同じ呼び出しの中では後続のコードが動き続けます。テストでは、検出の後にツールが完了し、次のモデル呼び出しまで実際に行われてから、実行が失敗しました。副作用のあるコードは、ステップ名や分岐を実行ごとに変えないことが特に重要です。
