# Lambda durable functions上のTypeScript AIエージェント調査

調査日: 2026-09-20。公開ドキュメント、公開リポジトリの実装、関連テストを確認した。AWSへのデプロイ、実機での障害注入、テストスイートの実行は行っていない。以下では確認した実装と設計提案を区別する。GitHub mainの調査結果は、現在のnpm安定版ですべて利用できることを意味しない。

## 結論

Lambda durable functions自体はTypeScriptをサポートしており、Python限定なのは提示されたPydantic AI統合である。TypeScriptによるモデル呼び出し単位のdurabilityは既にAWSのサンプルにある。一方、Strands TSを既存のAgent APIのまま接続し、モデル・各ツール・MCP discovery・制御フローまで透過的に永続化するLambda用パッケージは、今回の公式文書・実装・公開検索では確認できなかった。

有力な選択肢は次の3つ。

1. Lambda durable functionsを必須にするなら、Strands TS用アダプターを作る。参考にすべき実装はPydanticの汎用durability層とTemporal公式のStrands TS統合。
2. フレームワークにこだわらずLambda上で早く動かすなら、AWSのTypeScript agent loopサンプルを出発点にする。複数プロバイダーが必要ならAI SDK用の小さなアダプターが候補。
3. durable実行基盤を変更できるなら、Strands TS + Temporal、AI SDK + DBOS、AI SDK + Restate、WorkflowAgentが既存の代替になる。

「存在しない」という網羅的な証明ではなく、2026-09-20時点の公開範囲の調査結果である。

## 1. Pydantic版が実際に永続化しているもの

