// EXP-001 source feasibility. Bounded sampling against the 11 approved sources.
// Measures: reachability, repeated-fetch success rate, field completeness,
// canonical URL / published_at availability, conditional-request support.
// Read-only. Respects documented rate limits. Disposable spike code.

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Signal Archive-EXP-001/0.1 (feasibility measurement; contact: repo owner)';

async function get(url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      rateRemaining: res.headers.get('x-ratelimit-remaining') ?? res.headers.get('ratelimit-remaining'),
      bytes: text.length,
      text,
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message, text: '' };
  }
}

function pct(n, d) { return d === 0 ? null : Math.round((n / d) * 1000) / 10; }

const results = {};

// ---------- github_releases ----------
async function githubReleases() {
  const repos = ['microsoft/playwright', 'oven-sh/bun', 'nodejs/node', 'elysiajs/elysia'];
  const r = { source: 'github_releases', items: 0, withId: 0, withUrl: 0, withPublishedAt: 0, createdDiffersFromPublished: 0, etagSupported: false, conditional304: null, repeats: [], notes: [] };
  for (const repo of repos) {
    const res = await get(`https://api.github.com/repos/${repo}/releases?per_page=10`, { accept: 'application/vnd.github+json' });
    r.repeats.push(res.status);
    if (!res.ok) { r.notes.push(`${repo}: HTTP ${res.status}`); await SLEEP(500); continue; }
    if (res.etag) {
      r.etagSupported = true;
      const again = await get(`https://api.github.com/repos/${repo}/releases?per_page=10`, { accept: 'application/vnd.github+json', 'if-none-match': res.etag });
      r.conditional304 = again.status;
    }
    const arr = JSON.parse(res.text);
    for (const it of arr) {
      r.items += 1;
      if (it.id) r.withId += 1;
      if (it.html_url) r.withUrl += 1;
      if (it.published_at) r.withPublishedAt += 1;
      if (it.published_at && it.created_at && it.published_at !== it.created_at) r.createdDiffersFromPublished += 1;
    }
    r.rateRemaining = res.rateRemaining;
    await SLEEP(700);
  }
  r.idPct = pct(r.withId, r.items);
  r.urlPct = pct(r.withUrl, r.items);
  r.publishedAtPct = pct(r.withPublishedAt, r.items);
  return r;
}

// ---------- stack_exchange ----------
async function stackExchange() {
  const r = { source: 'stack_exchange', items: 0, withId: 0, withLink: 0, withCreation: 0, withContentLicense: 0, licenses: {}, backoffSeen: false, quotaRemaining: null, notes: [] };
  const url = 'https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=typescript&pagesize=30&order=desc&sort=activity&filter=default';
  const res = await get(url);
  if (!res.ok) { r.notes.push(`HTTP ${res.status}`); return r; }
  const body = JSON.parse(res.text);
  r.quotaRemaining = body.quota_remaining ?? null;
  if (body.backoff) r.backoffSeen = true;
  for (const q of body.items ?? []) {
    r.items += 1;
    if (q.question_id) r.withId += 1;
    if (q.link) r.withLink += 1;
    if (q.creation_date) r.withCreation += 1;
    if (q.content_license) {
      r.withContentLicense += 1;
      r.licenses[q.content_license] = (r.licenses[q.content_license] ?? 0) + 1;
    }
  }
  r.idPct = pct(r.withId, r.items);
  r.urlPct = pct(r.withLink, r.items);
  r.publishedAtPct = pct(r.withCreation, r.items);
  r.licensePct = pct(r.withContentLicense, r.items);
  return r;
}

// ---------- users_rust_lang ----------
async function rustForum() {
  const r = { source: 'users_rust_lang', items: 0, withId: 0, withSlug: 0, withCreatedAt: 0, before2020: 0, notes: [] };
  const res = await get('https://users.rust-lang.org/latest.json');
  if (!res.ok) { r.notes.push(`HTTP ${res.status}`); return r; }
  const body = JSON.parse(res.text);
  const cutoff = new Date('2020-07-17T00:00:00Z').getTime();
  for (const t of body.topic_list?.topics ?? []) {
    r.items += 1;
    if (t.id) r.withId += 1;
    if (t.slug) r.withSlug += 1;
    if (t.created_at) {
      r.withCreatedAt += 1;
      if (new Date(t.created_at).getTime() < cutoff) r.before2020 += 1;
    }
  }
  r.idPct = pct(r.withId, r.items);
  r.urlPct = pct(r.withSlug, r.items);
  r.publishedAtPct = pct(r.withCreatedAt, r.items);
  return r;
}

