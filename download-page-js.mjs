#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;

try {
  ({ chromium } = require("playwright"));
} catch {
  console.error(
    "Missing dependency: playwright\n\nInstall it with:\n  npm install playwright\n  npx playwright install chromium\n",
  );
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  console.error(`
Usage:
  node download-page-js.mjs <url> [options]

Options:
  --out <dir>              Output directory. Default: ./downloaded-js
  --routes <n>             Visit up to n same-origin links to trigger SPA chunks. Default: 25
  --depth <n>              Same-origin route crawl depth. Default: 1
  --wait <ms>              Extra wait after each page load. Default: 1500
  --headful                Show browser window
  --no-lazy-chunks         Skip static webpack/Vite lazy chunk discovery
  --max-lazy-chunks <n>    Max lazy chunk URLs to download. Default: 1000
  --include-sourcemaps     Also download source maps referenced by JS files
  --pretty                 Save formatted JS copies under <out>/__pretty
  --pretty-engine <mode>   auto, basic, or prettier. Default: auto
  --pretty-max-bytes <n>   Max file size for Prettier in auto mode. Default: 750000
  --recover-sources        Extract original sources from source maps under <out>/__sources
  --timeout <ms>           Page/navigation timeout. Default: 45000

Examples:
  node download-page-js.mjs https://example.com
  node download-page-js.mjs https://example.com --out ./js --routes 80 --depth 2
  node download-page-js.mjs https://example.com --pretty --recover-sources
`);
  process.exit(1);
}

const startUrl = normalizeUrl(args.url);
const origin = new URL(startUrl).origin;
const outRoot = path.resolve(args.out ?? "downloaded-js");
const maxRoutes = Number(args.routes ?? 25);
const maxDepth = Number(args.depth ?? 1);
const waitMs = Number(args.wait ?? 1500);
const timeoutMs = Number(args.timeout ?? 45000);
const pretty = Boolean(args.pretty || args.prettify || args.beautify);
const prettyEngine = String(args["pretty-engine"] ?? args.prettyEngine ?? "auto").toLowerCase();
const prettyMaxBytes = Number(args["pretty-max-bytes"] ?? args.prettyMaxBytes ?? 750_000);
const lazyChunks = !Boolean(args["no-lazy-chunks"] || args.noLazyChunks);
const maxLazyChunks = Number(args["max-lazy-chunks"] ?? args.maxLazyChunks ?? 1000);
const recoverSources = Boolean(
  args["recover-sources"] ||
    args.recoverSources ||
    args["extract-sources"] ||
    args.extractSources ||
    args.sources,
);
const includeSourcemaps = Boolean(args.includeSourcemaps || args["include-sourcemaps"] || recoverSources);

const downloaded = new Map();
const seenRoutes = new Set();
const queuedRoutes = [{ url: startUrl, depth: 0 }];
const discoveredJs = new Set();

await fs.mkdir(outRoot, { recursive: true });

const browser = await launchBrowser();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
});

context.setDefaultTimeout(timeoutMs);
context.setDefaultNavigationTimeout(timeoutMs);

const page = await context.newPage();

page.on("response", async (response) => {
  try {
    const request = response.request();
    const url = response.url();
    const headers = response.headers();
    const contentType = headers["content-type"] ?? "";

    if (
      request.resourceType() === "script" ||
      looksLikeJavaScriptUrl(url) ||
      looksLikeJavaScriptContentType(contentType)
    ) {
      await saveResponse(response, "network");
    }
  } catch {
    // Some browser-internal or cached responses cannot expose bodies. Ignore them.
  }
});

let routeVisits = 0;

