# Project website

[English](website.md) | [日本語](website.ja.md)

The public product website is hosted at [upamune.github.io/agentpost](https://upamune.github.io/agentpost/), with a [Japanese version](https://upamune.github.io/agentpost/ja/). It is a static explanation and interactive example, separate from the authenticated Worker API/MCP service. It does not accept credentials or send mail.

Edit `website/template.html`, `website/content/en.json`, `website/content/ja.json`, `website/site.css`, and `website/site.js`. The build copies only explicitly selected public brand assets and the website output. It never uploads the repository, Worker configuration, or local credentials. There are no third-party runtime scripts, web fonts, analytics, dependencies, or API calls. Both languages have static HTML; tab and clipboard enhancements use a small local script. Reduced-motion preferences and keyboard tab navigation are supported.

Run `mise run site:build`. Serve `dist/site` with a local static HTTP server to inspect both languages, mobile layout, workflow tabs, copy buttons and keyboard focus. The build fails on missing translation tokens, missing local assets and broken section anchors. It writes cache-fingerprinted CSS/JS, canonical/alternate metadata, robots.txt and a sitemap. The canonical project URL is defined in `scripts/build-site.ts`; forks should update it and the project links before publishing.

`.github/workflows/pages.yml` validates the site on relevant pull requests and publishes after relevant main-branch changes. Enable GitHub Pages with **GitHub Actions** as its publishing source. Build has read-only repository access; the separate main-only deployment job has Pages/OIDC permissions and uses the `github-pages` environment. All Actions are SHA-pinned. Preview builds do not publish. Only `dist/site` becomes the Pages artifact.

After merging, require a successful Pages deployment and check the public English/Japanese URLs and assets over HTTPS before reporting publication complete. Website deployment does not deploy or validate a mail-service instance. CLI examples are illustrative and require an operator-configured API URL and inbox credentials; IDs are placeholders. A queued or accepted send is not a delivery receipt.
