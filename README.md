# Durable Lambda + Azure OpenAI + Webhook サンプル (CDK TypeScript)

AWS Lambda Durable Functions の **callback パターン**を使って、
Azure OpenAI の結果を Webhook で受け取り、Durable Function を再開する最小サンプルです。

参考記事: https://dev.classmethod.jp/articles/aws-lambda-durable-functions-callback-awsreinvent/

## 構成
```
Client -> /invoke -> DurableFunction (createCallback)
                         |-> WorkerFunction -> Azure OpenAI (responses.create background)
Azure OpenAI -> WebhookReceiver -> SendDurableExecutionCallbackSuccess -> DurableFunction resumes
```

## 前提
- Durable Functions は **対応リージョン**でのみ利用可能です。
  最新状況は AWS 公式を確認してください。
- Durable Functions の対応ランタイムは Node.js 22/24 です。

## デプロイ (1発)
前提: AWS CDK v2 が入っていること。

`.env` に設定を書く方式に変更しました。

```bash
cp .env.example .env
# .env を編集
npm install
npx cdk bootstrap
npx cdk deploy
```

### .env 設定項目
- `AZURE_OPENAI_ENDPOINT` (例: `https://<resource>.openai.azure.com` ※末尾にパスを付けない)
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_MODEL` (Foundry のモデル名。旧来のデプロイ名しかない場合は `AZURE_OPENAI_DEPLOYMENT` でも可)
- `AZURE_OPENAI_API_VERSION` (省略可)
- `DURABLE_EXECUTION_TIMEOUT` (秒, 省略可)
- `DURABLE_RETENTION_DAYS` (日, 省略可)
- `MAX_TOOL_STEPS` (省略可 / ツール呼び出しの最大ステップ数。既定 5)
- `INVOKE_API_KEY` (API Gateway の呼び出しキー)

※ `.env` は **CDK の synth/deploy 時に読み込まれ** Lambda 環境変数に埋め込まれます。機密値はコミットしないでください。
`openai/v1` 形式を使う場合は `AZURE_OPENAI_API_VERSION` は無視されます。`api-version` 形式を使う場合は **Webhooks 対応の preview 版**を指定してください。

デプロイ後に `Outputs` として以下が表示されます:
- `InvokeUrl` : 受付エンドポイント
- `WebhookUrl` : Azure Webhook の送信先 URL
- `WebhookSecretParam` : Webhook 署名 secret が保存される SSM パラメータ名

## Azure Webhook の作成
CDK の **Custom Resource** がデプロイ時に Azure 側へ Webhook を登録し、`signing_secret` を SSM に保存します。
手動作成は不要です。
登録されるイベントは `response.completed`, `response.failed`, `response.incomplete` です。
SSM から値を確認する場合は以下を実行してください（秘密情報なので取り扱い注意）。

```bash
aws ssm get-parameter --name "$WEBHOOK_SECRET_PARAM" --with-decryption
```

※ Webhook は **リソース単位のイベント購読**です。リクエストごとに callback URL を渡す形式ではありません。

## Durable Function の実行方法
このサンプルは **/invoke を同期呼び出し** して結果を受け取る形です。
Azure OpenAI の処理時間によってはレスポンスが返るまで待ちます。

### 1) API Gateway (/invoke)
```bash
curl -X POST "$INVOKE_URL" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $INVOKE_API_KEY" \
  -d '{
    "prompt": "日本語で一言ください",
    "systemPrompt": "あなたは丁寧なアシスタントです。",
    "temperature": 0.7,
    "maxTokens": 256,
    "metadata": {"userId": "demo"}
  }'
```

`prompt` の代わりに `messages` (role/content) を渡すこともできます。

### サイコロ tool デモ (Webhook 経由で function calling)
このサンプルでは `roll_dice` ツールを常に公開しています。
以下のように **2回呼び出して合計**する指示を出すと、Webhook → tool 実行 → 追加入力 → 完了 の流れになります。

```bash
curl -X POST "$INVOKE_URL" \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $INVOKE_API_KEY" \
  -d '{
    "prompt": "必ず roll_dice を2回呼び出して、その合計だけを返してください。",
    "metadata": {"userId": "dice-demo"}
  }'
```

Webhook 受信側が `function_call` を検出したらツールを実行し、`function_call_output` を
`previous_response_id` 付きで Azure OpenAI に送り直します。
ツール呼び出しが無くなった時点で durable callback を完了します。

### 2) Lambda 直接実行 (CLI)
Durable Function は **API Gateway イベント形式**でも、**素の JSON** でも受け取れます。

```bash
aws lambda invoke \
  --function-name "$DURABLE_FUNCTION_NAME" \
  --payload '{"prompt":"日本語で一言ください","metadata":{"userId":"cli"}}' \
  out.json
cat out.json
```
`DURABLE_FUNCTION_NAME` は CloudFormation の `DurableFunction` リソース名を使ってください。

### レスポンス形式
```json
{
  "status": "ok",
  "result": {
    "response": { "... Azure OpenAI response ..." },
    "metadata": { "callbackId": "..." }
  }
}
```

## Webhook 署名仕様
- `Webhook-ID`
- `Webhook-Timestamp`
- `Webhook-Signature`

署名検証は OpenAI SDK の `webhooks.unwrap()` に任せています。Webhook secret は SSM から取得します。
（`OPENAI_WEBHOOK_SECRET_PARAM` が Lambda 環境変数として自動設定されます）

## 注意点
- API Gateway から Durable Function を直接呼ぶ場合、Callback が遅いとタイムアウトします。
  長時間処理にする場合は **非同期起動**にするか別の受付方式を用意してください。
- 同期呼び出しの場合、`DURABLE_EXECUTION_TIMEOUT` は **15分(900秒)以内**にしてください。
- `createCallback` の待ち時間は `src/durable/index.ts` の `timeout` に依存します。
- `/invoke` は API Key 必須です。レート制限は `rateLimit=5rps, burst=10, 1000/day` を設定しています。
- Webhook 受信側は **冪等化**してください（Azure 側で再送が入る場合があります）。
- 本サンプルは **responses.create の background モード**を使います。Webhook はこの時のみ送信されます。
- デプロイ時に Webhook 作成が失敗する場合は `WebhookProvisionerFunction` のログを確認してください。
- `DurableFunction` には `lambda:ManageDurableState` などの権限が必要です。
- ツール呼び出しの無限ループを避けるため `MAX_TOOL_STEPS` を超えたら失敗扱いにします。

## ファイル構成
- `bin/durable-lambda-gpt.ts` : CDK エントリ
- `lib/durable-lambda-gpt-stack.ts` : CDK スタック
- `src/durable/index.ts` : Durable Function 本体 (createCallback)
- `src/worker/index.ts` : Azure OpenAI responses.create (background)
- `src/webhook/index.ts` : Azure Webhook 署名検証 + Durable callback
- `src/provisioner/index.ts` : Azure Webhook の作成/削除 (CDK Custom Resource)