// ---------- arxiv ----------
async function arxiv() {
  const r = { source: 'arxiv', items: 0, withId: 0, withPublished: 0, withSummary: 0, versioned: 0, notes: [] };
  const url = 'http://export.arxiv.org/api/query?search_query=cat:cs.IR&start=0&max_results=25&sortBy=submittedDate&sortOrder=descending';
  const res = await get(url);
  if (!res.ok) { r.notes.push(`HTTP ${res.status}`); return r; }
  const entries = res.text.split('<entry>').slice(1);
  for (const e of entries) {
    r.items += 1;
    const id = e.match(/<id>([^<]+)<\/id>/)?.[1];
    if (id) { r.withId += 1; if (/v\d+$/.test(id)) r.versioned += 1; }
    if (/<published>([^<]+)<\/published>/.test(e)) r.withPublished += 1;
    if (/<summary>/.test(e)) r.withSummary += 1;
  }
  r.idPct = pct(r.withId, r.items);
  r.urlPct = pct(r.withId, r.items);
  r.publishedAtPct = pct(r.withPublished, r.items);
  r.summaryPct = pct(r.withSummary, r.items);
  return r;
}

// ---------- chrome_release_notes ----------
async function chromeReleaseNotes() {
  const r = { source: 'chrome_release_notes', probed: [], serverRendered: null, dateFound: null, notes: [] };
  for (const v of [152, 151, 150]) {
    const res = await get(`https://developer.chrome.com/release-notes/${v}`);
    r.probed.push({ version: v, status: res.status, bytes: res.bytes });
    if (res.ok && r.serverRendered === null) {
      r.serverRendered = /Stable release date/i.test(res.text);
      r.dateFound = res.text.match(/Stable release date:?<\/strong>\s*([^<]{4,40})/i)?.[1]?.trim()
        ?? res.text.match(/Stable release date[^A-Za-z0-9]{0,20}([A-Z][a-z]+ \d{1,2}[a-z]{0,2},? \d{4})/)?.[1]
        ?? null;
    }
    await SLEEP(800);
  }
  return r;
}

// ---------- chrome_origin_trials ----------
async function chromeOriginTrials() {
  const res = await get('https://developer.chrome.com/origintrials/');
  return {
    source: 'chrome_origin_trials',
    status: res.status,
    bytes: res.bytes,
    requiresJavascript: /requires Javascript/i.test(res.text),
    bodySample: res.text.slice(0, 80).replace(/\s+/g, ' '),
  };
}

// ---------- react_blog ----------
async function reactBlog() {
  const res = await get('https://react.dev/rss.xml');
  const r = { source: 'react_blog', status: res.status, bytes: res.bytes, items: 0, withLink: 0, withDate: 0, notes: [] };
  if (!res.ok) { r.notes.push(`HTTP ${res.status}`); return r; }
  const items = res.text.split(/<item>/).slice(1);
  for (const it of items) {
    r.items += 1;
    if (/<link>/.test(it)) r.withLink += 1;
    if (/<pubDate>/.test(it)) r.withDate += 1;
  }
  r.urlPct = pct(r.withLink, r.items);
  r.publishedAtPct = pct(r.withDate, r.items);
  return r;
}

// ---------- npm_registry ----------
async function npmRegistry() {
  const pkgs = ['typescript', 'playwright', 'elysia', 'bullmq'];
  const r = { source: 'npm_registry', items: 0, withTime: 0, withLatest: 0, etagSupported: false, conditional304: null, emailsPresent: 0, notes: [] };
  for (const p of pkgs) {
    const res = await get(`https://registry.npmjs.org/${p}`);
    if (!res.ok) { r.notes.push(`${p}: HTTP ${res.status}`); continue; }
    if (res.etag) {
      r.etagSupported = true;
      const again = await get(`https://registry.npmjs.org/${p}`, { 'if-none-match': res.etag });
      r.conditional304 = again.status;
    }
    const body = JSON.parse(res.text);
    r.items += 1;
    if (body.time?.created && body.time?.modified) r.withTime += 1;
    if (body['dist-tags']?.latest) r.withLatest += 1;
    if (/"email"\s*:/.test(res.text)) r.emailsPresent += 1;
    await SLEEP(400);
  }
  return r;
}

