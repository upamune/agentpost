# agentpost 素材セット

[English](README.md) | [日本語](README.ja.md)

採用した伝書鳥のシルエットを保ち、横長ロゴと鳥単体を共通のベクターパスから書き出した素材です。ロゴの文言は小文字の `agentpost` のみです。

## 最初に使うファイル

| 用途                            | ファイル                                                      |
| ------------------------------- | ------------------------------------------------------------- |
| 明るい背景のWebヘッダー・README | `svg/logo.svg`                                                |
| 暗い背景のWebヘッダー           | `svg/logo-dark.svg`                                           |
| 鳥だけのアイコン                | `svg/symbol.svg`                                              |
| ブラウザーのタブ                | `favicon/favicon.svg` と `favicon/favicon.ico`                |
| iPhone・iPadのホーム画面        | `icons/apple-touch-icon.png`                                  |
| SNSでURLを共有するときの画像    | `social/og-image-light.png` または `social/og-image-dark.png` |
| 素材の一覧                      | `preview.html` または `preview.png`                           |

## SVG・PNG

SVGは画像の埋め込みを含まないベクターパスです。文字もアウトライン化しているため、表示側のフォントには依存しません。拡大・縮小や色の編集にはSVGを使ってください。

`logo-dark.svg` は青い鳥と白い文字、`logo-black.svg` と `logo-white.svg` は単色版です。単色版は顔・翼の空間が透過しており、背景色が見えます。カラー版の白い顔と翼は白で固定されています。文字だけの `wordmark.svg` / `wordmark-white.svg` もあります。

PNGは横長ロゴが幅1600px、@2x版が幅3200pxです。鳥は64 / 128 / 256 / 512 / 1024px。faviconは16 / 32 / 48pxで、ICOにも3サイズを含めています。Apple用は180px、アプリアイコンは192 / 512pxです。OGP画像は1200×630pxです。

## Webへの組み込み例

このフォルダー全体をWebサイトの `/brand/` に配置する例です。サイト側のテーマに合わせて、ロゴの明色用・暗色用を選んでください。

```html
<img src="/brand/svg/logo.svg" alt="agentpost" width="280" style="height:auto" />

<link rel="icon" href="/brand/favicon/favicon.ico" sizes="any" />
<link rel="icon" href="/brand/favicon/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/brand/icons/apple-touch-icon.png" />

<meta property="og:image" content="https://YOUR_DOMAIN/brand/social/og-image-light.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
```

PWA用のmanifestが必要な場合は、`<link rel="manifest" href="/brand/site.webmanifest">` を追加できます。`start_url` と `display` はサイトに合わせて調整してください。maskable版には中央に余白を設けています。manifestだけでオフライン対応になるわけではありません。

## 色と表示

- 青：`#315BFF`
- 文字・目：`#151A24`
- 白：`#FFFFFF`
- OGPの暗い背景：`#0F1420`

SVGには余白を含めています。縦横比を保ち、横長ロゴを極端に小さくする場合は鳥単体に切り替えてください。16pxでは鳥のシルエットと翼を主に認識するサイズとなり、目の細部は限られます。

リポジトリのREADMEは `<picture>` で明るい背景・暗い背景用SVGを切り替えます。配布スキルのアイコンは `skills/agentpost/assets/` に同梱するため、インストール後にソースcheckoutは不要です。npmのREADMEはパッケージ内の相対パスではなく、公開リポジトリの画像URLを使います。