while (queuedRoutes.length && routeVisits < maxRoutes) {
  const current = queuedRoutes.shift();
  const routeKey = stripHash(current.url);
  if (seenRoutes.has(routeKey)) continue;

  seenRoutes.add(routeKey);
  routeVisits += 1;

  console.log(`Visiting [${routeVisits}/${maxRoutes}]: ${current.url}`);
  await gotoAndSettle(page, current.url);

  const domUrls = await discoverScriptUrls(page);
  for (const jsUrl of domUrls) {
    discoveredJs.add(jsUrl);
    await downloadDirect(context, jsUrl, "dom");
  }

  await discoverFrameworkAssets(page, current.url);

  if (current.depth < maxDepth) {
    const links = await discoverSameOriginRoutes(page, origin);
    for (const link of links) {
      const key = stripHash(link);
      if (!seenRoutes.has(key) && !queuedRoutes.some((item) => stripHash(item.url) === key)) {
        queuedRoutes.push({ url: link, depth: current.depth + 1 });
      }
    }
  }
}

if (lazyChunks) {
  await discoverAndDownloadLazyChunks(context);
}

if (includeSourcemaps) {
  await downloadSourcemaps(context);
}

if (recoverSources) {
  await recoverOriginalSources(context);
}

await browser.close();

if (pretty) {
  await writePrettifiedFiles();
}

const manifest = {
  startUrl,
  scannedAt: new Date().toISOString(),
  routesVisited: [...seenRoutes],
  files: [...downloaded.values()].sort((a, b) => a.url.localeCompare(b.url)),
};

await fs.writeFile(
  path.join(outRoot, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8",
);

console.log(`\nDownloaded ${downloaded.size} JS file(s).`);
console.log(`Output: ${outRoot}`);

async function launchBrowser() {
  const launchOptions = { headless: !args.headful };

  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/Executable doesn't exist|browser executable|install/i.test(message)) {
      throw error;
    }
  }

  for (const channel of ["chrome", "msedge", "chrome-beta", "msedge-beta"]) {
    try {
      return await chromium.launch({ ...launchOptions, channel });
    } catch {}
  }

  throw new Error(
    "No Chromium browser was found. Run `npx playwright install chromium`, or install Chrome/Edge.",
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") && !parsed.url) {
      parsed.url = token;
      continue;
    }
    if (token === "--headful") {
      parsed.headful = true;
      continue;
    }
    if (
      [
        "--include-sourcemaps",
        "--pretty",
        "--prettify",
        "--beautify",
        "--no-lazy-chunks",
        "--recover-sources",
        "--extract-sources",
        "--sources",
      ].includes(token)
    ) {
      parsed[token.slice(2)] = true;
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      parsed[key] = argv[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function normalizeUrl(value) {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function stripHash(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function looksLikeJavaScriptUrl(value) {
  const pathname = new URL(value).pathname.toLowerCase();
  if (/\.(css|map|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$/i.test(pathname)) {
    return false;
  }
  return /\.(js|mjs|cjs)$/i.test(pathname);
}

function looksLikeJavaScriptContentType(value) {
  return /javascript|ecmascript|text\/js|application\/x-javascript/i.test(value);
}

async function gotoAndSettle(targetPage, url) {
  try {
    await targetPage.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (error) {
    console.warn(`  navigation warning: ${error.message}`);
  }

  try {
    await targetPage.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10000) });
  } catch {
    // Many SPAs keep long-lived requests open. A fixed wait below still catches late chunks.
  }

  await targetPage.waitForTimeout(waitMs);
}

async function discoverScriptUrls(targetPage) {
  const urls = await targetPage.evaluate(() => {
    const found = new Set();
    const add = (value) => {
      if (!value) return;
      try {
        found.add(new URL(value, location.href).href);
      } catch {}
    };

    document.querySelectorAll("script[src]").forEach((node) => add(node.src));
    document
      .querySelectorAll('link[href][rel~="modulepreload"], link[href][rel~="preload"], link[href][rel~="prefetch"]')
      .forEach((node) => {
        const asValue = (node.getAttribute("as") ?? "").toLowerCase();
        const href = node.getAttribute("href") ?? "";
        if (asValue === "script" || /\.(js|mjs|cjs)(?:$|\?)/i.test(href)) add(node.href);
      });

    performance.getEntriesByType("resource").forEach((entry) => {
      if (/\.(js|mjs|cjs)(?:$|\?)/i.test(entry.name)) add(entry.name);
    });

    return [...found];
  });

  return urls.filter((url) => looksLikeJavaScriptUrl(url));
}

async function discoverSameOriginRoutes(targetPage, expectedOrigin) {
  const routes = await targetPage.evaluate((originValue) => {
    const ignoredSchemes = /^(mailto|tel|sms|javascript):/i;
    const ignoredExt = /\.(zip|rar|7z|tar|gz|pdf|png|jpe?g|gif|webp|svg|ico|css|js|map|json|xml|txt|mp4|mp3|webm|mov)$/i;
    const found = new Set();

    document.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (!href || ignoredSchemes.test(href)) return;

      try {
        const url = new URL(href, location.href);
        if (url.origin !== originValue) return;
        if (ignoredExt.test(url.pathname)) return;
        url.hash = "";
        found.add(url.href);
      } catch {}
    });

    return [...found];
  }, expectedOrigin);

  return routes;
}

async function discoverFrameworkAssets(targetPage, baseUrl) {
  const assets = await targetPage.evaluate(() => {
    const found = new Set();
    const add = (value) => {
      if (typeof value !== "string") return;
      if (!/\.(js|mjs|cjs)(?:$|\?)/i.test(value)) return;
      try {
        found.add(new URL(value, location.href).href);
      } catch {}
    };

    const walk = (value, depth = 0) => {
      if (depth > 6 || value == null) return;
      if (typeof value === "string") {
        add(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item, depth + 1));
        return;
      }
      if (typeof value === "object") {
        Object.values(value).forEach((item) => walk(item, depth + 1));
      }
    };

    walk(window.__BUILD_MANIFEST);
    walk(window.__SSG_MANIFEST);
    walk(window.__NEXT_DATA__);

    for (const key of Object.keys(window)) {
      if (/webpack|vite|manifest|preload|chunk/i.test(key)) {
        try {
          walk(window[key]);
        } catch {}
      }
    }

    return [...found];
  });

  for (const asset of assets) {
    const fullUrl = new URL(asset, baseUrl).href;
    discoveredJs.add(fullUrl);
    await downloadDirect(context, fullUrl, "framework");
  }
}

