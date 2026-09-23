# 現状報告と引き継ぎ事項

最終更新: 2026-09-23

## 1. 全体像

| リポジトリ | 役割 | 状態 |
| --- | --- | --- |
| [har1101/strands-lambda-durable](https://github.com/har1101/strands-lambda-durable) | ライブラリ本体（OSS）。npm 名は `strands-lambda-durable` | 公開済み。`v0.1.0` と `v0.1.1` の GitHub Release に tarball を添付済み。npm には未公開 |
| [har1101/strands-lambda-durable-ts](https://github.com/har1101/strands-lambda-durable-ts)（このリポジトリ） | デプロイできるチャットアプリのサンプルと、調査メモ | `main` にマージ済み（PR #1、PR #2） |

ライブラリは、このリポジトリの `packages/strands-lambda-durable` から `git filter-branch --subdirectory-filter` で切り出しました。コミット履歴も引き継いでいます。このリポジトリのバックエンドは、ライブラリを v0.1.1 の release tarball から読み込みます（`examples/chat/backend/package.json`）。

## 2. ライブラリ（har1101/strands-lambda-durable）

- 構成: `src/`（`codec`、`retry`、`events`、`scope`、`model`、`tool`、`executor`、`workflow-tool`、`interrupts`、`mcp`、`offload`、`s3`、`index`）、`test/`（19 件。すべて `LocalDurableTestRunner` で実行し、AWS は不要）。
- README は英語（`README.md`）と日本語（`README.ja.md`）の 2 つで、相互にリンクしています。ほかに `CHANGELOG.md`、`CONTRIBUTING.md`、`LICENSE`（MIT）があります。
- CI: `.github/workflows/ci.yml`。Node 22/24 で typecheck、test、build、`npm pack --dry-run` を実行します。
- リリース: `.github/workflows/release.yml`。`v*` タグを push すると、テストの後に `npm pack` を実行し、GitHub Release を作って tarball を添付します。**`NPM_TOKEN` シークレットがある場合だけ** `npm publish --provenance` も実行します。
- チェックポイント形式は `schemaVersion` 3 です。v3 では、ツール実行ごとの `appStateDelta` を記録します。v1/v2 のレコード（`appState` の全体スナップショット）も読めます。

### npm に公開する手順（未実施）

1. npm で `strands-lambda-durable` を公開できるアカウントの Automation Token を作ります（名前が空いていることは確認済み）。
2. `gh secret set NPM_TOKEN -R har1101/strands-lambda-durable` を実行します。
3. `package.json` の version と `CHANGELOG.md` を更新し、`v0.1.2` などのタグを push します。v0.1.1 をそのまま npm に出したい場合は、Actions の Release ワークフローを v0.1.1 タグで再実行します。ただし `gh release create` が既存のリリースで失敗するため、そのステップを通す修正が必要です。
4. 公開後、このリポジトリの backend の依存を `"strands-lambda-durable": "^0.1.x"` に変更し、`npm install` を実行します。README 2 つの tarball URL の注記も削除します。

## 3. サンプルアプリ（このリポジトリ）

- デプロイ済みのスタック: `strands-durable-chat`（us-east-1、アカウント 064212132988）

| 項目 | 値 |
| --- | --- |
| SiteUrl | https://dfpxqdkbp5wdf.cloudfront.net/ |
| UserPoolId / Client | `us-east-1_myAQ2SBlX` / `3b3stv2kvbah4iq8lvda3prl8l` |
| Worker エイリアス | `arn:aws:lambda:us-east-1:064212132988:function:strands-durable-chat-worker:live` |
| テーブル | `strands-durable-chat-ConversationsTable-1857P6ZITJL38`、`strands-durable-chat-MessagesTable-GBLP7OQ7NVT8` |
| CloudFront / サイト用バケット | `E1NMB9CN2Q3TJ8` / `strands-durable-chat-sitebucket-3yd1ov57jctw` |
| Cognito ユーザー | haruki-fukuchi@nec.com（一時パスワードをメールで送付済み） |

- **デプロイされているのは、CodeRabbit の指摘を反映する前のコードです。** 反映後のコードは次の 4 点が変わっていますが、まだ再デプロイしていません。
  - `appState` の差分記録と、失敗・割り込み時のロールバック
  - 確定済みメッセージだけを返す API
  - 承認待ちのポーリングのバックオフ
  - ライブラリを tarball から読み込む構成

  v3 のコードは v2 のレコードを読めるので、実行中の処理があってもそのまま再デプロイできます。
- 再デプロイ手順:
  1. `aws login --remote --profile fukuchi --region us-east-1` で認証します。セッションは約 15 分で切れます。認可コードの入力が必要です。
  2. `AWS_PROFILE=fukuchi-proc AWS_REGION=us-east-1 examples/chat/scripts/deploy.sh` を実行します。`fukuchi-proc` は `credential_process` 経由のプロファイルで、SAM から使えます。シェルの既定値は `AWS_REGION=ap-northeast-1` なので、必ず us-east-1 を明示してください。
  3. `npm run smoke -w @strands-lambda-durable/example-chat-backend` を実行します。`smoke:approval` と `smoke:parallel` も実行してください。
- 削除: サイト用とオフロード用のバケットを空にしてから、`sam delete --stack-name strands-durable-chat` を実行します。

## 4. PR とレビュー

- PR #1（ライブラリとサンプル）: CodeRabbit の指摘 7 件（初回 6 件、再レビュー 1 件）にすべて対応しました。スレッドは CodeRabbit 側で解決済みです。CI（Node 22/24 とサンプル）はすべて green で、merge commit でマージしました。
- PR #2（スタンドアロンライブラリへの切り替えと、この 2 つのドキュメント）: 依頼どおり CodeRabbit を通さずにマージしました。切り替えは、ローカルで `npm run typecheck` と `npm run build`、依存の重複排除（`npm ls`）を確認しています。

## 5. Strands 本体へのコントリビューション

| 対象 | 状態 | 次の作業 |
| --- | --- | --- |
| `InterruptError` の export | Issue [#4540](https://github.com/strands-agents/harness-sdk/issues/4540) と PR [#4541](https://github.com/strands-agents/harness-sdk/pull/4541) を作成済み。ラベル（enhancement、typescript、area-hil、area-devx）は自動で付与されました | メンテナーによる workflow の承認とレビュー待ちです。指摘があればフォーク `har1101/harness-sdk` のブランチ `feat/ts-export-interrupt-error` で対応します |
| `ToolExecutor` 基底クラスの公開 | [#762 にコメント](https://github.com/strands-agents/harness-sdk/issues/762#issuecomment-5797836885)して、方向性の合意を求めています。実装はブランチ `har1101:feat/ts-public-tool-executor`（commit `6a32117`）に push 済みです | CONTRIBUTING の「significant work はメンテナーの確認を待つ」に従い、**PR は未作成**です。合意が得られたら PR を作成します。本文の要点は下の付録にあります。`api/needs-review` ラベルは外部コントリビューターでは付けられないため、PR 本文でメンテナーに付与を依頼します |

`ToolExecutor` ブランチの確認済み事項:

- husky の pre-commit（build、coverage 付き test 4763 件、lint、format）が通っています。
- `npm run type-check` が通っています。
- docs のスニペットは `site/test-snippets` の typecheck を通ります。`pino` のエラーは既存のもので、この変更とは無関係です。
- 公開 API だけを使うスクリプトで、独自スケジューラーの動作を確認しました。割り込み後に再開しても、完了済みのツールは再実行されません。

作業用の clone は `/tmp/strands-contrib` にありますが、コンテナを再作成すると消えます。フォークから clone し直してください。

## 6. 未決事項

- **ライセンス**: 現在は MIT です。Strands 本体は Apache-2.0 と MIT です。社内の OSS 公開手続き（所属組織の承認や CLA）が必要かどうかを確認してください。
- **npm 公開**: `NPM_TOKEN` を設定するかどうか（2 章）。
- **再デプロイ**: CodeRabbit の対応を反映したコードをデプロイし、スモークテストを実行するかどうか（3 章）。
- **Strands の community catalog と、AWS Durable Execution の integrations ページへの掲載申請**: npm 公開後に行うのが自然です。

## 7. 既知の制約

- 並列ツールが同じ `appState` のキーに書き込んだ場合、最終的な値は完了順に依存します（README に記載済み）。
- `InterruptError` は現在、`error.name === "InterruptError"` で判定しています。上流で export されたら `instanceof` に切り替えます（`src/tool.ts` の `isInterruptError`）。
- `DurableToolExecutor` は `ConcurrentToolExecutor` を継承しており、型は `Parameters<ConcurrentToolExecutor["execute"]>` で取り出しています。上流で `ToolExecutor` が公開されたら、公開型に切り替えます。
- ライブの `appState` を追跡するため、エージェントごとの `StateStore` インスタンスの `set`、`delete`、`clear` を差し替えています。Strands が StateStore の実装を変えた場合は、`test/replay.test.ts` と `test/features.test.ts` の appState 系テストで検出できます。

## 付録: ToolExecutor PR 本文の要点

- タイトル: `feat(tools): make the TypeScript ToolExecutor base public`
- 公開するもの: `ToolExecutor`（値）、`ToolExecutorOptions`、`ToolExecutionInput`（型）。
- 型の拡張: `AgentConfig.toolExecutor` と `Agent.toolExecutor` の型を `ToolExecutor | ToolExecutorStrategy` に広げます。
- 名前の変更: protected の `_storePendingToolExecution` を `storePendingToolExecution` に変えます。`strands-ts/AGENTS.md` では、`_` 接頭辞は private にだけ使う規約だからです。
- `ToolExecutorOptions` のうちエージェントだけが設定するフィールド（バックグラウンドタスクと interrupt の差し替え）は、`@internal` とし、1 行の説明を付けます。
- `execute()` の契約:
  - ツール実行ごとに結果を 1 つ push します。
  - 再開時は `completedToolResults` を再利用します。
  - `cancelSignal` を尊重します。
  - `InterruptError` のときは `storePendingToolExecution()` を呼んでから再 throw します。
- レビュアーに判断を求める点:
  - `middlewareRegistry`、`tracer`、`meter` の型が export されていない。
  - 名前の変更。
  - `executeBackground()` は internal のまま残す。
- テスト:
  - `src/tools/executors/__tests__/executor.test.ts`: 逆順に実行するスケジューラー。
  - `src/__tests__/index.test.ts`: `ToolExecutor` が export され、組み込みの 2 つのエグゼキューターの基底クラスであること。
- ドキュメント: `site/.../tools/executors.mdx` に TypeScript のカスタムエグゼキューターの節を追加します（`TimedToolExecutor` の例）。
