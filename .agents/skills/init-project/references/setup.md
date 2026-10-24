# 共通の初期セットアップ

言語の骨組みに加えて backlog と開発文書を用意する。既存プロジェクトでは使っている仕組みを保ち、依頼された不足分を足す。

## backlog

[osmove/backlog](https://github.com/osmove/backlog) を `mise.toml` の `"npm:backlog"` に確認した版数で登録し、`backlog init --name <project>` を実行する。

`.backlog/` のコミット対象は生成される `.backlog/.gitignore` に従う。要求から実作業が決まっていれば `backlog task add --title "<次の作業>" --priority P2` で記録する。件数を満たすための空タスクは作らない。

## プロジェクト用スキル

ユーザーが指定したもの、または今回の構成に必要なものだけを project スコープに入れる。追加のスキルが不要なら導入を省略する。全件導入は全件が指定された場合に限る。

候補確認と導入:

```bash
bunx skills@latest add upamune/skills --list
bunx skills@latest add upamune/skills -a claude-code -a codex -y --skill <name>
```

`.agents/skills/`、`.claude/skills/`、`skills-lock.json` が生成されたらコミット対象に含め、`bunx skills ls` で選択内容を確認する。グローバル環境への導入は別の依頼として扱う。

## README と agent 文書

README は一行説明、前提（mise）、依存の導入、起動・使い方、CI と backlog のコマンドをまとめる。Web アプリは開発用と本番用の起動方法を区別する。

`CLAUDE.md` は以下のうち実際に判断を変える情報だけを短く書く。

- 主要コマンドとプロジェクト固有の制約（mise、pinact、backlog）。存在するタスクだけ列挙する。
- サービス境界、スキーマ、デプロイなど、作業内容に応じて読む資料へのリンク。全資料の常時読込や網羅的な repo map を要求しない。
- TypeScript では採用した構成に合わせ、生成 UI・route tree の扱い、Effect を実行する境界などを残す。詳細なライブラリ一覧や導入手順は README / 専用文書に置く。
- 検証は変更への影響で選び、必要な修正まで進める。ローカル検査のデータと接続先が分かる場合は、再確認なしで実行できる範囲を具体的に記す。本番アクセスがないと未確認のまま断定しない。

新規の `AGENTS.md` は `CLAUDE.md` への symlink にする。既存の agent 文書は独自の内容を保って更新する。
