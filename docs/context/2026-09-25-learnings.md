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
