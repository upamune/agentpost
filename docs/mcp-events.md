# MCPとEventsの対応範囲

## 参照した仕様

- MCP本体: [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)。2026-10-24に`specification/latest`の指す版を確認した。
- TypeScript SDK: `@modelcontextprotocol/server` / `@modelcontextprotocol/client`の2.4.0を固定。
- MCP Events: [Triggers & Events WGのDesign Sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/d5316be214be2e76e51462069c1d67e00a5a7619/docs/design-sketch-proposal.md)、参照コミット`d5316be214be2e76e51462069c1d67e00a5a7619`。

**EventsはMCP本体の確定仕様ではなく、作業部会のドラフト。** 本体の仕様番号とは分けて追跡する。ドラフト変更時に差分を確認して互換テストを更新する。対応クライアントで利用し、任意のMCPホストがイベント購読を扱えるとは想定しない。

## トランスポート

- stdio: `mise exec -- bun run cli mcp`。SDKの`serveStdio`を使い、最新プロトコルの要求と、従来の初期化ハンドシェイクの両方を受ける。
- Streamable HTTP: Workerの`https://<worker>/mcp`。SDKの`createMcpHandler`を使い、要求ごとに状態を完結させる。2025系クライアントにはSDKのstateless fallbackを使う。
- イベント履歴・権限はD1に保持し、Workerプロセス内のメモリやMCPセッションには依存しない。

HTTPは各要求に`Authorization: Bearer <admin-or-inbox-token>`を付ける。Originがある場合はWorker自身のoriginと一致する要求のみ受け入れる。APIトークンをクエリに入れない。
HTTPS・Origin・キャッシュ禁止・HTTPレート制限はAPIとMCP共通のWorker入口で適用する。認証失敗や制限超過の応答もキャッシュさせない。レート制限の429では`Retry-After`に従う。MCPから呼ぶ新規送信・返信にも受信箱単位の送信制限が適用される。

現在の認証は事前発行したBearerトークン方式。OAuthの認可画面や動的クライアント登録は実装していない。OAuthを必須にするホストとの接続は別途対応が必要で、ChatGPTなど特定ホストへの接続はまだ実証していない。

SDK v2のクライアントは既定では従来プロトコルを使う。最新版を使う場合は明示的にネゴシエーションする:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "my-agent", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", process.env.AGENTPOST_API_URL!), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.AGENTPOST_API_TOKEN}` } },
  }),
);
```

## Events

| 名前                          | 内容                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `message.received`            | 原文の保存と解析が完了した。`inbox_id`と`message_id`を通知する                           |
| `message.send_status_changed` | 送信が`accepted`・`failed`・`unknown`になった。`inbox_id`、`send_id`、`status`を通知する |

通知には本文・添付・トークンを入れない。内容は`get_message`や`get_send_status`で必要に応じて取得する。`accepted`はCloudflareでの受理であり、配達完了ではない。

状態変更とイベントのINSERTはD1のトリガーで同じトランザクションに含める。解析の再実行は同じ`eventId`を再発行しない。イベントは現在は無期限保存で、安易な削除・保持期間の短縮はリプレイ保証を変える。

### Discoveryとpoll

`events/list`は名前、入力・ペイロードのJSON Schema、`delivery: ["poll", "push"]`を返す。イベント型の一覧は静的なので`listChanged`はfalse。Webhookは広告も実装もしていない。

`events/poll`のparams:

```json
{
  "name": "message.received",
  "arguments": { "inbox_id": "YOUR_INBOX_UUID" },
  "cursor": null,
  "maxEvents": 25,
  "maxAgeMs": 300000
}
```

これはparams部分の例。最新版のJSON-RPC `_meta`エンベロープはSDKが付与する。`cursor`の省略またはnullは「今から」で、既存履歴を全件返さない。応答の`cursor`を次回に渡すと、以後のイベントを順序通りに取得できる。

- `maxEvents`: 1〜100。`hasMore: true`なら、返されたカーソルで直ちに次のページを取得する。
- `maxAgeMs`: 再取得する履歴の時間範囲。古い履歴を省いた場合は`truncated: true`。受信箱の一覧・本文を再取得して必要な状態を補う。
- `nextPollMs`: 通常は5000。モデルにツールを繰り返し呼ばせず、クライアント側のイベントループで処理する。
- カーソルは署名付きで、権限・イベント名・受信箱に紐づく。別の購読や別のトークンに使うと拒否される。

イベント名や受信箱を変える場合、トークンを変更した場合、管理者署名キーを更新した場合は、新しい購読としてカーソルを取り直す。勝手にnullへ戻して継続せず、購読をやり直す理由と履歴の空白を確認する。

### Push

`events/stream`はpollと同じparamsを受け、要求を開いたまま以下を送る。

- `notifications/events/active`: 購読開始位置と`truncated`。
- `notifications/events/event`: `eventId`、名前、時刻、メタデータ、イベント直後のカーソル。
- `notifications/events/heartbeat`: 通常15秒ごと。カーソルも更新する。
- `notifications/events/error`: 一時的な上流障害。位置を進めず、バックオフ後に再試行する。
- 内部のイベント取得が429を返した場合は`Retry-After`を尊重して待つ。待機中もキャンセルで停止でき、保存したカーソルを進めない。
- `notifications/events/terminated`: トークンの無効化などで権限が失われた。購読を終了する。

通知の`params._meta["io.modelcontextprotocol/subscriptionId"]`で元のJSON-RPC要求IDに紐付ける。HTTPでは要求のSSEストリーム、stdioでは標準出力を使う。HTTPの切断・stdioのキャンセルではSDKのAbortSignalからループと待機を止める。

アプリケーションの履歴を読む内部処理は最大約5秒おきのpollで、MCPクライアントへの配送はpush通知。完全な即時配送ではない。接続中のDB/API負荷を見ながら間隔を調整する。

切断後は最後に処理済みのカーソルから再開する。SSEの`Last-Event-ID`に依存しない。配信はat-least-onceで、受信側は`eventId`で重複を除去する。保存済みデータを復元してカーソルがDBの先に進んでいた場合は`truncated`を返す。ストレージ復元・イベント履歴の手動削除後は、受信箱の状態とも照合する。

## CLIで監視

```sh
mise exec -- bun run cli events list
mise exec -- bun run cli events poll --inbox YOUR_INBOX_UUID
mise exec -- bun run cli events watch --inbox YOUR_INBOX_UUID \
  --cursor-file .agentpost/received.cursor.json
```

watchは通知をNDJSONで標準出力に書き、書き出し完了後にカーソルファイルを一時ファイルからrenameして保存する。再起動時はその位置から再開する。出力直後・保存前のクラッシュでは同じイベントが再出力され得るので、下流でも`eventId`で重複を除去する。

エラーは標準エラーに出し、401/403や壊れたカーソルは自動的に読み飛ばさない。SIGINT/SIGTERMで終了する。カーソルファイルは同じ購読の一つのプロセスで管理し、複数のwatchプロセスから同じファイルへ書かない。
