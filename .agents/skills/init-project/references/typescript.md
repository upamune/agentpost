# TypeScript (Bun + TanStack Start) の雛形

この reference は TypeScript Web アプリの標準構成を選んだ場合の雛形。指定済みの別構成には適用しない。**React + TanStack Start** の Web アプリとして立ち上げる。ランタイム・パッケージマネージャは Bun、アプリケーション基盤は **Effect**、UI は **Tailwind CSS v4 + shadcn/ui**。Node / npm / ESLint / Prettier は入れない。

| 役割 | 採用 | 備考 |
| --- | --- | --- |
| フレームワーク | TanStack Start（React 19、Vite 8、SSR + server functions） | `@tanstack/react-start` |
| ルーティング | TanStack Router（file-based、`src/routes/`） | Start に同梱 |
| サーバ状態 | TanStack Query + `@tanstack/react-router-ssr-query` | SSR で dehydrate/hydrate |
| UI | Tailwind CSS v4 + shadcn/ui（Base UI、nova preset） | `bunx --bun shadcn add <component>` |
| アイコン | lucide-react | shadcn の既定 |
| アプリ基盤・バリデーション | Effect / Effect Schema | `Schema.standardSchemaV1` で TanStack Form にも渡せる |
| 品質 | Ultracite（Oxlint + Oxfmt、react / tanstack / vitest preset）+ @shadcn/lint（デザインシステム）+ knip + fallow + tsc + Effect TSGO | knip は未使用 export / 依存。fallow は循環・重複・複雑度・CSS drift と PR の `fallow audit` ゲート。併用し、置換しない |
| テスト | Vitest + Testing Library + jsdom | TanStack Router 公式の推奨構成 |
| Devtools | `@tanstack/react-devtools`（Router / Query panel） | 本番 HTML には出ない |
| 本番サーバ | TanStack 公式 `start-bun` example の `server.ts` を Bun で実行 | nitro 不要 |

## ライブラリ選定の原則

