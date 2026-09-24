# 学び（2026-09-25）

前回: [2026-09-24-learnings.md](./2026-09-24-learnings.md)

## 上流（strands-agents/harness-sdk）のレビュー傾向

PR [#4541](https://github.com/strands-agents/harness-sdk/pull/4541)（`InterruptError` の export）に対するメンテナー @liramon2 の指摘から分かったことです。

- **TSDoc は、同じファイルのほかのコメントと同じ粒度にそろえます。** 「誰が throw するか」「catch したら再 throw すること」まで書いた 5 行の説明は、詳しすぎるとして元の 2 行に戻すよう求められました。使い方の説明は docs（`site/`）のスニペットと PR 本文に書きます。
- **export を追加するだけの PR のテストは、`src/__tests__/index.test.ts` の既存テストに `toBeDefined()` を 1 行足せば十分です。** エージェントを実際に動かして `instanceof` と `stopReason` を確かめるテストは「over-engineered」と言われました。未作成の `ToolExecutor` の PR でも、`index.test.ts` のテストは同じ粒度にするのが無難です（付録で予定している「基底クラスであること」の確認は、`executor.test.ts` 側に寄せる）。

## gh と git

- この環境の gh は `har1101` で認証済みです（scopes: `repo`、`workflow` など）。`gh auth setup-git` を実行すると、HTTPS の push でも gh の認証が使われます。
- この環境では git の `user.name` と `user.email` がグローバルに設定されていないため、新しい clone ではコミットが失敗します。リポジトリローカルに `har1101` / `174846912+har1101@users.noreply.github.com`（これまでのコミットと同じ noreply アドレス）を設定します。
- レビューのスレッドへの返信は `gh api -X POST repos/<owner>/<repo>/pulls/<PR>/comments/<comment_id>/replies -f body=...` で送れます。`comment_id` は `pr://` や `gh api .../pulls/<PR>/comments` で分かる `discussion_r<ID>` の数字です。

## Lambda durable execution SDK（2.4.0）と minamo の Issue #1〜#5 の修正

- **serdes の `serialize` で throw すると、step の失敗ではなく実行の強制終了になります。** `safeSerialize` が `SERDES_FAILED` で terminate し、ハンドラーから `SerdesFailedError`（unrecoverable）が投げられます。step のエラーとして記録させたい検査（サイズの上限など）は、step の関数の中で行います。minamo の `lambda-df` は、step の中で `stringify` してから、素通しの serdes で保存しています。
- **retryStrategy には、step の関数が投げた Error がそのまま渡ります**（`dist/index.mjs` の 2140 行付近）。独自のエラークラスを `instanceof` で判定して、リトライから外せます。
- **`LocalDurableTestRunner` は STEP の記録の 256 KB 上限を検査しません。** 上限のテストは、アダプター側の検査で行う必要があります。
- **`setupTestEnvironment({ skipTime: true })` にすると、リトライの待ち時間がなくなります。** SDK の既定のリトライ（6 回）に戻ってしまう退行を、テストで試行回数として素早く検出できます。
- **リトライの待ち時間が `NaN` だと、ローカルランナーは `RangeError: Invalid time value` で落ちます。** 実行結果は `getHistoryEvents()` の `StepFailedDetails.RetryDetails.NextAttemptDelaySeconds` で確認できます。既定の jitter は FULL なので、値は毎回変わります。

## npm の Trusted Publishing（minamo `0.1.0-alpha.1`）

- **OIDC による新バージョンの公開は、トークンなしで成功しました。** `release.yml` の `npm publish` が provenance に署名し、sigstore の透明性ログにも記録されました。
- **公開した直後は、registry にまだ現れません。** ログに「Your package is being processed and may take a few minutes」と出ます。`@minamojs/minamo` は約 2 分、`@minamojs/lambda-df` は約 4 分後に `dist-tags` に反映されました。反映後も、手元の npm キャッシュのせいで `ETARGET` になることがあり、`npm install --prefer-online` で解消しました。

## チャット例の minamo 0.1.0-alpha.1 への切り替え

- **ツールのライブイベントと承認 ID には `ctx.call.id` をそのまま使えます。** 従来の `idempotencyKey` の末尾を `#` で区切る方法は、呼び出し ID 自体に `#` が含まれると欠けます。実際の `shopTools` をローカルでバンドルして両経路を動かし、`#` を含む ID が進捗・結果イベントと承認イベントで保持されることを確認しました。返金の冪等性キーは従来どおり `ctx.idempotencyKey` を使います。
