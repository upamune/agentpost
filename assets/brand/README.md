# Agentpost brand assets

[English](README.md) | [日本語](README.ja.md)

The supplied carrier-bird artwork is the Agentpost logo. The horizontal logo and standalone symbol share the same vector paths. The wordmark is lowercase `agentpost`.

## Choose an asset

| Use                               | File                                                      |
| --------------------------------- | --------------------------------------------------------- |
| Light-background header or README | `svg/logo.svg`                                            |
| Dark-background header or README  | `svg/logo-dark.svg`                                       |
| Standalone bird                   | `svg/symbol.svg`                                          |
| Browser tab                       | `favicon/favicon.svg` and `favicon/favicon.ico`           |
| Apple home screen                 | `icons/apple-touch-icon.png`                              |
| Social preview                    | `social/og-image-light.png` or `social/og-image-dark.png` |
| Asset overview                    | `preview.html` or `preview.png`                           |

SVGs contain outlined vector paths, without embedded images or font dependencies. Use them when scaling or recoloring. `logo-dark.svg` uses a blue bird and white lettering. Black and white variants have transparent face/wing cutouts; the color variants keep those areas white. Wordmark-only SVGs are also included.

Horizontal PNGs are 1600 pixels wide, with 3200-pixel `@2x` variants. Bird symbols are available at 64, 128, 256, 512, and 1024 pixels. Favicons are 16, 32, and 48 pixels; the ICO contains all three sizes. Apple icons are 180 pixels, app icons are 192/512 pixels, and social previews are 1200 × 630 pixels.

## Display

Preserve the aspect ratio and built-in spacing. Use the standalone bird at small sizes. At 16 pixels, the silhouette and wing are the main recognizable details.

- Blue: `#315BFF`
- Lettering and eye: `#151A24`
- White: `#FFFFFF`
- Dark social-preview background: `#0F1420`

The repository READMEs choose light/dark SVGs with `<picture>`. The distributable skill carries its own icon copies under `skills/agentpost/assets/`, so an installed skill does not need the source checkout. npm README images use public repository URLs rather than package-relative asset paths.

For a website that serves this directory at `/brand/`, use:

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

Choose the logo variant to match the site's theme. The optional `site.webmanifest` includes maskable icons with safe padding; adapt `start_url` and `display` for the host application. A manifest alone does not provide offline support.
