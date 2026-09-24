# 学び（2026-09-24）

前回: [2026-09-23-learnings.md](./2026-09-23-learnings.md)

## oh-my-pi（omp）の拡張と hook

- **プロジェクト単位の拡張は `<repo>/.omp/extensions/*.ts` に置くと自動で読み込まれます。** hook の場合は `.omp/hooks/pre|post/*.ts` です。`hooks/` の直下に置いたファイルは、エラーも出ずに無視されます。リポジトリにコミットしておけば、omp でどのモデルを使っても同じ拡張が動きます。
- **完了時の処理には `session_stop` イベントを使います。**
  - メインセッションが終わる直前に呼ばれ、サブエージェントでは呼ばれません。
  - `{ continue: true, additionalContext }` を返すと、エージェントに追加の作業を依頼できます。この継続は 8 回までです。
  - `agent_end` は通知専用なので、作業を依頼することはできません。
  - 型は `@oh-my-pi/pi-coding-agent` の `SessionStopEvent` と `SessionStopEventResult` です。インストール先の `dist/types/extensibility/shared-events.d.ts` で確認できます。
- **ループを防ぐ条件が必要です。** 「`docs/context/` 以外への新しいコミットか、未コミットの変更がある」だけを条件にすると、docs だけをコミットした後や、エージェントが「記録不要」と答えた後にも、また依頼してしまいます。対策として、最後の作業コミット、`git status`、差分をまとめたものを作業状態とし、同じ状態には 1 回しか依頼しないようにしました。
- **拡張のテストの方法:**
  - `pi.on` と `pi.exec` だけを持つ偽のオブジェクトを渡すと、判定ロジックを Bun で直接テストできます。
  - 自動で読み込まれることは、一時リポジトリで `omp -p` を実行して確認できます。
- `pi.exec(command, args, { cwd, timeout })` は `{ stdout, stderr, code, killed }` を返します。

## デプロイ

- CodeRabbit の指摘への対応（schemaVersion 3）を反映しても、既存スタックはそのまま更新できました。旧形式のレコードを読めるように作っておいたためです。スモークスクリプト 3 つで、リプレイ、承認による再開、並列の子コンテキストを確認しました。

## npm 公開とライセンスの整理

- `NPM_TOKEN` がない状態でも、リリースワークフローは GitHub Release に tarball を添付します。npm へ公開するステップは、トークンがあるときだけ実行されます。このため、トークンを後から設定しても手順は変わりません。
- MIT は、著作権表示とライセンス文を残せば、利用、改変、再配布、商用利用を認める、最も短いライセンスのひとつです。個人プロダクトであれば、組織の承認などの手続きは不要です。

## 名前の変更

- **パッケージ名は、npm に公開する前に決めておきます。** 公開した後は、名前の変更も取り消しもほぼできません。`durable` だけでは何と連携するのか分からないため、AWS のサービス名をそのまま使って `strands-lambda-durable-functions` にしました。Strands の拡張は `strands-{name}` という名前にするのが慣例なので、名前に `extension` は入れていません。拡張であることと非公式であることは、README の冒頭と description に書きました。
- **`gh repo rename` を使うと、旧 URL は GitHub が自動でリダイレクトします。** そのため、上流の Issue やコメントに書いたリンクは切れません。それでも見た目をそろえるため、自分の投稿のリンクは新しい URL に直しました。
- **直前に作って誰も使っていないリリースは、作り直せます。** `gh release delete --cleanup-tag` でリリースとタグを消し、同じタグを付け直せば、Release ワークフローがもう一度実行されます。すでに誰かが使っているバージョンのタグは、付け替えないでください。
- **旧名の import が残っていても、型チェックで検出できます。** 名前を変えたら、`npm install` の後に `npm run typecheck` を実行します。

## 軽量版の設計（Strands 非依存）

### バンドルの重さ

