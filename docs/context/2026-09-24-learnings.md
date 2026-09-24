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

## 軽量コアの設計スパイク

- **エンジンによって、オペレーションの同一性の決まり方が違います。** Cloudflare Workflows の `step.do` は、名前をキャッシュのキーにします（公式ドキュメントの「Name steps deterministically」）。`Promise.all` で並列に実行できますが、`Promise.race` は step で囲む必要があります。Lambda は呼び出し順で決まります。両方に対応するには、名前を一意かつ決定的にしたうえで、開始順も固定します。
- **コーデックは、プリミティブの中ではなく、エンジンの境界に置きます。** モデルとツールの関数の中だけで `$bytes` の encode をしていたところ、子コンテキスト（scope）の戻り値として JSON 化されるときに、`Uint8Array` が `{"0":1,...}` に壊れました。Lambda では step と `runInChildContext` の両方に同じ `serdes` を渡します。
- **Lambda の SDK の `Serdes<T>` と `step<T>` の型は、ジェネリックのまま受け渡します。** `Serdes<unknown>` を渡すと、戻り値が `Promise<unknown>` になり、型エラーになります。アダプターのメソッドを `step<T>(...)` と書き、`serdes<T>()` を作って渡します。SDK の `Duration` は、少なくとも 1 つのキーが必須の union です。`{ seconds }` に変換して渡すと簡単です。
- **`LocalDurableTestRunner.teardownTestEnvironment()` は、`setupTestEnvironment()` を呼んでいないと例外を投げます。** Lambda 以外のテストと同じファイルにあると、共通の `afterEach` で失敗します。Lambda のテストの中で `t.after()` を使います。
- **Web 標準の API だけで書けば、Bun でもそのまま動きます。** `btoa`/`atob`、`crypto.randomUUID`、`Promise.withResolvers` を使い、`Buffer`、`node:crypto`、`AsyncLocalStorage` は使いません。コンテキストは引数で渡します。
- **npm の短いローマ字の名前は、ほとんど使われています。** `npm view <name>` が E404 を返せば空きです。npmjs.com の org ページは 403 になるため、スコープが空いているかはこの方法では確認できません。
- **`https://registry.npmjs.org/<name>` を直接読むと、取り下げられた名前も分かります。** その場合は `time.unpublished` に記録があります。例えば `tsubame`、`kohaku`、`raijin` は 2021〜2022 年に取り下げられていました。取り下げから 24 時間が経てば、名前は再利用できるはずです（未検証）。
- **名前を選ぶときは、npm だけでなく GitHub の星の数も確認します。** `gh search repos <name> --sort stars` で調べます。npm では空いていても、同じ名前の有名なプロジェクトがあると、検索でまず勝てません。例: `shiori` には go-shiori（星 11,651）があり、`kohaku` には同じ名前の AI エージェントのフレームワークがありました。

## minamo のリポジトリ作成

- **Lambda の SDK の `context.step` は、`retryStrategy` を省くと SDK の既定のリトライが動きます。** `memory` エンジンは省くとリトライしないので、エンジンによって振る舞いが変わっていました。`retry` がないときは `() => ({ shouldRetry: false })` を明示して、どちらのエンジンでも 1 回だけ実行するようにしました。
- **一時的なエラーを判定する正規表現に、`\b5\d\d\b` や `\b429\b` のような数字を入れてはいけません。** 「520 tokens」のような検証エラーの文言に一致して、リトライしてしまいます。`throttl`、`service.?unavailable`、`internal.?server` のような語で判定します。
- **README のコード例は、`test/` に同じコードの `.ts` を置いて `npm run typecheck` で検査します。** 利用者のコードは `declare` で宣言します。ファイル名を `*.test.ts` にしなければ、テストとしては実行されません。
- **`gh repo create <owner>/<name> --public --source . --push` を使えば、ローカルのリポジトリから作成と push が 1 回で済みます。** その後、`gh run watch <id> --exit-status` で CI の完了を待てます。

