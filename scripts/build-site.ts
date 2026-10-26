import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const source = join(root, "website");
const output = join(root, "dist/site");
const siteUrl = "https://upamune.github.io/agentpost/";

function escapeHtml(value: string): string {
  const characters: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => characters[char]!);
}
async function translations(locale: string): Promise<Record<string, string>> {
  const value: unknown = JSON.parse(
    await readFile(join(source, "content", `${locale}.json`), "utf8"),
  );
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid website translation map");
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string") throw new Error(`Invalid website translation: ${key}`);
    result[key] = text;
  }
  return result;
}
async function asset(file: string): Promise<string> {
  const content = await readFile(join(source, file));
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 10);
  const name = file.replace(".", `.${digest}.`);
  await writeFile(join(output, "assets", name), content);
  return name;
}
async function render(
  locale: "en" | "ja",
  assets: { stylesheet: string; script: string },
): Promise<string> {
  const routes = {
    en: { prefix: "./", path: "", otherLanguage: "./ja/", otherLang: "ja", otherName: "日本語" },
    ja: { prefix: "../", path: "ja/", otherLanguage: "../", otherLang: "en", otherName: "English" },
  };
  const route = routes[locale];
  const { prefix } = route;
  const dictionary = await translations(locale);
  const values: Record<string, string> = {
    ...dictionary,
    lang: locale,
    assets: `${prefix}assets/`,
    home: "./",
    canonical: `${siteUrl}${route.path}`,
    social: `${siteUrl}assets/social.png`,
    english: siteUrl,
    japanese: `${siteUrl}ja/`,
    otherLanguage: route.otherLanguage,
    otherLang: route.otherLang,
    otherName: route.otherName,
    stylesheet: `${prefix}assets/${assets.stylesheet}`,
    script: `${prefix}assets/${assets.script}`,
  };
  const template = await readFile(join(source, "template.html"), "utf8");
  const html = template.replace(/\{\{([\w.]+)\}\}/g, (_match, key: string) => {
    if (values[key] === undefined) throw new Error(`Missing ${locale} website text: ${key}`);
    return escapeHtml(values[key]);
  });
  if (locale === "ja")
    return html
      .replaceAll("/blob/main/INSTALL.md", "/blob/main/INSTALL.ja.md")
      .replaceAll("/docs/security-checks.md", "/docs/security-checks.ja.md");
  return html;
}
async function validateLocalLink(target: string, html: string, directory: string) {
  if (target.startsWith("#")) {
    if (!html.includes(`id="${target.slice(1)}"`)) throw new Error(`Missing section: ${target}`);
    return;
  }
  const file = target.endsWith("/") ? `${target}index.html` : target;
  await readFile(resolve(directory, file));
}
async function validateLinks(html: string, directory: string) {
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1]!;
    if (target.startsWith("https://")) continue;
    await validateLocalLink(target, html, directory);
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
await mkdir(join(output, "ja"), { recursive: true });
const assets = { stylesheet: await asset("site.css"), script: await asset("site.js") };
for (const [from, to] of [
  ["svg/logo-dark.svg", "logo.svg"],
  ["svg/symbol.svg", "symbol.svg"],
  ["favicon/favicon.svg", "favicon.svg"],
  ["social/og-image-dark.png", "social.png"],
])
  await copyFile(join(root, "assets/brand", from!), join(output, "assets", to!));
const english = await render("en", assets);
const japanese = await render("ja", assets);
await writeFile(join(output, "index.html"), english);
await writeFile(join(output, "ja/index.html"), japanese);
await writeFile(join(output, ".nojekyll"), "");
await writeFile(
  join(output, "robots.txt"),
  `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`,
);
await writeFile(
  join(output, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}</loc></url><url><loc>${siteUrl}ja/</loc></url></urlset>`,
);
await validateLinks(english, output);
await validateLinks(japanese, join(output, "ja"));
console.log("Built and checked English/Japanese static pages in dist/site (public assets only)");
