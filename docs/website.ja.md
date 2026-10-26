# プロジェクトのWebサイト

[English](website.md) | [日本語](website.ja.md)

公開ページは[upamune.github.io/agentpost](https://upamune.github.io/agentpost/)でホストし、[日本語版](https://upamune.github.io/agentpost/ja/)も用意しています。製品の説明と操作例を示す静的サイトで、認証付きのWorker API/MCPサービスとは別です。認証情報を入力したり、メールを送信したりする機能はありません。

`website/template.html`、`website/content/en.json`、`website/content/ja.json`、`website/site.css`、`website/site.js`を編集します。ビルドでは明示的に選んだ公開ブランド素材とWebページだけを出力し、リポジトリ全体、Worker設定、ローカルの認証情報はアップロードしません。第三者のスクリプト、Webフォント、解析、実行時依存、API呼び出しは使用しません。両言語とも静的HTMLを生成し、小さなローカルスクリプトでタブとコピー機能を加えます。動きの抑制設定とキーボードでのタブ操作に対応します。

`mise run site:build`でビルドします。`dist/site`をローカルの静的HTTPサーバーで配信し、英語・日本語、モバイル表示、操作例、コピー、キーボードフォーカスを確認します。翻訳の差し込み漏れ、ローカル素材の欠落、セクションへのリンク切れはビルドエラーになります。CSS/JSのファイル名にはハッシュを付け、canonical/alternateメタデータ、robots.txt、サイトマップも生成します。公開URLは`scripts/build-site.ts`で定義します。フォークして公開する場合は、プロジェクトへのリンクと合わせて更新してください。

`.github/workflows/pages.yml`は関連するPRでビルドを確認し、関連するmainへの変更後に公開します。GitHub Pagesの公開元は**GitHub Actions**に設定します。ビルドはリポジトリの読み取り権限だけを持ち、main専用のデプロイジョブにPages/OIDC権限と`github-pages`環境を設定します。ActionsはSHA固定です。PRのビルドは公開せず、`dist/site`だけがPagesの成果物になります。

マージ後はPagesのデプロイ成功に加え、英語・日本語の公開URLと素材をHTTPSで確認してから公開完了と報告します。Webサイトの公開はメール基盤のデプロイや動作検証を意味しません。CLIの操作例にはAPI URLと受信箱の認証情報の設定が必要で、IDはプレースホルダーです。送信待ちやAPI受理は配信完了ではありません。
