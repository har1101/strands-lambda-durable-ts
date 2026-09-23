# 実装で得た学び

Strands Agents（TypeScript）を AWS Lambda durable functions で動かすライブラリとサンプルアプリを作り、公開するまでに分かったことをまとめます。設計の背景は `docs/research/` にあります。

## 1. Lambda durable functions（`@aws/durable-execution-sdk-js`）

- **オペレーション ID は呼び出し順で決まります。** リプレイでは、同じ順序で同じ名前のオペレーションを呼ぶ必要があります。並列に動くツールが完了順にステップを開くと、実行のたびに ID がずれます。対策として、ターンの開始時にツール実行ごとの子コンテキストを `toolUse` の順に先に開き（`tools-<turn>-<index>`）、各ツールは自分の子コンテキストの中だけでステップを作るようにしました（`DurableToolExecutor`、`TurnCoordinator`）。
- **1 つのコンテキストで、順次実行のステップを並行させてはいけません。** 順序が不定になるため、`DurableTool` は同じコンテキストでステップが重なると例外にします。
- **失敗したステップは、エラーだけがジャーナルに残ります。** リプレイ時にステップ本体は再実行されず、戻り値もありません。このため、失敗時の付随データ（`appState` の差分など）は永続化できません。付随データはライブ側で元に戻し、リプレイと一致させます。割り込みでツールを中断した場合も同じです。
- **アイドル状態の呼び出しは 20 ms のクールダウン後に終了します。** `LocalDurableTestRunner` で時間をスキップすると、短い待機がクールダウンより先に終わります。その場合は呼び出しが終了せず、リプレイのテストになりません。サスペンドを前提とするテストでは、実時間のタイマー（`skipTime: false`）が必要です。
- **割り込み（human-in-the-loop）は `waitForCallback` に変換します。** Strands の interrupt を callback に対応付け、応答が JSON で返ってきたら、同じ `toolUseId` のツール実行として再開します。承認を待つ間、Lambda の呼び出しは終了するので、待ち時間の料金はかかりません。
- **リトライは durable step 側に一本化します。** Agent 側の `retryStrategy: null` にしないと、リトライが二重になります。モデルはスロットリング、5xx、タイムアウトだけを、ツールは明示的な `RetryableToolError` だけをリトライします。ツールが投げた通常の例外は業務上の結果として扱い、モデルにエラー結果として返します。
- **exactly-once ではありません。** 副作用の後、チェックポイントの前に止まると再実行されます。`<実行 ARN>#<toolUseId>` を idempotency key として外部 API に渡すのが現実的な対策です。
- **クォータ**: 1 実行あたり 3,000 オペレーション、チェックポイントは累計 100 MB までです。大きな結果は S3 に退避し（`createOffloadSerdes`）、長い会話はメッセージごとに別の実行へ分けます。
- **バージョン固定**: 実行中の処理はジャーナルと同じコードを使う必要があります。公開済みバージョンの背後にあるエイリアス（`live`）を呼び出します。
- **チェックポイントには形式のバージョンを付けます。** `schemaVersion` を付けて旧形式も読み続けます。新しいフィールドを追加するときはバージョンを上げます。そうすれば、古いリーダーが新しいレコードを黙って誤読せず、エラーで止まります。

## 2. Strands Agents（TypeScript SDK）

- **拡張ポイントは `Model.stream` と `Tool.stream` で足ります。** この 2 つをラップすれば、エージェントループに手を入れずに、モデル呼び出しとツール実行をそれぞれステップにできます。モデルのストリームはイベント列として記録し、リプレイ時に再生します。ステートフルなプロバイダーのために `modelState` も記録します。
- **ツールエグゼキューターは、公開されているのは実装クラスだけです。** `ConcurrentToolExecutor` と `SequentialToolExecutor` は export されていますが、基底の `ToolExecutor` とオプションの型は `@internal` です。継承して `execute()` をラップし、型は `Parameters<...>` で取り出しました。上流には公開を提案済みです（#762）。
- **`InterruptError` は export されていません。** `error.name` で判定する必要がありました。上流に PR を出しています（#4541）。
- **`appState`（StateStore）は get/set のたびに deep copy し、変更フックがありません。** 並列ツールの差分を正しく帰属させるため、インスタンスの `set`、`delete`、`clear` を差し替え、`AsyncLocalStorage` で「どのツール実行の書き込みか」を追跡しました。スナップショットを比較する方法では、並行する他のツールの書き込みまで拾ってしまいます。スナップショットを丸ごと復元する方法では、他のツールの書き込みを消してしまいます。
- **SDK のクラスが二重に読み込まれると `instanceof` が壊れます。** モノレポでは、SDK をルートに hoist して 1 つにそろえます。tarball で依存させる場合も、`npm ls` で `deduped` になっているかを確認します。
- **上流（strands-agents/harness-sdk）への貢献の作法:**
  - 大きめの変更は Issue で合意を取ってから進めます。
  - 公開 API の変更には、API bar-raising（ユースケース、シグネチャ、export、例）を PR 本文に書きます。
  - Conventional Commits を使います。
  - husky の pre-commit で、build、テスト全件、lint、format check が走ります。
  - 外部コントリビューターの PR の workflow は、メンテナーの承認を待ちます。ラベルは自動で付きます。
  - `strands-ts/AGENTS.md` の規約では、`_` 接頭辞は private だけに使います。インターフェースのプロパティには 1 行の説明が必須です。

