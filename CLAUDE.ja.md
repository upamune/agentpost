# agentpost

[English](CLAUDE.md) | [日本語](CLAUDE.ja.md)

AIエージェントに独自ドメインのランダムなメールアドレスを発行し、Cloudflareで送受信するAPI・CLI・MCPサーバー。

- 文書・コメント・エージェント向けの指示は英語を既定にし、保守する文書には日本語版の`*.ja.md`と相互リンクを用意する。
- ツールはmiseで管理する。`mise run format|lint|typecheck|test|build|ci`。依存取得は`mise exec -- bun install --frozen-lockfile`。
- ActionsはpinactでSHA固定する。タスクは`mise exec -- backlog task add|list|show|move <id> done`で管理する。
- 今回はWorkersのAPI/MCPであり、Web UIやTanStack Startを導入する前提ではない。
- CLIは`mise exec -- bun run cli --help`。MCPや通知を変更するときは[MCPとEventsの契約](docs/mcp-events.ja.md)を読み、MCP本体の確定仕様とEventsドラフトの参照版を分けて検証する。
- エージェント向けの導入や配布を変更するときは[INSTALL.md](INSTALL.ja.md)と`skills/agentpost/`を更新する。配布用スキルは、インストール先からソースcheckoutの相対パスを前提にしない。
- メール処理・送信状態・障害復旧を変更する場合は[運用設計](docs/operations.ja.md)を読む。原文の永続化と送信の条件付きclaimを維持する。
- Cloudflare Email SendingはBeta。結果不明の送信を自動再送しない。キュー投入やAPI受理を配達完了として扱わない。
- [導入手順](docs/deploy.ja.md)に従って設定する。ドメイン、認証、実送受信が揃うまでは本番稼働済みと報告しない。
- ローカルテスト、dry-runビルド、Wranglerローカル環境への疎通は実行してよい。実メールを送るテストは宛先の指定を受けてから行う。

送信・無効化・復旧を変更したら`.agents/skills/verify-outbound-safety/SKILL.md`、受信原文・索引修復・解析の永続化順序を変更したら`.agents/skills/verify-inbound-recovery/SKILL.md`に従う。検証は`mise run verify`、通常検査と合わせる場合は`mise run ci`。
