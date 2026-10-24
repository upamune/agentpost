---
name: init-project
description: 新しい Go プロジェクトまたは TypeScript Web アプリを、upamune の標準構成で初期化する。
disable-model-invocation: true
---

# Init Project

新しいリポジトリを、ローカル起動と CI の検証ができる骨組みにする。指定済みの言語・名前・説明・module path は引き継ぐ。不足分はディレクトリや remote から推定し、言語や公開 module path など結果を左右する情報が決まらない場合だけ聞く。

## 標準構成

- 共通: mise でツール管理、確認した安定版をマイナー以上で固定、Actions の `uses:` は pinact で SHA 固定、backlog でタスク管理。
- Go: goimports / gofumpt / go vet / go fix と標準 testing。
- TypeScript Web: Bun + React / TanStack Start、Tailwind / shadcn/ui、Effect、Ultracite（Oxlint / Oxfmt）+ `@shadcn/lint` + knip + fallow。具体的な互換性制約は TypeScript reference に置く。

これらは新規作成時の既定。ユーザーが指定した構成や既存の設定を置き換えない。既存ファイルには必要な差分を統合し、未確定の方針変更や破壊的な置換だけ確認する。

## 必要な資料

- Go の雛形: [references/go.md](references/go.md)
- TypeScript Web の雛形: [references/typescript.md](references/typescript.md)
- CI を作るとき: [references/github-actions.md](references/github-actions.md)
- backlog、選択したスキル、README / agent 文書の初期化: [references/setup.md](references/setup.md)
- `.gitignore` の初期値: [references/gitignore.txt](references/gitignore.txt)。既存ファイルには不足分だけ統合する。

選んだ言語の reference だけ読む。雛形の版数は例なので、導入時に公式リリースや `mise ls-remote` で互換性を確認する。

## 完了まで進める

依存を入れ、最小実装と意味のある動作確認を用意し、README から起動できるところまで仕上げる。言語ごとの `mise run ci` と `pinact run -check` を通し、Web アプリは起動した画面・疎通と本番配信を確認する。失敗は修正し、影響する検査を再実行する。変更していない結果を工程の節目だけで取り直さない。

ローカルの初期化が済んだら成果物・起動方法・検証結果を報告する。commit / push / リポジトリ作成が既に依頼されていれば続ける。リモート公開やアカウント設定は、そのスキルを呼んだことだけで許可されたと扱わない。