提示された[AWS統合記事](https://docs.aws.amazon.com/durable-execution/sdk-reference/integrations/pydantic-ai/)と[Pydanticの説明](https://pydantic.dev/docs/ai/harness/aws-lambda/)に対応する実装は、主に2つのリポジトリに分かれる。

| 層 | 実装 | 役割 |
|---|---|---|
| Pydantic共通層 | `pydantic_ai/durable_exec/_base.py` | モデル、ツール、MCP、動的toolsetなどの呼び出し境界を捕捉 |
| 共通backend契約 | `_operation_backend.py` | operationの命名、戻り値のencode/decode、backendへのdispatch |
| Lambda capability | `pydantic_ai_harness/aws_lambda/_capability.py` | Lambda向け設定、逐次ツール実行、backend選択 |
| Lambda backend | `_operation_backend.py` | operationをbridgeの`run_step`に接続 |
| Python bridge | `_bridge.py` | 同期Lambda handlerと非同期Agentのスレッド・イベントループ接続 |
| 制御フローのcodec | `durable_exec/_toolset.py` | approval/deferred/retry等を保存可能な値に変換して復元 |

根拠: [Pydantic共通層](https://github.com/pydantic/pydantic-ai/blob/c4898abb54dc25ae6f6aef208a4c0661b30a455e/pydantic_ai_slim/pydantic_ai/durable_exec/_base.py)、[backend契約](https://github.com/pydantic/pydantic-ai/blob/c4898abb54dc25ae6f6aef208a4c0661b30a455e/pydantic_ai_slim/pydantic_ai/durable_exec/_operation_backend.py)、[Lambda capability](https://github.com/pydantic/pydantic-ai-harness/blob/b7658c3eee0bfdda1ea4e82cd4cb976adb6c6299/pydantic_ai_harness/aws_lambda/_capability.py)、[Lambda backend](https://github.com/pydantic/pydantic-ai-harness/blob/b7658c3eee0bfdda1ea4e82cd4cb976adb6c6299/pydantic_ai_harness/aws_lambda/_operation_backend.py)。

実行中のメモリやPythonスタックを保存する仕組みではない。handlerを先頭から再実行し、完了済みI/Oの戻り値をjournalから取り出すことで、エージェントの会話と制御フローを再構成する。LLM出力のtool call IDや引数も保存済み応答から復元されるため、完了済み推論を再生成せずに次へ進める。[AWSのreplay仕様](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/determinism/)

共通層は通常のmodel requestだけでなく、stream request、compaction、suspended responseのcancel、function tool、MCPの一覧・instructions・実行、dynamic toolsetの解決、capability operation、event handlerを対象とする。streamはstep内で読み切り、最終応答と収集したイベントを保存する。すべてのPython関数や任意の副作用が自動でdurableになるわけではない。[共通層のモデル処理](https://github.com/pydantic/pydantic-ai/blob/c4898abb54dc25ae6f6aef208a4c0661b30a455e/pydantic_ai_slim/pydantic_ai/durable_exec/_base.py#L1327)

特に重要なのが`ModelRetry`、`ApprovalRequired`、`CallDeferred`、`ToolFailed`。これらをstep失敗としてそのまま渡すとAWS側のretry対象になってしまう。実装はタグ付きの値に変換してcheckpointを越え、Agent側で意味を復元する。承認要求を返せることと、外部通知・callback受付・長期待機がすべて自動設定されることは別である。[制御フローの変換](https://github.com/pydantic/pydantic-ai/blob/c4898abb54dc25ae6f6aef208a4c0661b30a455e/pydantic_ai_slim/pydantic_ai/durable_exec/_toolset.py#L317)

Python特有の複雑さもある。Lambda SDKの同期stepをhandlerスレッドで実行する必要があるため、Agentを別スレッドのイベントループで走らせ、queue経由で接続している。調査時点の`_bridge.py`は605行で、キャンセル・ループ再利用・破棄・入れ子stepの拒否も扱う。JS SDKはasync handlerとPromiseを扱うため、このbridgeを直訳する必要はない。ただし、Pydanticの共有層に相当するcodecやAgentとの接続は必要になる。[bridge実装](https://github.com/pydantic/pydantic-ai-harness/blob/b7658c3eee0bfdda1ea4e82cd4cb976adb6c6299/pydantic_ai_harness/aws_lambda/_bridge.py)、[JS handler実装](https://github.com/aws/aws-durable-execution-sdk-js/blob/2b21bb7f761c7e9d2409c0c24da41fc6c0c703a0/packages/aws-durable-execution-sdk-js/src/with-durable-execution.ts)

関連テストは、完了済みモデル・ツールのreplay、途中失敗、MCP一覧・呼び出し、動的toolset、制御フロー、serialization、bridgeの停止やキャンセルを扱っている。確認したLambda固有テストは主に`FakeDurableContext`を使うため、これをそのままAWS実機の検証実績と扱うことはできない。[テスト](https://github.com/pydantic/pydantic-ai-harness/tree/b7658c3eee0bfdda1ea4e82cd4cb976adb6c6299/tests/aws_lambda)

## 2. AWSのTypeScript既存サンプル

同じリポジトリの2ファイルを区別する必要がある。

| サンプル | 保存の粒度 | 評価 |
|---|---|---|
| `durable-strands-agent.ts` | `agent.invoke()`全体を1つのstepにする | 完了したAgentの再実行は防げるが、Agent実行中のクラッシュは内部処理を最初からやり直す |
| `agent.ts` | Bedrock Converseをstep化し、各toolをchild contextで実行 | LLM/tool loop単位の耐障害性とhuman reviewの構成例。Strands統合ではない |

根拠: [Strandsサンプル](https://github.com/aws-samples/sample-ai-workflows-in-aws-lambda-durable-functions/blob/e3bd7703f2e64801f568a28d9f57bba56f031d30/typescript/src/durable-strands-agent.ts)、[明示的agent loop](https://github.com/aws-samples/sample-ai-workflows-in-aws-lambda-durable-functions/blob/e3bd7703f2e64801f568a28d9f57bba56f031d30/typescript/src/agent.ts)。

後者は`waitForCallback`をtoolから利用するため`runInChildContext`を使っている。child contextの完了結果もcheckpointされるが、その内部で複数の外部副作用を行うなら、それぞれをさらにstepで囲む必要がある。ループ上限、usage budget、未知のtool、schema不一致、providerエラー分類などは、本番化時に追加する。[child contextの仕様](https://docs.aws.amazon.com/durable-execution/sdk-reference/operations/child-context/)

したがって「TypeScriptでは実現できない」ではなく、「Lambda上で動く土台は存在し、Strandsへの汎用統合が不足している」という状況である。

## 3. Strands TSのcheckpoint機能をそのまま使えるか

TypeScript checkpointは[v1.9.0の変更履歴](https://strandsagents.com/changelog/harness/typescript-v1.9.0/)に掲載されている。ただし調査した現行実装はexperimentalであり、次の性質を持つ。

- `Checkpoint`は`position`、`cycleIndex`、`schemaVersion`を持つ。会話本文は含まず、別途SessionManager等が必要。
- 境界は`afterModel`と`afterTools`。各toolの途中完了を個別に保存する機能ではない。
- TSではassistantのtool-use messageをtool群完了後に履歴へ追加する。そのため`afterModel`再開ではモデルを再度呼ぶ。
- toolを呼ばない最終回答にはcheckpointを出さない。
- metricsはinvocationごとにリセットされ、hooksはresume時にも発火する。

これは推測ではなく[checkpoint.tsの説明と型](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/experimental/checkpoint.ts)、[Agentの分岐](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/agent/agent.ts#L1689)で確認できる。

例えばモデルがtool A/B/Cを指定し、B完了直後にプロセスが落ちた場合、`afterTools`しか永続化していなければ、A/Bの実行済み結果を保存する別の仕組みが必要になる。単にSessionManagerやDynamoDB storageを付けるだけでは、Lambdaのoperation journalと一体の復旧にはならない。

公開issueにはprovider非依存checkpointの[epic #2510](https://github.com/strands-agents/harness-sdk/issues/2510)やcallback待機の[#2243](https://github.com/strands-agents/harness-sdk/issues/2243)がある。ただし後者はPythonの問題提起であり、古いissueの「未対応」を現行TSにもそのまま適用すべきではない。上記の判断は現行ソースに基づく。

## 4. 既存の代替と実装上の参考

| 選択肢 | 対象言語／Agent | durable実行の主体 | Lambda durable functionsとの関係 |
|---|---|---|---|
| Temporal公式Strands統合 | TS / Strands | Temporal workflow + activity | AWSネイティブdurable SDKを使用しない |
| DBOS Vercel AI統合 | TS / AI SDK | DBOS + PostgreSQL | Lambdaのjournalを使用しない |
| Restate AI middleware | TS / AI SDK | Restate | 通常のLambdaへ配置可能。AWSネイティブdurableとは別基盤 |
| WorkflowAgent | TS / AI SDK | Workflow DevKit | Lambda SDKに接続した実装ではない |
| Inngest AgentKit | TS | Inngest | 別のschedulerとdurable stateを使う |
| LangGraph JS | TS/JS | checkpointer + graph runtime | 永続storeとresume実行の設計が必要 |
| Mastra Durable Agents | TS | Mastraの実行・stream基盤 | 接続断からのstream復帰とプロセスクラッシュからの各I/O復旧を区別する必要あり |

### Temporal + Strands TS

`@temporalio/strands-agents`が実在する。調査したpackage.jsonは1.24.0、README上はexperimental。`TemporalAgent`、`TemporalModel`、`activityAsTool`、`TemporalMCPClient`を提供する。[公式実装](https://github.com/temporalio/sdk-typescript/tree/7ae5c7fb6728fe93696e1fc2f0da97018f6f20cc/contrib/strands)

`TemporalModel.stream()`はモデルactivityの結果としてイベント配列を受け取り、Agentへ再送する。worker側のactivityが実モデルstreamを消費する。toolはactivity呼び出しを返すToolで包む。Agentのretryを無効にしてTemporalへ委ね、MCP discoveryもactivity化する。interruptをactivity境界越しに復元するfailure converterもある。すべての既存toolが自動activity化されるわけではなく、I/O toolは専用wrapperで登録する。[model adapter](https://github.com/temporalio/sdk-typescript/blob/7ae5c7fb6728fe93696e1fc2f0da97018f6f20cc/contrib/strands/src/temporal-model.ts)、[Agent](https://github.com/temporalio/sdk-typescript/blob/7ae5c7fb6728fe93696e1fc2f0da97018f6f20cc/contrib/strands/src/temporal-agent.ts)、[tool adapter](https://github.com/temporalio/sdk-typescript/blob/7ae5c7fb6728fe93696e1fc2f0da97018f6f20cc/contrib/strands/src/temporal-activity-tool.ts)

Lambda向け新規アダプターには、この構造がPydanticのPython bridgeより直接的な参考になる。ただしactivityをstepへ機械的に置換するだけでは、callback・nested operation・serializationの違いを吸収できない。

### DBOS + AI SDK

`@dbos-inc/vercel-ai`は`durableCalls`、`durableTools`、`durableMCPTools`、`agentTool`、durable streamを持つ。モデルmiddlewareだけでtoolも永続化されるわけではなく、tool wrapperが別途必要。調査したREADMEではAI SDK v7+、DBOS v4.21+またはv5、PostgreSQLが必要。[README](https://github.com/dbos-inc/dbos-vercel-ai/tree/10ce52a8030ec0307946dd80d655da7fb0b842a2)

実装は`DBOS.runStep`でI/Oを保存し、モデルのstream完了をcheckpointする前に次のtool stepが先行しないようfinishイベントを制御する。subagentはstep内に入れずchild workflowとして扱う。同一workflow内の並列model callには制限がある。[middleware](https://github.com/dbos-inc/dbos-vercel-ai/blob/10ce52a8030ec0307946dd80d655da7fb0b842a2/src/middleware.ts)、[tool wrapper](https://github.com/dbos-inc/dbos-vercel-ai/blob/10ce52a8030ec0307946dd80d655da7fb0b842a2/src/tools.ts)

### Restate + AI SDK

`@restatedev/vercel-ai-middleware`は`wrapGenerate`から`ctx.run`を呼ぶ。確認した実装の`durableCalls`には`wrapStream`はないため、streamTextをそのまま包めば同じ保証になるとは言えない。toolは明示的に`ctx.run`等を使う。[middleware本体](https://github.com/restatedev/vercel-ai-middleware/blob/62eeb7b6d803fc93884b8454c2d949a734b5489a/src/lib/ai_infra.ts)、[公式agent例](https://github.com/restatedev/ai-examples/blob/main/vercel-ai/template/src/app.ts)

Restate serviceをTypeScriptのLambda handlerとして配置する経路は公式にあるが、Restate server／Cloudが別途必要。[Lambda配置](https://docs.restate.dev/services/deploy/lambda)

### WorkflowAgent / Inngest / LangGraph / Mastra

AI SDKの`@ai-sdk/workflow`に`WorkflowAgent`がある。旧`@workflow/ai`の`DurableAgent`は非推奨と案内されている。現行ソースのドキュメントはWorkflow 5 betaを要求する。独自runtime、step変換、stream、approvalの仕組みを使うため、AWS DurableContextを渡すだけで動く製品ではない。[WorkflowAgentドキュメントのソース](https://github.com/vercel/ai/blob/20dd00abba618d5a516e0fee40ccd3e18a2bd1fb/content/docs/03-agents/07-workflow-agent.mdx)、[旧APIの案内](https://github.com/vercel/workflow/blob/main/docs/content/docs/v4/api-reference/workflow-ai/durable-agent.mdx)

Inngest AgentKitにはTypeScriptのagent networkとdurable toolの構成がある。別の実行基盤を受け入れる場合の候補。[AgentKitのmulti-step tool](https://agentkit.inngest.com/advanced-patterns/multi-steps-tools)

LangGraph JSは永続checkpointer、node retry、interrupt/resumeを持つ。単にAWSのcheckpoint用serializerへ差し替えれば統合できる種類の抽象ではない。Lambdaでの再起動・callback・実行継続は別途接続する。[persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)

MastraのDurable Agents紹介はclient disconnectからのstream復帰を中心に説明している。この機能名だけでは、各LLM/tool呼び出しのプロセスクラッシュ耐性を立証できない。Lambda用の透過的durability統合も今回確認できなかった。[Mastraの説明](https://mastra.ai/blog/introducing-durable-agents)

OSSという条件ではライブラリとserverのライセンスを分けて評価する。Temporalの当該TS統合とDBOS AI統合はMIT。Restate middlewareはMITだがserverはBSL 1.1、Inngest serverはSSPLと将来のApache移行条項があり、これらを一律にOSI型OSSと呼ぶのは不正確。[Restate license](https://github.com/restatedev/restate/blob/main/LICENSE)、[Inngest license](https://github.com/inngest/inngest/blob/main/LICENSE.md)

## 5. 新規Strands Lambdaアダプターの設計案

以下は未実装の提案であり、既存パッケージのAPI説明ではない。

### 実行境界

```text
withDurableExecution
  └─ Agentの通常ループ（replayで再構成）
      ├─ Model.stream adapter → context.step → LLM
      ├─ 通常tool adapter     → context.step → 外部API
      ├─ MCP discovery        → context.step → list tools / instructions
      ├─ 承認・待機tool        → child context → waitForCallback
      └─ subagent tool        → child context → 子Agentのモデル/ツールstep
```

最初は既存Agentのループを再利用する。モデルとtoolの実行境界を包むだけで成立するかを検証し、それで不足すると判明した場合にloopへの拡張を検討する。

### 利用できる拡張点と選択

Strands TSには`Model.stream`、`Tool.stream`、`InvokeModelStage`、`ExecuteToolStage`、`Agent.addMiddleware`がある。middlewareは`next()`を呼ばず結果を返せるので、durable replayの差し込み口になる。[middleware型](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/middleware/stages.ts)、[model契約](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/models/model.ts)

ただし現行middlewareではmodelStateがcontextに含まれず、Agentがterminalの一時modelStateを書き戻す。READMEもmiddlewareによるmodelState変更に制限があると明記する。モデルのstateまで扱う汎用版では、`Model.stream(messages, options)`のwrapperで`options.modelState`の変化を保存・復元する設計、またはupstreamのmiddleware契約拡張が必要。最初のBedrock向けMVPをstateless providerに限定すれば、この問題を切り分けられる。[middleware設計](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/middleware/README.md)、[modelState処理](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/agent/agent.ts#L2250)

### MVPの仕様

- handler invocationごとに新しいAgentを構築し、同じ入力からreplayする。可変Agentをwarm環境のglobalに保持しない。
- 各model requestを1 stepにし、最終結果または正規化したstreamイベント列を保存する。streamオブジェクト自体は保存しない。
- 各toolを個別stepにする。最初は`toolExecutor: 'sequential'`を固定する。
- step名は固定agent ID、論理call順序、保存されたtoolUseId等から生成する。名前を付けるだけでoperation順序問題が消えるわけではない。
- checkpoint結果はバージョン付きDTOにし、Message、ToolResultBlock、binary content、usage、stop reason、例外を明示的にencode/decodeする。
- モデルretryはLambdaに集約する。Strandsの`retryStrategy: null`とprovider clientのretry設定を合わせて検証する。
- toolの業務エラー、インフラretry対象、Agent interruptを分離する。`FunctionTool.stream`が例外をerror ToolResultへ変換するので、単純にその外をstepで囲むとAWSには成功と見える場合がある。
- hooksやmiddlewareが行う外部I/O、時刻取得、動的prompt、MCP一覧取得を棚卸しする。通常hooksはdurable middlewareのcache hitでも発火する。
- 最初はtoolによる任意のAgent内部状態変更を制限する。必要な状態変化は戻り値に含め、stepの外で同じように適用する。

根拠: [FunctionToolのerror処理](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/tools/function-tool.ts#L175)、[hooksとmiddlewareの境界](https://github.com/strands-agents/harness-sdk/blob/54ca0befa69a1e8e8d7f3083da62a8e9d341f050/strands-ts/src/middleware/README.md)、[AWSの戻り値によるstate再構成](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/determinism/)。

### 待機とsubagent

通常のstepの中に`waitForCallback`や子Agentのdurable stepを入れない。複数durable operationを含むtoolは専用のworkflow toolとして登録し、child contextで実行する。外部通知・callback timeout・戻ってきた承認結果のschema検証も設計対象にする。JS SDKはhandler promiseとtermination promiseを競合させてsuspendを処理しているため、Pythonの`SuspendExecution`例外方式をそのまま移植しない。[JS runtime](https://github.com/aws/aws-durable-execution-sdk-js/blob/2b21bb7f761c7e9d2409c0c24da41fc6c0c703a0/packages/aws-durable-execution-sdk-js/src/with-durable-execution.ts#L175)

### 並列化とstreaming

逐次実行でreplayを証明した後、tool群を`context.map`／`parallel`等のchild scopeへ接続する。単に既存executorの`Promise.all`を残す設計は、step登録前の非同期処理によりoperation順序が変わらないことを別途証明しなければならない。

初版はモデルstreamをstep内で最後まで読み、checkpoint後にAgentへ渡す方式が単純。外部クライアントへのlive token配信は別機能として設計する。再試行時に途中tokenが重複・置換されるため、execution ID、model-call ID、attempt、sequenceなどでイベントを識別し、再接続可能な保存先・配送路を用意する。tokenごとにLambda stepを作る設計はoperation数を消費しすぎる。

### exactly-onceを約束しない

toolの外部副作用が成功した直後、checkpoint保存前にクラッシュする窓がある。通常のstepは再実行され得る。決済や発注は実行をまたいで安定したidempotency keyと相手側の重複排除を組み合わせる。

`StepSemantics.AtMostOncePerRetry`はretryごとの保証であり、単独ではtool全体の一回性を保証しない。retry無効化と組み合わせても、途中で切れた処理の成否が不明になる問題は残る。[JSのstep semantics](https://github.com/aws/aws-durable-execution-sdk-js/blob/2b21bb7f761c7e9d2409c0c24da41fc6c0c703a0/packages/aws-durable-execution-sdk-js/src/types/step.ts)

1 executionの上限は3,000 durable operations、累積保存100 MB。単一Lambda invocationは最大15分であり、1年のdurable executionと区別する。大きいtool結果はS3参照にし、長い会話は実行を分割する。published versionでコードとstep配置を固定する。[AWS quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html#limits-durable-functions)

## 6. AI SDK用アダプターという別案

Strandsが必須でなければ、AI SDKの`wrapLanguageModel`で`doGenerate`をLambda step化し、toolの`execute`も別途step化する案は比較的小さい。DBOSとRestateがこの設計の具体例になっている。

制御しやすさを優先する場合、1回のモデル呼び出しではtoolを自動実行させず、返されたtool callを自前のloopで逐次またはdurable map実行する。モデル応答とtool resultをそれぞれメッセージ履歴へ戻す。これならcallbackやsubagentをstepの外に置く場所が明確になる。

ただしAI SDKの`generateText`全体をstepに入れ、その内側で実行されるtoolもstep化する設計は避ける必要がある。multi-step generationなら複数の推論が1 stepになったりnested durable operationになったりする。包む位置は個々のprovider callまたは明示的な1回のmodel roundである。

OSSとしては、最初から全framework共通の大きなengineを作るより、Strands用とAI SDK用のアダプター境界を小さく定め、命名・codec・retry設定・テスト補助だけを共有する方が責務が明瞭になる。

## 7. 実装前に合意しておく受け入れテスト

| 障害・操作 | 期待する結果 |
|---|---|
| モデルstep保存後にプロセス停止 | そのLLMを再度呼ばず、同じtool callへ進む |
| A/B/CのB保存後に停止 | A/Bを呼び直さずCから外部処理を継続 |
| 副作用成功後・checkpoint前に停止 | 再試行されても業務結果がidempotency keyで重複しない |
| human approvalでsuspend | invocationを終了でき、callback後の新規invocationで継続 |
| モデル／ツールの一時エラー | 対象stepだけが指定policyでretryされる |
| error ToolResult／interrupt | 業務上の結果や承認要求として復元され、不要なインフラretryを起こさない |
| MCP serverのtool一覧が変化 | 既存executionは記録した定義でreplayし、新規executionだけが新定義を見る |
| warm環境で別execution | 会話履歴、call counter、tool状態が混線しない |
| toolがappStateを更新 | fresh実行とreplay後の状態が一致する |
| tool並列完了順序が変わる | 結果のtoolUseId対応が変わらない |
| streamの途中停止 | 完了済みmodel callを再課金せず、未完了attemptの出力は識別・置換できる |
| 古いexecutionが残る状態で新version公開 | 古いcodeとjournalの対応を維持できる |

最初にAWS LocalDurableTestRunnerでserial MVPを確認し、その後published Lambda versionを用いたcold restart・callback・timeoutの実機試験を行う。メモリ上のMapだけによる疑似checkpoint試験では、Lambdaのsuspendと再起動は証明できない。[AWS Testing](https://github.com/aws/aws-durable-execution-sdk-js/tree/2b21bb7f761c7e9d2409c0c24da41fc6c0c703a0/packages/aws-durable-execution-sdk-js-testing)

## 調査したソースの固定点

| Repository | Commit |
|---|---|
| pydantic/pydantic-ai | `c4898abb54dc25ae6f6aef208a4c0661b30a455e` |
| pydantic/pydantic-ai-harness | `b7658c3eee0bfdda1ea4e82cd4cb976adb6c6299` |
| strands-agents/harness-sdk | `54ca0befa69a1e8e8d7f3083da62a8e9d341f050` |
| aws/aws-durable-execution-sdk-js | `2b21bb7f761c7e9d2409c0c24da41fc6c0c703a0` |
| aws-samples/sample-ai-workflows-in-aws-lambda-durable-functions | `e3bd7703f2e64801f568a28d9f57bba56f031d30` |
| temporalio/sdk-typescript | `7ae5c7fb6728fe93696e1fc2f0da97018f6f20cc` |
| dbos-inc/dbos-vercel-ai | `10ce52a8030ec0307946dd80d655da7fb0b842a2` |
| restatedev/vercel-ai-middleware | `62eeb7b6d803fc93884b8454c2d949a734b5489a` |
| vercel/ai | `20dd00abba618d5a516e0fee40ccd3e18a2bd1fb` |

比較の主要部分は実装まで読んだ。Inngest、LangGraph、Mastraは公式資料による補足評価であり、全内部実装を同じ深さで監査したものではない。npm registryの直接取得には制限があったため、mainのAPI利用可否は採用する公開バージョンに対して改めて確認する必要がある。