- **Strands 版のハンドラーが重い原因は、Strands 本体ではなく、Strands が持ち込む依存です。** AWS SDK を external にしても 999 KiB あり、内訳は zod 443 KiB、Strands 228 KiB、ajv 112 KiB、MCP SDK 72 KiB でした。esbuild の metafile で `bytesInOutput` をパッケージごとに集計すると分かります。
- **durable SDK は `@aws-sdk/client-lambda` に依存しています。** 同梱すると 594 KiB、external にすると 89 KiB です。
- **Bedrock のクライアントは、durable SDK と smithy を共有します。** そのため、同梱しても 70 KiB ほどしか増えません。SigV4 を自前で書いて軽くする意味はありません。
- **esbuild で ESM にまとめるときは、`createRequire` の banner が必要です。** CommonJS の依存が `require` を呼ぶため、banner がないと import の時点で失敗します。

### durable 実行とループ

- **エージェントループを自前で持つと、durable 化はずっと単純になります。**
  - ツールのオペレーションを `toolUse` の順に同期的に開くだけで、並列でも順序が決まります。SDK は、オペレーションを呼び出した時点で ID を採番します（`createStepId`）。
  - 承認待ちは、ツールの子コンテキストの中で `waitForCallback` を直接呼べば済みます。
- **Converse API の `stopReason` はスネークケースです**（`end_turn`、`tool_use`、`max_tokens` など）。メッセージのフィールド（`toolUse`、`toolResult`）はキャメルケースなので、つい揃えたくなりますが、実際の応答で確認してください。
- **ジャーナルから復元した extended thinking の署名は、そのまま Bedrock に送り返せます。** Haiku 4.5 で、サスペンドをはさんで確認しました。
- **モデルに渡すメッセージ配列はスナップショットにします。** ループが後から追記すると、リクエストを保持しているモデルやミドルウェアから、後のメッセージまで見えてしまいます。
- **会話の不変条件はループ側で守ります。** 守るのは、role が交互になること、すべての `toolUse` に `toolResult` があること、空のメッセージを作らないことの 3 つです。
  - `max_tokens` で途中で切れた `toolUse` や、最終ターンで返った `toolUse` をそのまま残すと、次の会話が壊れます。

### エラーの扱い

- **SDK 2.4.0 の回復不能エラー（非決定性の検出など）は、例外として投げられません。**
  - `terminationManager.terminate` を呼んで、解決しない Promise を返します。
  - 検出した後も、同じ呼び出しの中では後続のコードが動き続けます。テストでは、ツールが完了し、次のモデル呼び出しまで実際に行われてから実行が失敗しました。
  - 念のため、`isUnrecoverable === true` のエラーはエラー結果に変換せず、再 throw します。
- **ツールのエラーをまとめてエラー結果に変える catch は危険です。** workflow の中のバグや、サブエージェントのモデル失敗まで「成功」として確定します。子コンテキストが確定すると、再デプロイしても直りません。
  - エラー結果にするのは、ジャーナルに残る durable の失敗（`errorType` を持つもの）と、明示的に投げた `ToolError` だけにします。
- **ライブイベントの送信は best-effort にします。** 送信先の例外をステップの中で投げると、モデルのステップが失敗します。例外のメッセージがリトライ判定の正規表現（"timed out" など）に当たると、高価なモデル呼び出しまでやり直します。

### 検証の手順

- **`LocalDurableTestRunner` の `setupTestEnvironment` を同じプロセスで 2 回呼ぶと、止まることがあります。** 実機のスクリプトは、1 プロセスで 1 ケースだけ実行します。
- **omp から advisor の GPT-6-Sol にレビューしてもらえます。**
  - eval の `completion()` では、モデルを `smol`、`default`、`slow` からしか選べません。代わりに `omp -p --model openai-codex/gpt-6-sol --thinking high --no-session --no-extensions --tools read,grep,glob "<依頼>"` を実行します。
  - 1 回に 5 分ほどかかるので、bash の timeout を長くして非同期で実行します。

### 名前の空き状況（2026-09-24、npm）

- 空いている: `tsuzuki`、`tsuzuri`、`nokoribi`、`tomoshibi`、`hikitsugi`
- 使われている: `shiori`、`okibi`、`musubi`、`tsumugi`、`kasane`、`nagare`、`kiroku`、`tsunagi`、`tsugi`、`hibana`
