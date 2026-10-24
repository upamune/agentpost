# agentpost

AIエージェントに独自ドメインのランダムなメールアドレスを発行し、Cloudflareで送受信するAPI・CLI・MCPサーバー。

- ツールはmiseで管理する。`mise run format|lint|typecheck|test|build|ci`。依存取得は`mise exec -- bun install --frozen-lockfile`。
- ActionsはpinactでSHA固定する。タスクは`mise exec -- backlog task add|list|show|move <id> done`で管理する。
- 今回はWorkersのAPI/MCPであり、Web UIやTanStack Startを導入する前提ではない。
- CLIは`mise exec -- bun run cli --help`。MCPや通知を変更するときは[MCPとEventsの契約](docs/mcp-events.md)を読み、MCP本体の確定仕様とEventsドラフトの参照版を分けて検証する。
- メール処理・送信状態・障害復旧を変更する場合は[運用設計](docs/operations.md)を読む。原文の永続化と送信の条件付きclaimを維持する。
- Cloudflare Email SendingはBeta。結果不明の送信を自動再送しない。キュー投入やAPI受理を配達完了として扱わない。
- [導入手順](docs/deploy.md)に従って設定する。ドメイン、認証、実送受信が揃うまでは本番稼働済みと報告しない。
- ローカルテスト、dry-runビルド、Wranglerローカル環境への疎通は実行してよい。実メールを送るテストは宛先の指定を受けてから行う。
