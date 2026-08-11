# JS-Downloader

Download JavaScript files used by a web page, including files loaded by SPA frameworks such as Next.js, Angular, Vue, Vite, and webpack-based apps.

The tool opens the page in a real Chromium browser, waits for the app to settle, records JavaScript network responses, scans the DOM for script/preload URLs, follows same-origin routes, and statically extracts lazy webpack chunk URLs from downloaded bundles.

Use it only on sites you own, administer, or have permission to inspect.

## Requirements

- Node.js 18 or newer
- Playwright
- Chromium for Playwright, or an installed Chrome/Edge browser
- Optional: Prettier for higher-quality formatting on smaller files

Install dependencies:

```bash
npm install playwright prettier
npx playwright install chromium
```

If Chromium is not installed through Playwright, the script tries to fall back to installed Chrome or Edge.

## Usage

```bash
node download-page-js.mjs <url> [options]
```

Basic download:

```bash
node download-page-js.mjs "https://example.com"
```

Download more SPA routes and save into a custom folder:

```bash
node download-page-js.mjs "https://example.com" \
  --out "./site-js" \
  --routes 80 \
  --depth 2 \
  --wait 2000
```

Download, extract source maps, recover original sources when available, and write readable JS:

```bash
node download-page-js.mjs "https://example.com" \
  --out "./site-js" \
  --routes 80 \
  --depth 1 \
  --wait 2000 \
  --pretty \
  --pretty-engine basic \
  --recover-sources
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--out <dir>` | `./downloaded-js` | Output directory. |
| `--routes <n>` | `25` | Maximum number of same-origin routes to visit. |
| `--depth <n>` | `1` | Same-origin route crawl depth. |
| `--wait <ms>` | `1500` | Extra wait after each page load to catch delayed chunks. |
| `--headful` | off | Show the browser window. |
| `--no-lazy-chunks` | off | Disable static lazy chunk discovery. |
| `--max-lazy-chunks <n>` | `1000` | Maximum lazy chunk URLs to download. |
| `--include-sourcemaps` | off | Download `.map` files referenced by JS files. |
| `--recover-sources` | off | Download sourcemaps and extract original sources into `__sources`. |
| `--pretty` | off | Save formatted JS copies into `__pretty`. |
| `--pretty-engine <mode>` | `auto` | Formatting mode: `auto`, `basic`, or `prettier`. |
| `--pretty-max-bytes <n>` | `750000` | In `auto` mode, use Prettier only for files up to this size. |
| `--timeout <ms>` | `45000` | Browser navigation and request timeout. |

## Output

The output folder contains:

```text
site-js/
  example.com/
    path/to/app.js
    path/to/chunk.js
  __pretty/
    example.com/
      path/to/app.js
  __sources/
    example.com/
      src/original-file.ts
  manifest.json
```

Raw files are saved using a host/path folder structure that mirrors the source URL.

`manifest.json` records:

- start URL
- scan timestamp
- routes visited
- every downloaded file URL
- local file path
- byte size
- content type
- discovery source

## Lazy Chunk Discovery

Lazy chunk discovery is enabled by default.

The script scans downloaded JavaScript for webpack-style chunk builders such as:

```js
p.u = function (e) {
  return "static/chunks/" + e + "." + ({ 53: "hash" })[e] + ".js";
};
```

For a Next.js app, this is resolved to URLs like:

```text
https://example.com/_next/static/chunks/53.hash.js
```

It also detects quoted JavaScript asset paths that appear directly inside bundles.

If a site has a very large number of chunks, limit the scan:

```bash
node download-page-js.mjs "https://example.com" --max-lazy-chunks 300
```

Or disable it:

```bash
node download-page-js.mjs "https://example.com" --no-lazy-chunks
```

## Source Maps And Original Sources

There are two levels of readable output:

- `--pretty` formats bundled/minified JavaScript into a more readable shape.
- `--recover-sources` uses source maps to recover original project files when the site exposes them.

Chrome DevTools can only show real original files when source maps are available. This script follows the same rule. If the site does not publish useful source maps, the tool can still prettify bundles, but it cannot reconstruct the real original source tree.

## Formatting

For large production bundles, Prettier can be slow. The recommended mode for large sites is:

```bash
--pretty --pretty-engine basic
```

`basic` is faster and avoids long hangs. `prettier` is nicer on smaller files:

```bash
--pretty --pretty-engine prettier
```

The default `auto` mode uses Prettier for smaller files and the basic formatter for large files.

## Troubleshooting

If the script appears stuck after `Recovered 0 source-map source file(s).`, it is probably formatting a large bundle. Stop it and rerun with:

```bash
--pretty-engine basic
```

If the browser cannot start:

```bash
npx playwright install chromium
```

If the page loads chunks after login or interaction, try:

```bash
--headful --wait 5000
```

If the scan is too slow, reduce route crawling:

```bash
--routes 10 --depth 1
```

If you only want files loaded by the first page and static lazy chunk discovery:

```bash
--routes 1 --depth 0
```
