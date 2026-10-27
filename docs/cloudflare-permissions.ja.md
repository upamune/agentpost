# Cloudflareの権限

[English](cloudflare-permissions.md) | [日本語](cloudflare-permissions.ja.md)

デプロイ用・エージェント用・Worker実行時の資格情報を分離します。R2を非公開にすれば匿名アクセスを防げますが、別プロジェクトのアカウント全体に有効なR2トークンや、侵害されたCloudflare管理者からは保護できません。

## 資格情報の境界

| 資格情報                   | 必要な権限                                            | 渡さない場所・権限                                           |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| inboxトークン              | 有効な1つのinboxでの閲覧・送信                        | Cloudflare管理権限                                           |
| Agentpost管理者トークン    | inbox・アプリ設定の管理                               | 通常のエージェントセッション、Cloudflare管理権限             |
| Worker送信用トークン       | 対象アカウントのEmail Sending Write                   | DNS・D1・R2・Queues・Workerデプロイ権限                      |
| 任意のWorker診断用トークン | 対象アカウントのEmail Sending Read                    | 送信・DNS変更・ストレージ管理権限                            |
| 通常デプロイ用トークン     | 既存のAgentpost WorkerだけのIndividual Workers Editor | 他のWorker、D1・R2・Queuesへの直接アクセス、トークン管理権限 |
| 初期構築・保守用資格情報   | その保守作業に必要な追加権限のみ                      | Worker Secrets、エージェント、通常デプロイの環境             |

WorkerはバインディングでD1・R2・Queueを使い、CloudflareのストレージAPIトークンを受け取りません。ただし接続されたDBやバケット内では、inbox間の分離をAgentpostの認可・検索条件で実現しています。Cloudflareの行単位・オブジェクト単位のIAMによる分離ではありません。Worker Editorはバインディングを使うコードを変更できます。デプロイ権限はそのWorkerのメール・アプリの秘密値に対する権限として扱います。ストレージAPIが直接拒否されても、Workerコード経由で同じデータにアクセスできない証明にはなりません。

## 通常デプロイの権限を限定する

初期構築後、**Manage account → Account API tokens**でアカウント所有のAPIトークンを作成します。

1. カスタムポリシーの範囲を**Specified Workers**にする。
2. 既存のAgentpost Workerだけを選び、**Individual Workers → Editor**を付与する。Adminや旧来のアカウント全体に有効なテンプレートは選ばない。
3. デプロイ頻度に応じた期限を設定する。例は90日。更新日を非公開で記録する。デプロイ用トークンが期限切れになっても、稼働中Workerのメール処理は停止しない。
4. 秘密管理サービスか、Git対象外・所有者だけが読めるファイルへ保存する。デプロイするプロセスにだけ`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`を渡す。これはWranglerが定義する名前であり、Agentpostのアプリ設定は引き続き`AGENTPOST_`を使う。

`bun run deploy`は両方のWrangler環境変数を要求し、未設定ならデプロイ前に失敗します。トークン文字列から実際のポリシーは判別できません。明示したトークンでも権限が広ければ、その権限は残ります。資格情報は`.dev.vars`・Worker Secrets・CLI/MCP設定・pull requestのCI・全テストやビルドに継承されるプロジェクト共通環境へ入れないでください。

Wranglerの`login`によるOAuthは、現在、細粒度の認可に対応していません。共有OAuthは必要な初期構築・保守を監督下で実行するときに限定するか、管理用プロファイルを分けます。通常のデプロイは専用トークンの未設定・期限切れで失敗させ、共有ログインへ暗黙に切り替えない構成にします。

### デプロイコマンドと保守作業

Worker単位のEditorは既存Workerのコード・バージョン・デプロイを更新できます。ストレージへの直接アクセス権限は含みません。現在、Custom DomainsはWorker単位のロールに対応していません。ルート・ドメイン変更、Queueコンシューマーやリソースの管理、DBマイグレーションには別権限が必要になる場合があります。一括コマンドを通すためだけに通常トークンの権限を広げないでください。