- **React / TanStack を第一候補にする**。同じ用途のライブラリが TanStack にあるなら他を入れない
- **TanStack に無い領域だけ探す**。まず [tanstack.com/libraries](https://tanstack.com/libraries) と TanStack CLI の add-on（`bunx @tanstack/cli create --list-add-ons`）を見て無いことを確認してから、React エコシステムで最も標準的なものを選び、選定理由を README か CLAUDE.md に一行書く
- UI コンポーネントは shadcn/ui。別の UI ライブラリを重ねない

| 用途 | 使うもの |
| --- | --- |
| ルーティング / ローダー / server functions | TanStack Start + Router |
| サーバ状態・キャッシュ | TanStack Query |
| フォーム | TanStack Form（バリデータは Effect Schema、UI は shadcn の `Field`） |
| テーブル | TanStack Table |
| 大量リストの仮想化 | TanStack Virtual |
| クライアント状態 | TanStack Store |
| debounce / throttle / rate limit | TanStack Pacer |
| クライアント DB・同期 | TanStack DB |
| UI / アイコン | shadcn/ui / lucide-react（TanStack に無い） |
| バリデーション | Effect Schema（TanStack に無い。zod は入れない） |
| テスト | Vitest + Testing Library（TanStack に無い） |

Form / Table / Virtual / Store / Pacer / DB は必要になった時点で `bun add` する。骨組みには入れない。

## 作り方の方針

公式 CLI（`bunx @tanstack/cli create`）は使わず、[Build from Scratch](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch) の手順で手書きする。CLI は依存を `latest` で書き、npm の lockfile や `.cursorrules`、zod、radix を持ち込むため、このスキルの規約（pin、Bun のみ、Effect Schema、Base UI）と噛み合わない。ファイル数は少ないので手書きの方が確実。

## mise.toml

バージョンは書く前に `mise ls-remote bun` 等で確認し、マイナーまで固定する（`latest` 禁止）。Node は入れない。Vite / Vitest / tsc はすべて Bun で動く。

```toml
[tools]
bun = "1.4"
pinact = "4"
"npm:backlog" = "1.4"

[tasks.dev]
description = "Dev server"
run = "bun run dev"

[tasks.format]
description = "Format"
run = "bun run format"

[tasks."format:check"]
description = "Format check"
run = "bun run format:check"

[tasks.lint]
description = "Lint + unused + fallow audit"
run = ["bun run lint", "bun run knip", "bun run fallow"]

[tasks.typecheck]
description = "TypeScript + Effect diagnostics"
run = "bun run typecheck"

[tasks.test]
description = "Test"
run = "bun run test"

[tasks.build]
description = "Production build"
run = "bun run build"

[tasks.ci]
depends = ["format:check", "lint", "typecheck", "test", "build"]
```

`bun run fallow` は `fallow audit`。exit 0 は pass / warn、1 は fail（ゲートに掛かる finding）、2 は設定や git の実エラー。CI では exit 1 でジョブを落とす。`|| true` で飲み込むな。

## package.json

```json
{
  "name": "<project>",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "start": "bun run server.ts",
    "format": "oxfmt",
    "format:check": "oxfmt --check",
    "lint": "oxlint --type-aware",
    "lint:fix": "ultracite fix --type-aware",
    "check": "ultracite check --type-aware",
    "fix": "ultracite fix --type-aware",
    "knip": "knip",
    "fallow": "fallow audit",
    "typecheck": "tsc --noEmit && effect-tsgo diagnostics --project tsconfig.json",
    "test": "vitest run"
  }
}
```

依存は次の順で入れる。`bun add` は caret で書き、実際の版は `bun.lock` が固定する。`bun.lock` をコミットし、`package-lock.json` が紛れ込んでいたら消す。

```bash
bun add react react-dom effect \
  @tanstack/react-start @tanstack/react-router \
  @tanstack/react-query @tanstack/react-router-ssr-query \
  @tanstack/react-devtools @tanstack/react-router-devtools @tanstack/react-query-devtools
bun add -D vite @vitejs/plugin-react typescript @types/react @types/react-dom @types/bun \
  tailwindcss @tailwindcss/vite \
  vitest @testing-library/react @testing-library/jest-dom jsdom \
  knip fallow @effect/tsgo
```

fallow の版は書く前に確認する（`latest` は書かない）。上の `bun add -D` に並べたあと、確認した版で pin する:

```bash
bun pm view fallow version
bun add -D fallow@<確認した版>
```

Devtools 3 つは `__root.tsx` から import するので `dependencies` に置く（本番ビルドには含まれない）。`@types/node` ではなく `@types/bun` を使う。

## 設定ファイル

### tsconfig.json

TypeScript 7 には `baseUrl` が無い（書くと TS5102 で落ちる）。`paths` はそのまま tsconfig の位置からの相対で解決される。`verbatimModuleSyntax` は Start の公式ドキュメントが「server bundle が client に漏れる」として無効を推奨しているので `false` にする。

```json
{
  "$schema": "./node_modules/@effect/tsgo/schema.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["vite/client", "bun"],
    "paths": { "@/*": ["./src/*"] },
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": false,
    "plugins": [{ "name": "@effect/language-service" }]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts", "server.ts"]
}
```

`plugins` が無いと `effect-tsgo diagnostics` は「Checked 0 files」で何も見ない。`@effect/language-service` パッケージ自体は TypeScript 6 以前向けなので入れない（plugin 名として書くだけ）。

### vite.config.ts

`tanstackStart()` は `viteReact()` より前に置く（公式の制約）。`@/*` の解決は Vite 8 の `resolve.tsconfigPaths` で済むので `vite-tsconfig-paths` は入れない。

```ts
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
});
```

### vitest.config.ts

`vite.config.ts` とは分ける。テストに `tanstackStart()` は要らず、React plugin と jsdom だけでよい。

```ts
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [viteReact()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`src/test/setup.ts` は 1 行:

```ts
import "@testing-library/jest-dom/vitest";
```

`bun test` は使わない。Bun のランタイムが直接ファイルを変換するので Vite plugin（JSX、CSS `?url`、tsconfig paths）が効かず、Vitest の `vi` 互換も部分的。TanStack Router 公式もテストランナーには Vitest を推奨している。

### Tailwind CSS と shadcn/ui

1. `src/styles/app.css` を作る。中身は `@import "tailwindcss";` の 1 行（shadcn init が続きを書き足す）
2. `__root.tsx` から `import appCss from "@/styles/app.css?url"` して `head.links` に `{ href: appCss, rel: "stylesheet" }` を入れる（後述）
3. shadcn の版を確認してから init する。`-y` だけでは preset の対話が残るので `-p` も明示する:

```bash
bun pm view shadcn version
bunx --bun shadcn@<確認した版> init -b base -p nova -y --no-monorepo
bunx --bun shadcn@<確認した版> add button
```

- `-b base`: Base UI を使う。2026-07 から shadcn の既定だが、非対話で確実に選ぶために書く（Radix にしたい明示的な理由があるときだけ `-b radix`）
- `-p nova`: shadcn/create の preset。コンパクトなレイアウトの標準スタイル。他の preset（vega / maia / lyra / mira / luma / sera / rhea）はユーザーが指定したときだけ
- init は `@/*` alias と `@import "tailwindcss"` を持つ CSS を検証してから `components.json`、`src/lib/utils.ts`（`export { cn } from "cn"`）、CSS の theme 変数、`@base-ui/react` / `cn` / `class-variance-authority` / `lucide-react` / `tw-animate-css` / `shadcn` / `@fontsource-variable/geist` を追加する
- 以後コンポーネントは `bunx --bun shadcn@<版> add <name>` で足す。`src/components/ui/` は手で編集しない（更新は `add --overwrite`）

### Ultracite（Oxlint + Oxfmt）

安定版を確認してから、確認した版と framework preset を明示して初期化する。依存から auto-detect もされるが、明示した方が再現性がある。

```bash
bun pm view ultracite version
bunx ultracite@<確認した版> init \
  --quiet \
  --pm bun \
  --linter oxlint \
  --type-aware \
  --js-plugins anti-slop \
  --frameworks react tanstack vitest
```

`--quiet` は agent files、editor settings、hooks、git integrations を作らず、lint / format の core config だけを非対話で生成する（このスキルが作る `CLAUDE.md` / `AGENTS.md` と競合させない）。

続けて `@shadcn/lint` を pin して入れる。[shadcn/lint](https://github.com/shadcn-ui/lint) は Tailwind デザインシステムのルールを agent が検証できるようにする Oxlint JS plugin（ESLint は入れない）:

```bash
bun pm view @shadcn/lint version
bun add -D @shadcn/lint@<確認した版>
```

`@shadcn/lint` は Oxlint 1.80 以上が必要。Ultracite が oxlint を入れるので、このスキルでは oxlint を別途 pin しない。init 後に `bun.lock` の oxlint が 1.80 未満なら、同じ手順（`bun pm view oxlint version` → `bun add -D oxlint@<確認した版>`）で上げる。

生成後、`oxlint.config.ts` に生成物の除外と `@shadcn/lint` を足す（Ultracite は `defineConfig` from `oxlint` を使う。手書きの `.oxlintrc.json` は作らない）:

```ts
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, tanstack, vitest, antiSlop],
  jsPlugins: ["@shadcn/lint"],
  ignorePatterns: [
    ...core.ignorePatterns,
    // shadcn/ui が生成するコンポーネント。CLI で上書き更新するので lint 対象にしない。
    // @shadcn/lint もここには当たらない。ルールはコンポーネントを消費するアプリコードを見る
    "src/components/ui/**",
    // TanStack の start-bun example からコピーした本番サーバ
    "server.ts",
  ],
  rules: {
    "shadcn/no-restyle": ["error", { allow: ["layout"] }],
    "shadcn/no-raw-colors": "error",
    "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
    "shadcn/no-inline-styles": "error",
    "shadcn/require-static-classes": "error",
  },
});
```

- `react` preset は react / react-perf / jsx-a11y、`tanstack` preset は `src/routes/**` の `no-use-before-define` / `sort-keys` / `filename-case` 緩和と `routeTree.gen.ts` の扱い、`vitest` preset はテストの規約（`describe` 必須など）
- `oxfmt.config.ts` は `ultracite/oxfmt` を展開するだけ。Tailwind クラスの並び替え（`sortTailwindcss`、`cn` / `cva` 対応）は preset に含まれるので追加設定不要。手書きの `.oxfmtrc.json` / `.oxlintrc.json` は作らない
- `*.gen.*` は core の ignorePatterns に入っているので `routeTree.gen.ts` は lint / format の対象外
- `package.json` の scripts を上の形に揃え、`bun run fix` を一度実行して `bun run check` が通るまでを初期化に含める
- anti-slop preset は型アサーション、`unknown` の漏出、module mocking などを厳しく検査する。ルールを一括で無効化せず、正当な理由があるものだけ `oxlint.config.ts` で個別に上書きする
- `@shadcn/lint` は新規プロジェクトなのでルールを空にしない。上の 5 本が greenfield の既定。`shadcn/no-unknown-classes` は既定では入れない（後から `warn` で opt-in してよい。他 stylesheet 由来のクラスに `allow` が要ることがある）
- shadcn/ui プロジェクトは `components.json` からコンポーネントと theme を自動発見する。`settings.shadcn.ui` はディレクトリを変えたときなど、自動発見が足りない場合だけ書く
- `src/components/ui/**` を `ignorePatterns` に残す理由: コンポーネントは CLI 所有なので Ultracite の一般ルールを当てない。`@shadcn/lint` の対象も主にそれを消費するアプリコードなので、同じ除外でよい。`defineConfig` の `overrides` は Oxlint 公式の flat config で使えるが、`ignorePatterns` に入ったファイルには到達しない。生成コンポーネントにも `no-raw-colors` / `no-inline-styles` を当てたいときだけ、`src/components/ui/**` を ignore から外し、公式どおり次の override を足す（`no-restyle` / `no-arbitrary-values` / `require-static-classes` をオフ、`no-raw-colors` と `no-inline-styles` は残す）:

```ts
overrides: [
  {
    files: ["src/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
    },
  },
],
```

### knip.json

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [
    "src/routes/**/*.{ts,tsx}",
    "src/components/ui/**/*.tsx",
    "src/lib/utils.ts"
  ],
  "project": ["src/**/*.{ts,tsx}"],
  "ignoreDependencies": [
    "@effect/language-service",
    "@fontsource-variable/geist",
    "@shadcn/lint",
    "lucide-react",
    "shadcn",
    "tailwindcss",
    "tw-animate-css"
  ]
}
```

- ルートファイルは生成される `routeTree.gen.ts` からしか参照されないので `entry` にする（knip の tanstack-router plugin が `routeTree.gen.ts` と `src/router.tsx` は自動で entry にする）
- shadcn のコンポーネントは使う前から置かれるので `entry` にして未使用 export を報告させない。`src/lib/utils.ts` も shadcn の規約上のファイルなので同様
- `ignoreDependencies` は CSS の `@import` 経由でしか使われない依存（knip は CSS を追わない）と、shadcn が既定で入れる `lucide-react`。アイコンを使い始めたら `lucide-react` は外す。`@effect/language-service` は `@effect/tsgo` の plugin 名で実パッケージが無い。`@shadcn/lint` は `oxlint.config.ts` の `jsPlugins` 文字列だけで参照されるので knip からは未使用に見える

### .fallowrc.json

[fallow](https://github.com/fallow-rs/fallow) はグラフ全体の監査（未使用、循環、重複、複雑度、CSS drift）と、変更ファイルに対する `fallow audit` ゲート。knip の置換ではない。knip の設定とスクリプトは残し、`fallow migrate` は使わない。

対話の `fallow recommend` は任意の後追い調整用。初期化では次の設定をコミットする（スキーマは npm パッケージ同梱の `./node_modules/fallow/schema.json`。導入時に `bun pm view fallow version` で確認した版を pin する）。

```json
{
  "$schema": "./node_modules/fallow/schema.json",
  "ignorePatterns": [
    "**/*.gen.ts",
    "src/routeTree.gen.ts",
    "src/components/ui/**",
    "server.ts"
  ]
}
```

- 組み込み plugin が TanStack Router / Start と Vitest の entry を検出する。初回の誤検知は生成ファイルがほとんどなので `ignorePatterns` で外す
- `src/components/ui/**` は shadcn CLI 所有（knip の entry、oxlint の ignore と同じ理由）
- `server.ts` は TanStack の start-bun example からコピーした本番サーバ
- Fallow Runtime（有料）は入れない。`fallow license activate`、coverage の upload、runtime intelligence は使わない
- `--type-aware` は初期化の既定にしない（構文解析のまま。型付き検査は tsc と oxlint `--type-aware` が担う）。後から opt-in してよい
- `fallow agent install` と `fallow init --agents` は実行しない。このスキルが作る `CLAUDE.md` / `AGENTS.md` と競合する

### .editorconfig

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

### .gitignore

[gitignore.txt](gitignore.txt) をそのままコピーする。TanStack Start 用に `.tanstack/`、`.output/`、`.nitro/`、`dist/`、fallow 用に `.fallow/` が入っている。`src/routeTree.gen.ts` はコミットする（公式 example と同じ。Ultracite と fallow は無視、tsc は見る）。

## 最小ソース

```
src/router.tsx
src/routes/__root.tsx
src/routes/index.tsx
src/components/greeting.tsx
src/components/greeting.test.tsx
src/lib/greet.ts
src/lib/greet.test.ts
src/lib/utils.ts            # shadcn init が生成
src/components/ui/button.tsx  # shadcn add button が生成
src/styles/app.css
src/test/setup.ts
server.ts
```

`src/routeTree.gen.ts` は最初の `bun run dev` か `bun run build` で生成される。テストは `src/routes/` の下に置かない（Router が「Route を export していない」と警告する。置くなら `-` 始まりのファイル名）。

### src/router.tsx

```tsx
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();
  const router = createRouter({
    context: { queryClient },
    defaultPreload: "intent",
    routeTree,
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ queryClient, router });
  return router;
};
```

`QueryClient` はリクエストごとに `getRouter` の中で作る（SSR でキャッシュを共有しないため）。

### src/routes/__root.tsx

```tsx
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";

import appCss from "@/styles/app.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

const RootDocument = ({ children }: Readonly<{ children: ReactNode }>) => (
  <html lang="ja">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <TanStackDevtools
        config={{ position: "bottom-right" }}
        plugins={[
          { name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> },
          { name: "TanStack Query", render: <ReactQueryDevtoolsPanel /> },
        ]}
      />
      <Scripts />
    </body>
  </html>
);

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  head: () => ({
    links: [{ href: appCss, rel: "stylesheet" }],
    meta: [
      { charSet: "utf-8" },
      { content: "width=device-width, initial-scale=1", name: "viewport" },
      { title: "<project>" },
    ],
  }),
  shellComponent: RootDocument,
});
```

### src/routes/index.tsx

server function の中で Effect を実行する。Ultracite の `require-await` / `return-await` を同時に満たすため `async () => await ...` の形にする。

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { Greeting } from "@/components/greeting";
import { greet } from "@/lib/greet";

const getGreeting = createServerFn({ method: "GET" }).handler(
  async () => await Effect.runPromise(greet("TanStack Start"))
);

const Home = () => <Greeting message={Route.useLoaderData()} />;

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => await getGreeting(),
});
```

### src/components/greeting.tsx と greeting.test.tsx

```tsx
import { Button } from "@/components/ui/button";

export const Greeting = ({ message }: { message: string }) => (
  <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
    <h1 className="text-2xl font-bold">{message}</h1>
    <Button>Click me</Button>
  </main>
);
```

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { Greeting } from "./greeting";

describe(Greeting, () => {
  test("renders the message and a button", () => {
    render(<Greeting message="Hello" />);
    expect(screen.getByRole("heading")).toHaveTextContent("Hello");
    expect(screen.getByRole("button")).toHaveTextContent("Click me");
  });
});
```

### src/lib/greet.ts と greet.test.ts

```ts
import { Effect } from "effect";

export const greet = (name: string) => Effect.succeed(`Hello, ${name}!`);
```

```ts
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { greet } from "./greet";

describe(greet, () => {
  test("greets by name", () => {
    expect(Effect.runSync(greet("Effect"))).toBe("Hello, Effect!");
  });
});
```

### server.ts（本番サーバ）

TanStack 公式 example のものをそのままコピーする（nitro を使わない Bun 向けの参照実装）:

```bash
curl -fsSL https://raw.githubusercontent.com/TanStack/router/main/examples/react/start-bun/server.ts -o server.ts
```

`vite build` が `dist/client`（静的アセット）と `dist/server/server.js`（fetch handler）を出し、`server.ts` が `Bun.serve()` でそれを配信する。`PORT`（既定 3000）などの環境変数はファイル先頭のコメントに書いてある。React 19 が前提。

## Effect の規約

- 業務処理と副作用は Effect を返す。`Effect.runPromise` / `Effect.runSync` は server function の handler、loader、テストなどの境界に置く。React コンポーネントの中で Effect を実行しない
- 想定内の失敗は `Schema.TaggedError` などで型に載せる。`throw` や広い `catch (error: unknown)` を通常の制御フローにしない
- 外部入力（server function の入力、フォーム、環境変数）は Effect Schema で検証する。TanStack Form には `Schema.standardSchemaV1(schema)` を渡す。サービスは Layer で差し替え可能にする
- 純粋な同期変換や単純な React state まで無理に Effect で包まない
- API が不確かなときは型定義、公式ドキュメント、公式リポジトリの実例を確認し、存在しそうな API 名を推測しない

## CI

`references/github-actions.md` の雛形の TypeScript 版（`format` / `lint` / `typecheck` / `test` / `build` + `pinact`）を使う。`jdx/mise-action` が `bun` を入れるので `oven-sh/setup-bun` は不要。各ジョブの `mise run ...` の前に `bun install --frozen-lockfile` を挟む（lint の knip / fallow も `node_modules` のバイナリを使う）。

TypeScript の lint ジョブだけ `actions/checkout` に `fetch-depth: 0` を付ける。`fallow audit` が PR の base と差分を取るため（shallow clone だと `git merge-base` が取れない）。Go では付けない。

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

`fallow audit` は `package.json` の `"fallow": "fallow audit"` を `mise run lint` から回す。公式 Action `fallow-rs/fallow` は存在するが、このスキルでは必須にしない（版は bun.lock の pin に揃える）。

base 未指定時の公式既定は、上流または `origin/main` との `git merge-base`（`FALLOW_AUDIT_BASE` で固定可）。ゲートは既定 `new-only`（今回の変更が導入した finding だけ fail）。main への push（PR ベースが無い実行）でも同じコマンドを回す。上流と同じ commit なら変更ファイルは空で、finding が無ければ pass（exit 0）。base が取れないときは exit 2。独自フラグは足さない。

## 確認

1. 依存導入後の `mise run ci` で lint / format・型・テスト・build を確認する。`mise run lint` に oxlint、knip、`fallow audit` が含まれるので、required check 名は `lint` のままで足りる。失敗を直したら影響する検査だけ再実行する
2. 上で作った本番ビルドを `PORT=3999 bun run start` で起動し、`curl -s http://localhost:3999/` の HTML に見出しの文言と `<link rel="stylesheet">` が含まれ、`devtools` の文字列が含まれないことを確認してから止める
3. `mise run dev` でも同じページが出る

`bun run fix --codex` はコードを変更するため、通常の初期化や CI では実行しない。