// ---------- npm_downloads ----------
async function npmDownloads() {
  const r = { source: 'npm_downloads', notes: [] };
  const res = await get('https://api.npmjs.org/downloads/range/last-week/typescript');
  r.status = res.status;
  if (res.ok) {
    const b = JSON.parse(res.text);
    r.start = b.start; r.end = b.end;
    r.days = b.downloads?.length ?? 0;
    r.sample = b.downloads?.slice(0, 2);
    const bulk = await get('https://api.npmjs.org/downloads/point/last-week/typescript,playwright');
    r.bulkStatus = bulk.status;
    r.bulkKeys = bulk.ok ? Object.keys(JSON.parse(bulk.text)) : null;
  }
  return r;
}

// ---------- github_search ----------
async function githubSearch() {
  const r = { source: 'github_search', notes: [] };
  const q = encodeURIComponent('topic:typescript pushed:>2026-08-01 stars:>500');
  const res = await get(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`, { accept: 'application/vnd.github+json' });
  r.status = res.status;
  r.rateRemaining = res.rateRemaining;
  if (res.ok) {
    const b = JSON.parse(res.text);
    r.totalCount = b.total_count;
    r.incompleteResults = b.incomplete_results;
    r.returned = b.items?.length ?? 0;
    r.ownerFieldPresent = Boolean(b.items?.[0]?.owner);
    // repeatability: same query twice, compare returned full_name order
    await SLEEP(2200);
    const res2 = await get(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`, { accept: 'application/vnd.github+json' });
    if (res2.ok) {
      const b2 = JSON.parse(res2.text);
      const a = (b.items ?? []).map((x) => x.full_name).join('|');
      const c = (b2.items ?? []).map((x) => x.full_name).join('|');
      r.repeatIdentical = a === c;
    }
  }
  await SLEEP(2200);
  const qi = encodeURIComponent('is:issue updated:>2026-08-20 comments:>20');
  const resi = await get(`https://api.github.com/search/issues?q=${qi}&sort=comments&order=desc&per_page=20`, { accept: 'application/vnd.github+json' });
  r.issuesStatus = resi.status;
  if (resi.ok) {
    const bi = JSON.parse(resi.text);
    r.issuesTotal = bi.total_count;
    r.issuesReturned = bi.items?.length ?? 0;
    r.issuesHaveComments = Boolean(bi.items?.[0]?.comments !== undefined);
  }
  return r;
}

// ---------- huggingface_hub ----------
async function huggingface() {
  const r = { source: 'huggingface_hub', notes: [] };
  const res = await get('https://huggingface.co/api/models?limit=20&sort=downloads&direction=-1');
  r.status = res.status;
  if (res.ok) {
    const b = JSON.parse(res.text);
    r.returned = Array.isArray(b) ? b.length : 0;
    const first = Array.isArray(b) ? b[0] : null;
    r.hasId = Boolean(first?.id ?? first?.modelId);
    r.hasDownloads = typeof first?.downloads === 'number';
    r.hasLastModified = Boolean(first?.lastModified);
    r.hasLikes = typeof first?.likes === 'number';
    r.sampleKeys = first ? Object.keys(first).slice(0, 12) : null;
  }
  return r;
}

const tasks = [
  ['github_releases', githubReleases],
  ['stack_exchange', stackExchange],
  ['users_rust_lang', rustForum],
  ['arxiv', arxiv],
  ['chrome_release_notes', chromeReleaseNotes],
  ['chrome_origin_trials', chromeOriginTrials],
  ['react_blog', reactBlog],
  ['npm_registry', npmRegistry],
  ['npm_downloads', npmDownloads],
  ['github_search', githubSearch],
  ['huggingface_hub', huggingface],
];

for (const [name, fn] of tasks) {
  try {
    results[name] = await fn();
  } catch (e) {
    results[name] = { source: name, fatal: e.message };
  }
  await SLEEP(300);
}

console.log(JSON.stringify(results, null, 2));
