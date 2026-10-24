# Go の雛形

品質ツールは **goimports → gofumpt（format）/ go vet（lint）/ go fix（modernize）**。Go 1.26 以降 `go fix` が modernize スイートを内蔵しているので、別途 modernize コマンドは入れない。

## mise.toml

バージョンは書く前に `mise ls-remote go` / `mise ls-remote gofumpt` 等で確認し、マイナーまで固定する（`latest` 禁止）。goimports は registry に無いので go backend で書く。

```toml
[tools]
go = "1.27"
gofumpt = "0.11"
"go:golang.org/x/tools/cmd/goimports" = "0.49.0"
pinact = "4"
"npm:backlog" = "1.4"

[tasks.format]
description = "goimports + gofumpt + go fix"
run = ["goimports -w .", "gofumpt -l -w .", "go fix ./..."]

[tasks."format:check"]
description = "Format check (diff があれば失敗)"
run = [
  "test -z \"$(goimports -l .)\" || { goimports -l .; exit 1; }",
  "test -z \"$(gofumpt -l .)\" || { gofumpt -l .; exit 1; }",
  "go fix -diff ./...",
]

[tasks.lint]
description = "go vet"
run = "go vet ./..."

[tasks.test]
description = "Test"
run = "go test -race ./..."

[tasks.ci]
depends = ["format:check", "lint", "test"]
```

`go:` backend は `go install` を実行する（`go` が先に入っている必要があるので `[tools]` の順序はそのまま）。gofumpt は Go 1.26 以上を要求する。

golangci-lint を足したい場合だけ `golangci-lint = "2.13"` を追加し、`lint` タスクを `["go vet ./...", "golangci-lint run"]` にする。`.golangci.yml` は `version: "2"`、`formatters: enable: [gofumpt, goimports]`。

## go.mod

`go mod init <module path>` で作る。module path は指定済みの値、なければ remote を使う。公開先が推定できない場合だけ確認する。`go` ディレクティブは `mise.toml` の Go と同じマイナー（例 `go 1.27`）。

## 最小ソース

```
cmd/<project>/main.go   # CLI やサーバーならこちら
main.go                 # 単一バイナリの小さなツールならルート直置きでもよい
<pkg>/<pkg>.go
<pkg>/<pkg>_test.go
```

標準 `testing` で最小実装の振る舞いを確認する。ケース数は固定せず、`mise run ci` の test タスクで検証する。

## .editorconfig

```ini
root = true

[*]
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.go]
indent_style = tab
```

## CI

`references/github-actions.md` の雛形をそのまま使う。`jdx/mise-action` が `go` / `gofumpt` / `goimports` を入れるので `actions/setup-go` は不要。Go のモジュールキャッシュが欲しければ `actions/cache@v6` で `~/go/pkg/mod` と `~/.cache/go-build` を `hashFiles('**/go.sum')` キーでキャッシュする。

## 確認

`mise install && mise run ci` が通ること。`go fix -diff ./...` が何も出さないこと（出たら `mise run format` で適用してからコミット）。