## 3. サンプルアプリ（AWS）

- **API とワーカーを分けます。** API Lambda は、durable なワーカーを `DurableExecutionName=runId` で非同期に invoke します。承認は `SendDurableExecutionCallbackSuccess` で返します。
- **ライブ配信には AppSync Events を使います。** ワーカーは IAM で publish し、ブラウザは Cognito の認証で subscribe します。ライブイベントは暫定の副作用として扱い、正しい状態は DynamoDB で判断します。モデル呼び出しがリトライされたら、`attempt` が新しくなった時点で途中のテキストを置き換えます。
- **履歴は確定した範囲だけを返します。** 1 つの run のメッセージ書き込みと `messageCount` の更新は、アトミックではありません。GET で `messageCount` を上限にしないと、確定前のメッセージが表示されます（CodeRabbit の指摘）。
- **ポーリングはフォールバックです。** WebSocket が切れた場合に備えて残します。承認待ちの間は、間隔を 30 秒まで倍々に延ばします。実行中は短い間隔のまま、状態の遷移は見逃さないようにします。
- **CloudFront の関連リソース名にはリージョンを含めます。** 名前はグローバルなので、別リージョンに同じスタックを作ると衝突します。
- **SAM の esbuild ビルドには、PATH 上の esbuild が必要です。** `deploy.sh` から npm スクリプト経由で実行します。
- **認証**:
  - `aws login --remote` のセッションは約 15 分です。
  - SAM から使うには、`credential_process = aws configure export-credentials ...` のプロファイル（`fukuchi-proc`）を用意します。
  - シェルの `AWS_REGION` が優先されるため、毎回明示します。

## 4. OSS 化とツール

- **CodeRabbit:**
  - このアカウントでは手動実行の設定です。`@coderabbitai review` で起動します。
  - Advanced プランでも、自前のレビューは 1 時間に 1 回までです。
  - 差分レビューなので、起動した直後に push すると "Head commit changed" で中断します。push を終えてから起動します。
  - 返信すると、指摘ごとにスレッドを解決済みにしてくれます。
- **ルートの `node` devDependency は PATH の `node` を上書きします。** CI の Node のマトリクスが無効になります（CodeRabbit の指摘）。
- **`actions/checkout` は `persist-credentials: false` にします。** PR のコードや依存のスクリプトからトークンを読まれないようにするためです。
- **npm の新しい install-scripts ポリシーでは、git 依存の `prepare`/`prepack` が実行されません。** `github:` 依存では `dist/` が作られませんでした。npm 公開前は、GitHub Release に `npm pack` の tarball を添付し、その URL に依存します。lockfile に integrity も記録されます。
- **この環境には `git subtree` がありません。** 履歴付きのサブディレクトリの切り出しは、`git filter-branch --prune-empty --subdirectory-filter` でできます。
- **シェルの `cd` が失敗したまま後続のコマンドが走ると、別のリポジトリが操作されます。** 今回は `git remote remove origin` が作業リポジトリで実行されました。`set -e` を付けるか、コマンドごとに作業ディレクトリを指定します。
- **ヘッドレス Chromium（E2E）:** Playwright の Chromium に、ローカルのライブラリ（`/tmp/chromelibs`）とフォント設定（`/tmp/fonts.conf`）を渡すラッパー（`/tmp/chrome.sh`）を使うと動きます。Cognito のマネージドログインも通ります。

## 5. テストの方針

- 回帰テストは、修正前のコードで失敗することを必ず確認しました。
  - 並列ツールの `appState`: 完了順を逆にするゲートを作りました。
  - 失敗したステップのロールバック: `EventSink` を失敗させてステップを失敗させました。
- プロバイダーに依存しないスクリプト化したモデル（`test/helpers.ts`）を使うと、リプレイ、リトライ、割り込み、並列、MCP、オフロード、`modelState` を AWS なしで検証できます。AWS 上の検証（スモークスクリプトとブラウザの E2E）は、Lambda の実際のサスペンドと再開を確かめるために別途行いました。
