// EXP-005 Playwright gate. Disposable spike code.
// Measures, on the current runtime: browser launch, deterministic extraction,
// popup interception, download blocking, host allowlist via route, trace saving.
// Usage: node playwright-gate.mjs   |   bun playwright-gate.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const RUNTIME = process.versions?.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
const ITERATIONS = 10;
const OUT_DIR = path.join(process.cwd(), 'artifacts');

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>EXP-005 fixture</title></head>
<body>
  <h1 id="title">Chrome 152</h1>
  <p class="release-date" data-date="2026-08-25">Stable release date: August 25th, 2026</p>
  <section id="features">
    <article class="feature"><h3>CSSPseudoElement support</h3></article>
    <article class="feature"><h3>Relative alpha colors</h3></article>
    <article class="feature"><h3>window-drag CSS property</h3></article>
  </section>
  <a id="popup-link" href="/other" target="_blank">open popup</a>
  <a id="download-link" href="/blob.bin" download="blob.bin">download</a>
  <img id="external-img" src="http://127.0.0.1:59999/not-allowed.png" alt="">
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(FIXTURE);
      } else if (req.url === '/other') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><p id="p">popup body</p></body></html>');
      } else if (req.url === '/blob.bin') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="blob.bin"',
        });
        res.end(Buffer.alloc(1024, 7));
      } else {
        res.writeHead(404);
        res.end('nf');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const result = {
  runtime: RUNTIME,
  playwrightVersion: null,
  browserBinary: null,
  browserVersion: null,
  launch: null,
  launchMs: null,
  extraction: { runs: 0, identical: 0, values: [] },
  popupIntercepted: null,
  downloadBlocked: null,
  disallowedHostAborted: null,
  trace: { saved: null, bytes: 0 },
  errors: [],
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', 'playwright', 'package.json'), 'utf8'));
    result.playwrightVersion = pkg.version;
  } catch { /* optional */ }

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const allowedHost = '127.0.0.1';
  const allowedPort = String(port);

  let browser;
  const t0 = Date.now();
  const launchOpts = { headless: true };
  if (process.env.PW_CHROMIUM_PATH) launchOpts.executablePath = process.env.PW_CHROMIUM_PATH;
  else if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;
  result.browserBinary = launchOpts.executablePath || launchOpts.channel || 'bundled';
  try {
    browser = await chromium.launch(launchOpts);
    result.launch = 'ok';
    result.launchMs = Date.now() - t0;
    result.browserVersion = browser.version();
  } catch (e) {
    result.launch = 'fail';
    result.launchMs = Date.now() - t0;
    result.errors.push(`launch: ${e.message}`);
    server.close();
    return;
  }

  try {
    const context = await browser.newContext({ acceptDownloads: false });

    // host allowlist: abort anything not on the fixture origin
    let aborted = 0;
    await context.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === allowedHost && u.port === allowedPort) await route.continue();
      else { aborted += 1; await route.abort(); }
    });

    // popup interception: attach to the page, not the context,
    // so the main page we create is never closed by this handler.
    let popups = 0;

    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.on('popup', async (p) => { popups += 1; await p.close().catch(() => {}); });

    for (let i = 0; i < ITERATIONS; i += 1) {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      const title = await page.getByRole('heading', { level: 1 }).innerText();
      const date = await page.locator('.release-date').getAttribute('data-date');
      const features = await page.locator('#features .feature h3').allInnerTexts();
      result.extraction.values.push(JSON.stringify({ title, date, features }));
      result.extraction.runs += 1;
    }
    const first = result.extraction.values[0];
    result.extraction.identical = result.extraction.values.filter((v) => v === first).length;
    result.extraction.values = [first];

    // popup
    await page.click('#popup-link').catch((e) => result.errors.push(`popup click: ${e.message}`));
    await page.waitForTimeout(700);
    result.popupIntercepted = popups > 0;

    // download must be blocked by acceptDownloads:false
    let downloadEvent = false;
    let downloadFailure = null;
    page.on('download', async (d) => {
      downloadEvent = true;
      downloadFailure = await d.failure().catch(() => 'unknown');
    });
    await page.click('#download-link').catch((e) => result.errors.push(`download click: ${e.message}`));
    await page.waitForTimeout(1200);
    result.downloadBlocked = downloadEvent ? downloadFailure !== null : 'no-download-event';

    result.disallowedHostAborted = aborted > 0;

    const tracePath = path.join(OUT_DIR, `trace-${process.versions?.bun ? 'bun' : 'node'}.zip`);
    await context.tracing.stop({ path: tracePath });
    if (fs.existsSync(tracePath)) {
      result.trace.saved = true;
      result.trace.bytes = fs.statSync(tracePath).size;
    } else {
      result.trace.saved = false;
    }

    await context.close();
  } catch (e) {
    result.errors.push(`run: ${e.message}`);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

main()
  .then(() => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.launch === 'ok' && result.errors.length === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.log(JSON.stringify({ ...result, fatal: e.message }, null, 2));
    process.exit(1);
  });