## minamo の例を AWS にデプロイ

- **SAM のテンプレートは、SAM CLI がなくてもデプロイできます。** `Transform: AWS::Serverless-2016-10-31` は CloudFormation 側で処理されるので、`aws cloudformation package` と `aws cloudformation deploy --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND` で足ります。`AutoPublishAlias` と `DurableConfig` も、この方法で動きました。
- **esbuild の `alias` にパッケージのディレクトリを指定すると、`main`（CommonJS 版）に解決されます。** `@aws/durable-execution-sdk-js` の CommonJS 版を ESM の bundle に入れると、Lambda の init が `__filename is not defined in ES module scope` で失敗します。`dist/index.mjs` を直接指定します。デプロイの前に、`node -e "import('./dist/index.mjs')"` で読み込めるか確認すると、この失敗を先に見つけられます。
- **init でエラーになると、durable execution は `RUNNING` のまま再試行を続けます。** 呼び出しの失敗が履歴の `InvocationCompleted` に積み上がります。`aws lambda stop-durable-execution` で止めます。
- **`file:../..` の依存はシンボリックリンクになります。** esbuild はリンク先から依存を解決するので、SDK が 2 つ bundle されます。`preserveSymlinks` を使うと、リンク先の `node_modules` を見てしまいます。`alias` で 1 つにそろえます。
- **`list-durable-executions-by-function` の `--qualifier` にエイリアスは使えません。** "Cannot filter by alias" になるので、関数名だけで一覧を取得します。実行の ARN には、エイリアスではなくバージョン番号が入ります（`...:minamo-example-agent:2/durable-execution/...`）。
- **実行の履歴（`get-durable-execution-history`）から、コールバック ID が分かります。** `CallbackStarted` のイベントの `CallbackStartedDetails.CallbackId` です。`waitForCallback` の内部のオペレーションには名前がないので、`SubType`（`Callback`、`Step`）で識別します。
- **ツールのリトライ待ちの後、次の試行は別の呼び出しで動くようです。** 承認待ちを含む実行で、呼び出しが 3 回になりました。1 回目の実行、リトライ待ちの後、承認後の再開と推測しています（ログでの裏付けはしていません）。
- **npm の Trusted Publishing は、既にあるパッケージの設定画面で登録します。** そのため、最初の公開は手動（`npm login` と `npm publish`）で行います。2026-09 以降に登録した設定は、既定で `npm stage publish`（staged publishing）だけを許可します。`npm publish` も許可するかは、登録時に選びます。npm CLI 11.5.1 以上と Node 22.14 以上が必要です。

## minamo の scoped package 公開

- npm registry に名前が存在しなくても、公開時の類似名チェックで拒否されることがあります。`minamo` は `minami`、`minio` に似ているとして 403 になりました。org `minamojs` を作成し、`@minamojs/minamo` と `@minamojs/lambda-df` にしました。
- パッケージ名変更では、ソースの import だけでなく workspace スクリプト、peerDependencies、tsconfig paths、release workflow、README、lockfile も更新します。内部の `packages/core` ディレクトリ名は公開名と一致させる必要はありません。
- workspace 内だけの検証ではリンクや tsconfig paths に問題が隠れるため、pack した tarball を別ディレクトリにインストールし、公開 import と実動作を確認しました。
- 今回は最初の npm publish のブラウザ承認後、2 つ目は追加承認なしで成功しました。ただし毎回同じ動作になる保証はありません。
- publish が成功して org の package 一覧に載っても、直後の public registry GET は 404 でした。バージョン別 endpoint と tarball が先に取得でき、その後 metadata と alpha タグが反映されました。反映後の `npm install ...@alpha` は成功しています。初回 Release workflow も metadata 反映前に公開済み判定が外れて失敗しましたが、反映後の再実行は既公開のバージョンをスキップして成功しました。
