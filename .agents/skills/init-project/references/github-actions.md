# GitHub Actions の規約

CI は **format / lint / test** の 3 ジョブを最低限とする。TypeScript は **typecheck** と **build** も独立ジョブにする。`uses:` はすべて pinact で commit SHA に pin する。

## pinact

- `mise.toml` の `[tools]` に `pinact = "4"` を入れる（`mise ls-remote pinact` で最新を確認して書く）
- ワークフローを書き終えたら `pinact run` を実行し、`uses: actions/checkout@v7` が `uses: actions/checkout@<sha> # v7.0.1` に書き換わったことを確認する
- CI 側にも検証ジョブを置く（pin 漏れで落ちる）:

```yaml
  pinact:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: suzuki-shunsuke/pinact-action@v3.0.0
        with:
          fix: "false"
```

- `suzuki-shunsuke/pinact-action` には `v3` のようなメジャータグが無い。full semver（`v3.0.0`）で書く
- 更新は `pinact run -update`。`pinact run -check` で検証のみ
- 設定ファイルは不要（必要なら `pinact init` で `.pinact.yaml`）

## Action の選び方

**必ず各リポジトリの Releases を見て最新メジャーを確認してから書く**（下表は 2026-08-23 時点の確認結果。古くなっていたら表ではなく Releases を信じる）。

| Action | 最新メジャー | full semver | 用途 |
| --- | --- | --- | --- |
| actions/checkout | v7 | v7.0.1 | `persist-credentials: false` を付ける |
| jdx/mise-action | v4 | v4.2.5 | `mise.toml` を読んでツール一式を入れる。**これを使えば setup-go / setup-bun は不要** |
| actions/setup-go | v7 | v7.0.0 | `go-version-file: go.mod` |
| oven-sh/setup-bun | v2 | v2.2.0 | `bun-version-file: .bun-version` |
| actions/setup-node | v7 | v7.0.0 | Node が直接要るときだけ |
| golangci/golangci-lint-action | v9 | v9.3.0 | golangci-lint を使う場合。setup-go が前提 |
| actions/cache | v6 | v6.1.0 | 追加キャッシュが要るときだけ |

- ランナーは `ubuntu-24.04`（`ubuntu-latest` と同じだが明示する）
- `permissions: contents: read` をワークフロー直下に置く
- `concurrency` で同一 ref の古い実行をキャンセルする

## ツールの入れ方は mise 経由に統一する

`jdx/mise-action` が `mise.toml` をそのまま読むので、ローカルと CI で同じバージョンが動く。言語ランタイムも `mise.toml` で pin しているなら setup-go / setup-bun は使わない。

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  format:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: jdx/mise-action@v4
      - run: mise run format:check
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: jdx/mise-action@v4
      - run: mise run lint
  # TypeScript の場合だけ typecheck と build を追加する。Go では省略する。
  # TypeScript は各ジョブで mise-action の直後に `bun install --frozen-lockfile` を挟む
  # （lint の knip / fallow も node_modules のバイナリを使う）。
  # TypeScript の lint ジョブだけ checkout に fetch-depth: 0 を付ける（fallow audit 用）。Go では付けない。
  typecheck:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: jdx/mise-action@v4
      - run: bun install --frozen-lockfile
      - run: mise run typecheck
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: jdx/mise-action@v4
      - run: bun install --frozen-lockfile
      - run: mise run build
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: jdx/mise-action@v4
      - run: mise run test
```

`mise run format:check` 等は `mise.toml` の `[tasks]` に定義する（言語別 reference を参照）。ジョブ名は `format` / `lint` / `test`、TypeScript では `typecheck` / `build` に揃える（ブランチ保護の required checks で使う）。

TypeScript の lint ジョブは次の形にする。`mise run lint` が oxlint、knip、`fallow audit` を回す。`fallow audit` は PR の base との差分を見るので `fetch-depth: 0` が要る。公式 Action `fallow-rs/fallow` は使わず、`package.json` の pin と `bun run fallow` に揃える。

```yaml
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
          fetch-depth: 0  # TypeScript: fallow audit の PR 差分ゲート用
      - uses: jdx/mise-action@v4
      - run: bun install --frozen-lockfile
      - run: mise run lint
```

Go の lint には fallow も `fetch-depth: 0` も不要。main への push でも TypeScript は同じ `mise run lint` を回す（`fallow audit` の base 自動検出は TypeScript reference を参照）。

## 書いたあとの確認

1. `pinact run` → 全 `uses:` が SHA + `# vX.Y.Z` コメントになっている
2. `actionlint` があれば `actionlint`（mise に `actionlint` あり）
3. `gh workflow list` でワークフローが認識されている（push 後）
