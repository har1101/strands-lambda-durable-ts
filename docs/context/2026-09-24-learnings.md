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