async function discoverAndDownloadLazyChunks(activeContext) {
  let totalLazyDownloads = 0;
  let round = 0;
  const attempted = new Set();

  while (round < 4 && totalLazyDownloads < maxLazyChunks) {
    round += 1;
    const candidates = new Set();
    const jsFiles = [...downloaded.values()].filter(
      (item) => item.source !== "sourcemap" && /\.(js|mjs|cjs)$/i.test(item.localPath),
    );

    for (const file of jsFiles) {
      const source = await fs.readFile(file.localPath, "utf8").catch(() => "");
      if (!source) continue;

      for (const url of extractLazyChunkUrls(source, file.url)) {
        if (!downloaded.has(url) && !attempted.has(url)) candidates.add(url);
      }
    }

    const toDownload = [...candidates].slice(0, maxLazyChunks - totalLazyDownloads);
    if (!toDownload.length) {
      if (round === 1) console.log("Lazy chunk scan found 0 new JS URL(s).");
      break;
    }

    console.log(`Lazy chunk scan round ${round}: found ${toDownload.length} new JS URL(s).`);
    let roundDownloads = 0;

    for (const url of toDownload) {
      attempted.add(url);
      const before = downloaded.size;
      await downloadDirect(activeContext, url, "lazy");
      if (downloaded.size > before) {
        roundDownloads += 1;
        totalLazyDownloads += 1;
      }
      if (totalLazyDownloads >= maxLazyChunks) break;
    }

    if (!roundDownloads) break;
  }

  if (totalLazyDownloads >= maxLazyChunks) {
    console.warn(`  lazy warning: stopped at --max-lazy-chunks=${maxLazyChunks}`);
  }
}