既存環境でコードだけを更新する場合は、確認済みの設定で`wrangler versions upload`を使い、返されたバージョンを確認してから`wrangler versions deploy VERSION_ID@100%`で反映します。必要なマイグレーション・バインディング・コンシューマーの変更と確認は、別の保守用資格情報で反映前に完了してください。versionsによるデプロイですべてのトリガー・リソース設定が反映されるわけではありません。ローカルのdry runやバージョン情報の取得だけでは、そのトークンで実アップロード・デプロイできるとは確認できません。

更新・復旧は[デプロイ](deploy.ja.md)・[運用](operations.ja.md)に従います。古い設定で新設バインディングを上書きしたり、マイグレーション前のDBに新コードを反映したりしないでください。

## 同じアカウントの他の資格情報も棚卸しする

**Account API tokensとMy Profile → API Tokensの両方**を確認します。Workers Buildsが自動生成した資格情報や、R2専用トークンも対象です。他プロジェクトの名前が付いたトークンでも、権限がそのプロジェクトに限定されているとは限りません。

- **Workers:** アカウント全体の旧script編集権限を、パイプラインが実際に使うWorkerだけのEditorへ置き換える。ビルドトリガーとリポジトリを確認してから交換・廃止する。デプロイ担当者は引き続き信頼するアプリ管理者として扱う。
- **R2:** アカウント全体のStorage Read/Writeは非公開バケットにもアクセスできる。オブジェクト操作は対象バケットだけのObject Read/WriteとS3互換APIを優先する。バケット限定のオブジェクト権限はCloudflare REST API・Wranglerのオブジェクト操作では使えない。利用元を移行してから絞らなければアップロードが壊れる。
- **D1:** D1 ReadにはSQL実行が含まれ、メールのメタデータも読める。無関係なアカウント全体のD1権限を避け、マイグレーションは別の管理用資格情報で行う。実際のアカウントポリシーが対応し強制していると確認できるまで、DB単位で分離できているとは説明しない。
- **Queues:** 生産・消費バインディングに加え、API権限も確認する。HTTPでの投入・pullには管理APIトークンが必要であり、非公開Queueの名前だけでそのトークンを制限できるわけではない。
- **Global API key・ユーザーセッション・OAuth:** これらも管理経路となる。保持者を絞り、Cloudflareアカウントを強い認証で保護し、アカウントメンバーを確認する。1つのプロジェクトトークンを絞っても他の管理経路は失効しない。

利用元を置き換えてから有効なトークンを失効させます。依存先が不明なら非公開で記録し、名前や最終利用日の空欄だけを根拠に削除しません。他アプリのアカウント全体の資格情報やデプロイ担当者が侵害されても分離する必要がある場合は、Cloudflareアカウントを分けます。新しいトークンを1つ作るだけでは、その境界を実現できません。

## メールを閲覧・送信せずに検証する

新トークンでAgentpostのバージョン・デプロイ情報が取得でき、別の既存Workerの設定は拒否されることを確認します。D1メタデータ・R2バケット情報・Queueメタデータ・アカウントトークン一覧への直接アクセスも拒否されることを確認します。別の正当な管理用資格情報で存在を確認したIDを使います。存在しないリソースや任意の404は分離の証拠になりません。出力はHTTPステータスとポリシーの要約だけにし、Bearer値やメール内容は表示しません。データ削除・Queue投入・メール行のSQL検索・他Workerの変更による権限テストは行いません。

別途、R2の`r2.dev`無効化と公開カスタムドメインの不在を**両方**確認し、API・MCPが匿名アクセスを拒否することを調べます。バケット直下の一覧が見えないことだけでは、オブジェクトURLが非公開であると証明できません。これらは観測したアクセス境界の確認であり、アプリに脆弱性が一切ない証明ではありません。

公式資料: [Workersのロール・リソース範囲](https://developers.cloudflare.com/workers/authorization/workers/)、[Wranglerの細粒度認証](https://developers.cloudflare.com/workers/authorization/)、[R2トークン権限](https://developers.cloudflare.com/r2/api/tokens/)、[R2の公開設定](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[versionsによるデプロイ](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)、[QueueのHTTPコンシューマー](https://developers.cloudflare.com/queues/configuration/pull-consumers/)。
