# ドメイン設定の診断

[English](domain-diagnostics.md) | [日本語](domain-diagnostics.ja.md)

ドメイン登録後、DNS変更後、メール認証の問題が疑われるときに実行する読み取り専用の診断です。対象は設定済みの `AGENTPOST_EMAIL_DOMAIN` に固定され、呼び出し側から別のドメインは選べません。管理者トークンかOAuthの `admin` 権限が必要です。受信箱トークンとOAuthの `agent` 権限では実行できません。

```sh
mise exec -- bun run cli domain check
# デプロイ前の確認などで警告も失敗とする場合:
mise exec -- bun run cli domain check --strict
```

`GET /v1/domain/check` とMCPの `check_domain`（引数 `{}`）も同じレポートを返します。DNSの変更やメール送信は行いません。送信の受付、キュー、`/v1/health` の挙動にも影響しません。必要なときに実行する機能であり、自動実行のスケジュールは追加しません。

## 確認する項目

| 項目                           | 内容                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spf`                          | 送信用SPFが1件で、Cloudflareのincludeと順序が適切か。標準構成はpass、独自ポリシーは追加の評価が必要です。                                                                                                      |
| `dkim`                         | 送信用selectorに失効していないRSA/SHA-256公開鍵が1件あり、実際に読み込めるか。1024ビット未満はfail、2048ビット未満やテストモードはwarningです。                                                                |
| `dmarc`                        | Fromドメインに明示されたポリシー、タグの重複・不正、強制適用と監視・テスト・旧仕様の部分適用を区別します。導入中の`p=none`は有効な設定です。                                                                   |
| `dmarc_reports`                | 集計レポートのmailto構文の簡易確認。レポート配送や外部宛先の認可までは検証しません。                                                                                                                           |
| `alignment` / `dkim_alignment` | strict alignmentとReturn-Path・ワイルドカードの署名ドメインが一致しない場合の警告。実際のalignment確認には受信メールが必要です。                                                                               |
| `bounce_mx`                    | Return-PathドメインにCloudflareのバウンス処理用MXがあるか。                                                                                                                                                    |
| `routing_mx`                   | アドレスのドメインに受信用MXがあるか。送信用とは別に確認します。他社MXとの共存はwarning、Cloudflare MXの不足はこのCloudflare専用構成ではfailです。                                                             |
| `cloudflare_sending`           | 任意のAPI確認。設定した送信ドメインが対象をカバーし、Email Sendingが有効か。有効という値だけでDNS検証・利用資格・配送は証明できません。                                                                        |
| `cloudflare_dns`               | 公開された送信用SPF・DKIM・MXとCloudflareの期待値を照合します。形式上は正しい古いDKIM鍵も検出できます。独自のSPFやMX優先度はwarningです。独自DMARCポリシーは別途評価し、Cloudflareの例への一致を強制しません。 |

標準の送信設定はSPF・バウンスMXが `cf-bounce.DOMAIN`、DKIMが `cf-bounce._domainkey.DOMAIN` です。Email Routing用のselectorで代用できません。任意のAPI確認を設定した場合は、返されたselectorとReturn-Pathを優先します。対象をカバーするワイルドカード設定では、その基点の署名ドメインを使います。

これはCloudflareの設定診断であり、SPFやDMARCの受信側実装ではありません。SPFのinclude・redirectの再帰展開、DNS参照回数、送信IPの認可は評価しません。DMARCの親・組織ドメイン・PSD探索も行いません。明示ポリシーがない場合、有効な継承設定の可能性があるため **unknown** とします。可能なら各Fromドメインに明示し、継承は専用の評価ツールで確認してください。現行の[DMARC RFC 9989](https://www.rfc-editor.org/rfc/rfc9989.html)は旧仕様のPSLに基づく探索を変更しており、受信側の実装で結果が異なる場合があります。

## 任意のCloudflare照合

公開DNSの確認だけならCloudflare管理用の資格情報は不要です。実際の送信構成も照合する場合は、Worker varsを設定します。

```json
{
  "AGENTPOST_CF_ZONE_ID": "YOUR_32_HEX_ZONE_ID",
  "AGENTPOST_CF_SENDING_SUBDOMAIN_ID": "YOUR_32_HEX_SENDING_SUBDOMAIN_ID"
}
```

専用のSecretを登録します。

```sh
mise exec -- bun run wrangler secret put AGENTPOST_CF_DIAGNOSTICS_API_TOKEN
```

対象アカウント・ゾーンに限定し、次のGETを許可する範囲でCloudflare側の利用可能な最小権限にしてください。現在のエンドポイント資料は受け付ける権限グループを列挙していません。未記載の権限名を想定せず、使用するトークンでアクセスを確認します。

- `GET /zones/{zone_id}/email/sending/subdomains/{subdomain_id}`
- `GET /zones/{zone_id}/email/sending/subdomains/{subdomain_id}/dns`

診断はDNS編集権限を使いません。`AGENTPOST_CF_EMAIL_API_TOKEN` とは分け、送信用トークンへのフォールバックも行いません。診断のためにGlobal API Keyを渡したり、通常の送信資格情報の権限を広げたりしないでください。未設定・一部のみの設定・アクセス拒否・API形式変更・サービス障害は **unknown** とし、標準名のDNS確認は継続します。

## レポートの読み方

レポートを作成できた場合、項目にfailがあってもAPIはHTTP 200を返します。JSONの `status` と `checks` を確認してください。認証・認可やHTTP通信のエラーは通常のHTTPステータスを維持します。各項目は固定ID、状態、説明、必要に応じた修正案を持ちます。DNSの内容、上流のエラー本文、資格情報はレポートへ反映しません。

| 全体の状態 | 意味                                            | CLI終了コード      |
| ---------- | ----------------------------------------------- | ------------------ |
| `pass`     | この診断を構成する全項目が通過                  | 0                  |
| `warning`  | fail・unknownはなく、見直しが必要               | 0。`--strict`なら1 |
| `fail`     | 設定・構成の検査が少なくとも1件失敗             | 1                  |
| `unknown`  | 既知のfailはないが、少なくとも1件を確認できない | 2                  |

fail、unknown、warningの順に優先します。任意のCloudflare設定がなければ、公開DNSが通っても全体はunknownです。プロバイダー側の確認がないことを見える状態に保ちます。`checked_at` は観測時刻で、`delivery_verified` は常に `false` です。

DNSの観測点はCloudflareの公開再帰DoH resolverです。権威DNSとの一致や世界中の伝播は証明せず、正・負のキャッシュや伝播時間の影響を受けます。接続先は固定のCloudflare API・DoH HTTPS originで、redirectを拒否します。JSON本文は各256 KiB、DNS問い合わせは24件、各通信は3.5秒、全体の通信は12秒を上限とします。TXTの分割は同一RR内だけを結合し、無関係な応答で問い合わせを満たしません。形式不正や名前解決エラーはpassにしません。resolverのJSON形式はプロバイダー固有であり、非互換の変更はunknownとして表れます。

## ポリシー強化や本番利用の前に

SPFの編集やDMARCの強化の前に、既存の正規送信元を確認してください。必要なら監視とレポート確認から始め、`p=reject`への自動変更や他社レコードの自動削除は行いません。Cloudflare Email Serviceの設定と比較し、伝播後に再実行します。

DNS認証は到達性の一部です。宛先をユーザーが指定して送信を許可した上で、実際の受信メールにある信頼できる `Authentication-Results`、Return-Path、DKIM署名ドメインを確認し、SPF・DKIM・DMARCとalignmentを検証してください。送信IP、PTR、SMTP TLSはCloudflare側の証拠で確認し、独自ドメインへ推測したレコードを追加しません。評判、苦情、送信量、本文、受信側フィルタ、バウンス、抑止リストも関係します。診断の通過は配送や受信トレイへの到達を保証しません。

参考: [Cloudflareドメイン設定](https://developers.cloudflare.com/email-service/configuration/domains/)、[送信ドメインAPI](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/get/)、[期待するDNSのAPI](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/subresources/dns/methods/get/)、[DoH JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)、[Gmail送信者ガイドライン](https://support.google.com/mail/answer/81126)。