function extractLazyChunkUrls(source, fileUrl) {
  const found = new Set();

  for (const assetPath of extractLiteralJavaScriptPaths(source)) {
    for (const url of resolveAssetUrls(assetPath, fileUrl, source)) {
      found.add(url);
    }
  }

  for (const assetPath of extractWebpackChunkMapPaths(source)) {
    for (const url of resolveAssetUrls(assetPath, fileUrl, source)) {
      found.add(url);
    }
  }

  return [...found].filter((url) => {
    if (downloaded.has(url)) return false;
    try {
      return looksLikeJavaScriptUrl(url);
    } catch {
      return false;
    }
  });
}

function extractLiteralJavaScriptPaths(source) {
  const found = new Set();
  const quotedPath =
    /["'`]((?:https?:\/\/|\/\/|\/|\.{1,2}\/)?[^"'`\\\s]*(?:(?:static\/chunks\/)|(?:\/chunks\/)|(?:assets\/))[^"'`\\\s]*?\.(?:js|mjs|cjs)(?:\?[^"'`]*)?)["'`]/gi;

  for (const match of source.matchAll(quotedPath)) {
    found.add(match[1]);
  }

  return found;
}

function extractWebpackChunkMapPaths(source) {
  const found = new Set();

  const simpleChunkMap =
    /["']([^"']*static\/chunks\/)["']\s*\+\s*([A-Za-z_$][\w$]*)\s*\+\s*["']\.["']\s*\+\s*\(\{([\s\S]*?)\}\)\[\2\]\s*\+\s*["']\.(?:js|mjs|cjs)["']/g;

  for (const match of source.matchAll(simpleChunkMap)) {
    const prefix = match[1];
    for (const [chunkId, hash] of parseWebpackObjectMap(match[3])) {
      found.add(`${prefix}${chunkId}.${hash}.js`);
    }
  }

  const blockBeforeJs =
    /\(\{([\s\S]{10,60000}?)\}\)\[([A-Za-z_$][\w$]*)\]\s*\+\s*["']\.(?:js|mjs|cjs)["']/g;

  for (const match of source.matchAll(blockBeforeJs)) {
    const blockStart = Math.max(0, match.index - 250);
    const prefixSource = source.slice(blockStart, match.index);
    const prefixMatch = prefixSource.match(/["']([^"']*static\/chunks\/)["']\s*\+\s*[A-Za-z_$][\w$]*\s*\+\s*["']\.["']\s*\+\s*$/);
    if (!prefixMatch) continue;

    const prefix = prefixMatch[1];
    for (const [chunkId, hash] of parseWebpackObjectMap(match[1])) {
      found.add(`${prefix}${chunkId}.${hash}.js`);
    }
  }

  return found;
}

function parseWebpackObjectMap(block) {
  const entries = [];
  const entryPattern =
    /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*|[0-9]+(?:e[0-9]+)?))\s*:\s*["']([^"']+)["']/gi;

  for (const match of block.matchAll(entryPattern)) {
    const rawKey = match[1] ?? match[2] ?? match[3];
    const value = match[4];
    if (!rawKey || !/^[A-Za-z0-9_$]+$/.test(rawKey) || !/^[A-Za-z0-9._-]+$/.test(value)) {
      continue;
    }

    entries.push([normalizeChunkId(rawKey), value]);
  }

  return entries;
}

function normalizeChunkId(value) {
  if (/^[0-9]+e[0-9]+$/i.test(value)) return String(Number(value));
  return value;
}

function resolveAssetUrls(assetPath, fileUrl, source) {
  const value = assetPath.trim();
  const urls = new Set();
  const sourceUrl = new URL(fileUrl);

  if (/^https?:\/\//i.test(value)) {
    urls.add(value);
    return [...urls];
  }

  if (value.startsWith("//")) {
    urls.add(`${new URL(startUrl).protocol}${value}`);
    return [...urls];
  }

  if (value.startsWith("/")) {
    urls.add(new URL(value, origin).href);
    return [...urls];
  }

  if (value.startsWith("static/") && sourceUrl.pathname.includes("/_next/static/")) {
    urls.add(`${sourceUrl.origin}/_next/${value}`);
    for (const base of inferExplicitPublicPathBases(sourceUrl, source)) {
      try {
        urls.add(new URL(value, base).href);
      } catch {}
    }
    return [...urls];
  }

  for (const base of inferAssetBases(fileUrl, source)) {
    try {
      urls.add(new URL(value, base).href);
    } catch {}
  }

  return [...urls];
}

function inferExplicitPublicPathBases(sourceUrl, source) {
  const bases = new Set();

  for (const match of source.matchAll(/(?:\.p|publicPath)\s*=\s*["']([^"']+)["']/g)) {
    const publicPath = match[1];
    if (!publicPath || publicPath === "auto") continue;
    try {
      bases.add(new URL(publicPath, sourceUrl.origin).href);
    } catch {}
  }

  return [...bases];
}

function inferAssetBases(fileUrl, source) {
  const url = new URL(fileUrl);
  const bases = new Set([new URL("./", fileUrl).href]);

  const staticIndex = url.pathname.indexOf("/static/chunks/");
  if (staticIndex !== -1) {
    bases.add(`${url.origin}${url.pathname.slice(0, staticIndex + 1)}`);
  }

  const nextStaticIndex = url.pathname.indexOf("/_next/static/");
  if (nextStaticIndex !== -1) {
    bases.add(`${url.origin}${url.pathname.slice(0, nextStaticIndex + "/_next/".length)}`);
  }

  for (const base of inferExplicitPublicPathBases(url, source)) {
    bases.add(base);
  }

  bases.add(`${url.origin}/`);
  return [...bases];
}

async function downloadSourcemaps(activeContext) {
  const jsFiles = [...downloaded.values()].filter((item) => item.localPath.endsWith(".js"));

  for (const file of jsFiles) {
    const data = await fs.readFile(file.localPath, "utf8").catch(() => "");
    const match = data.match(/\/\/[#@]\s*sourceMappingURL=(.+)\s*$/m);
    if (!match) continue;

    const mapRef = match[1].trim();
    if (mapRef.startsWith("data:")) {
      const inlineMap = decodeInlineSourcemap(mapRef);
      if (!inlineMap) continue;

      const mapUrl = `${file.url}.inline.map`;
      await saveBuffer(mapUrl, Buffer.from(inlineMap), "application/json", "sourcemap");
      continue;
    }

    const mapUrl = new URL(mapRef, file.url).href;
    await downloadDirect(activeContext, mapUrl, "sourcemap");
  }
}

async function recoverOriginalSources(activeContext) {
  const mapFiles = [...downloaded.values()].filter((item) => item.source === "sourcemap");
  let recovered = 0;

  for (const mapFile of mapFiles) {
    const raw = await fs.readFile(mapFile.localPath, "utf8").catch(() => "");
    if (!raw) continue;

    let sourcemap;
    try {
      sourcemap = JSON.parse(raw);
    } catch {
      console.warn(`  source-map warning: cannot parse ${mapFile.url}`);
      continue;
    }

    const sources = Array.isArray(sourcemap.sources) ? sourcemap.sources : [];
    const sourcesContent = Array.isArray(sourcemap.sourcesContent) ? sourcemap.sourcesContent : [];
    const sourceRoot = typeof sourcemap.sourceRoot === "string" ? sourcemap.sourceRoot : "";
    const mapBaseUrl = mapFile.url.replace(/\.inline\.map$/, "");

    for (let i = 0; i < sources.length; i += 1) {
      const sourceName = sources[i];
      if (!sourceName || /^webpack:\/{3}ignored|^webpack:\/\/\/\(\./.test(sourceName)) continue;

      let sourceCode = sourcesContent[i];
      if (typeof sourceCode !== "string") {
        sourceCode = await fetchMappedSource(activeContext, mapBaseUrl, sourceRoot, sourceName);
      }
      if (typeof sourceCode !== "string") continue;

      const sourcePath = originalSourcePath(mapFile.url, sourceRoot, sourceName);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, sourceCode, "utf8");
      recovered += 1;
    }
  }

  console.log(`Recovered ${recovered} source-map source file(s).`);
}

async function fetchMappedSource(activeContext, mapBaseUrl, sourceRoot, sourceName) {
  if (/^(webpack|ng|vite|rollup|parcel):/i.test(sourceName)) return null;

  const candidates = [];
  for (const value of [sourceName, path.posix.join(sourceRoot, sourceName)]) {
    try {
      candidates.push(new URL(value, mapBaseUrl).href);
    } catch {}
  }

  for (const url of [...new Set(candidates)]) {
    try {
      const response = await activeContext.request.get(url, {
        timeout: timeoutMs,
        headers: { referer: startUrl },
      });
      if (response.ok()) return await response.text();
    } catch {}
  }

  return null;
}

function decodeInlineSourcemap(value) {
  const match = value.match(/^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;

  try {
    return match[1]
      ? Buffer.from(match[2], "base64").toString("utf8")
      : decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

function originalSourcePath(mapUrl, sourceRoot, sourceName) {
  const mapHost = sanitizePathSegment(new URL(mapUrl.replace(/\.inline\.map$/, "")).host);
  const cleanRoot = normalizeVirtualSourcePart(sourceRoot);
  const cleanSource = normalizeVirtualSourcePart(sourceName);
  const parts = [outRoot, "__sources", mapHost, ...cleanRoot, ...cleanSource];

  let fullPath = path.join(...parts);
  if (!path.extname(fullPath)) fullPath += ".js";
  return fullPath;
}

function normalizeVirtualSourcePart(value) {
  return String(value ?? "")
    .replace(/^[a-z][a-z0-9+.-]*:\/{0,3}/i, "")
    .replace(/^\/*/, "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => sanitizePathSegment(part));
}

async function writePrettifiedFiles() {
  const jsFiles = [...downloaded.values()].filter(
    (item) => item.source !== "sourcemap" && /\.(js|mjs|cjs)$/i.test(item.localPath),
  );
  const prettier =
    prettyEngine === "basic" || prettyEngine === "fast" ? null : await loadPrettier();
  let formattedCount = 0;
  let basicCount = 0;
  let prettierCount = 0;

  for (let i = 0; i < jsFiles.length; i += 1) {
    const file = jsFiles[i];
    const source = await fs.readFile(file.localPath, "utf8").catch(() => null);
    if (source == null) continue;

    const relative = path.relative(outRoot, file.localPath);
    const sourceBytes = Buffer.byteLength(source, "utf8");
    const usePrettier =
      prettier &&
      prettyEngine !== "basic" &&
      (prettyEngine === "prettier" || sourceBytes <= prettyMaxBytes);

    console.log(
      `  prettifying [${i + 1}/${jsFiles.length}] ${relative} (${formatBytes(
        sourceBytes,
      )}, ${usePrettier ? "prettier" : "basic"})`,
    );

    const formatted = usePrettier
      ? await formatWithPrettier(prettier, source, file.localPath)
      : basicJavaScriptPrettify(source);
    const prettyPath = path.join(outRoot, "__pretty", path.relative(outRoot, file.localPath));

    await fs.mkdir(path.dirname(prettyPath), { recursive: true });
    await fs.writeFile(prettyPath, formatted, "utf8");
    formattedCount += 1;
    if (usePrettier) prettierCount += 1;
    else basicCount += 1;
  }

  if (!prettier && prettyEngine !== "basic" && prettyEngine !== "fast") {
    console.warn("  pretty warning: install prettier for higher-quality small-file formatting: npm install prettier");
  }
  console.log(
    `Prettified ${formattedCount} JS file(s): ${prettierCount} with Prettier, ${basicCount} with basic formatter.`,
  );
}

async function loadPrettier() {
  try {
    return require("prettier");
  } catch {
    try {
      return await import("prettier");
    } catch {
      return null;
    }
  }
}

async function formatWithPrettier(prettier, source, filePath) {
  try {
    const formatted = prettier.format(source, {
      parser: "babel",
      filepath: filePath,
      printWidth: 100,
    });
    return typeof formatted?.then === "function" ? await formatted : formatted;
  } catch {
    return basicJavaScriptPrettify(source);
  }
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function basicJavaScriptPrettify(source) {
  const parts = [];
  const indentCache = [""];
  let indent = 0;
  let quote = null;
  let escaped = false;
  let lineStart = true;
  let pendingSpace = false;
  let consecutiveNewlines = 0;

  const currentIndent = () => {
    const safeIndent = Math.max(indent, 0);
    if (!indentCache[safeIndent]) {
      indentCache[safeIndent] = "  ".repeat(safeIndent);
    }
    return indentCache[safeIndent];
  };

  const writeIndent = () => {
    if (!lineStart) return;
    const value = currentIndent();
    if (value) parts.push(value);
    lineStart = false;
  };

  const writeToken = (value) => {
    if (!value) return;
    if (lineStart) {
      writeIndent();
    } else if (pendingSpace) {
      parts.push(" ");
    }
    parts.push(value);
    lineStart = false;
    pendingSpace = false;
    consecutiveNewlines = 0;
  };

  const writeNewline = () => {
    pendingSpace = false;
    if (lineStart) {
      if (consecutiveNewlines >= 2) return;
    } else {
      lineStart = true;
    }
    parts.push("\n");
    lineStart = true;
    consecutiveNewlines += 1;
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      writeToken(char);
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      writeToken(char);
      continue;
    }

    if (char === "{" || char === "[" || char === "(") {
      writeToken(char);
      indent += 1;
      writeNewline();
      continue;
    }

    if (char === "}" || char === "]" || char === ")") {
      if (!lineStart) writeNewline();
      indent -= 1;
      writeToken(char);
      if (next !== ";" && next !== "," && next !== "." && next !== ")" && next !== "]") {
        writeNewline();
      }
      continue;
    }

    if (char === ";" || char === ",") {
      writeToken(char);
      writeNewline();
      continue;
    }

    if (/\s/.test(char)) {
      if (!lineStart) pendingSpace = true;
      continue;
    }

    writeToken(char);
  }

  return parts.join("");
}

async function downloadDirect(activeContext, url, source) {
  if (downloaded.has(url)) return;

  try {
    const response = await activeContext.request.get(url, {
      timeout: timeoutMs,
      headers: { referer: startUrl },
    });

    if (!response.ok()) {
      console.warn(`  skip ${response.status()} ${url}`);
      return;
    }

    const contentType = response.headers()["content-type"] ?? "";
    if (
      source !== "sourcemap" &&
      !looksLikeJavaScriptUrl(url) &&
      !looksLikeJavaScriptContentType(contentType)
    ) {
      return;
    }

    const body = await response.body();
    await saveBuffer(url, body, contentType, source);
  } catch (error) {
    console.warn(`  download warning: ${url} (${error.message})`);
  }
}

async function saveResponse(response, source) {
  const url = response.url();
  if (downloaded.has(url)) return;

  const body = await response.body();
  const contentType = response.headers()["content-type"] ?? "";
  await saveBuffer(url, body, contentType, source);
}

async function saveBuffer(url, body, contentType, source) {
  if (downloaded.has(url)) return;

  const localPath = path.join(outRoot, localFileNameForUrl(url));
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, body);

  downloaded.set(url, {
    url,
    localPath,
    bytes: body.length,
    contentType,
    source,
  });

  console.log(`  saved ${url}`);
}

function localFileNameForUrl(value) {
  const url = new URL(value);
  const host = sanitizePathSegment(url.host);
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => sanitizePathSegment(part));

  let file = parts.pop() || "index.js";
  if (!path.extname(file)) file += ".js";

  if (url.search) {
    const hash = crypto.createHash("sha1").update(url.search).digest("hex").slice(0, 10);
    const ext = path.extname(file);
    file = `${path.basename(file, ext)}.${hash}${ext}`;
  }

  return path.join(host, ...parts, file);
}

function sanitizePathSegment(value) {
  return decodeURIComponent(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 160);
}
