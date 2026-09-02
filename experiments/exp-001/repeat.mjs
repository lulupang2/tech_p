// EXP-001 run 2: repeated bounded fetch. Measures success rate over 10 attempts
// per source and whether the extracted key fields stay consistent.
// Spacing respects each source's documented rate limits. Read-only.

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Signal Archive-EXP-001/0.1 (feasibility measurement; contact: repo owner)';
const N = 10;

async function attempt(url, headers = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, text };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message, text: '' };
  }
}

// each target: url, spacing in ms, and a fingerprint fn over the response
const targets = [
  {
    name: 'github_releases',
    url: 'https://api.github.com/repos/microsoft/playwright/releases?per_page=5',
    headers: { accept: 'application/vnd.github+json' },
    spacing: 1200,
    fingerprint: (t) => {
      const a = JSON.parse(t);
      return a.map((x) => `${x.id}:${x.published_at}`).join('|');
    },
  },
  {
    name: 'stack_exchange',
    url: 'https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=typescript&pagesize=5&order=desc&sort=creation',
    spacing: 1500,
    fingerprint: (t) => {
      const b = JSON.parse(t);
      return (b.items ?? []).map((q) => `${q.question_id}:${q.creation_date}`).join('|');
    },
  },
  {
    name: 'users_rust_lang',
    url: 'https://users.rust-lang.org/latest.json',
    spacing: 1500,
    fingerprint: (t) => {
      const b = JSON.parse(t);
      return (b.topic_list?.topics ?? []).slice(0, 5).map((x) => `${x.id}`).join('|');
    },
  },
  {
    name: 'arxiv',
    url: 'http://export.arxiv.org/api/query?search_query=cat:cs.IR&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending',
    spacing: 3200, // TOU: no more than one request every three seconds
    fingerprint: (t) => (t.match(/<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/g) ?? []).join('|'),
  },
  {
    name: 'chrome_release_notes',
    url: 'https://developer.chrome.com/release-notes/152',
    spacing: 1200,
    fingerprint: (t) => String(/Stable release date/i.test(t)) + ':' + (t.match(/<h1[^>]*>([^<]{1,40})<\/h1>/)?.[1]?.trim() ?? 'no-h1'),
  },
  {
    name: 'chrome_origin_trials',
    url: 'https://developer.chrome.com/origintrials/',
    spacing: 1200,
    fingerprint: (t) => String(/requires Javascript/i.test(t)),
  },
  {
    name: 'react_blog',
    url: 'https://react.dev/rss.xml',
    spacing: 1000,
    fingerprint: (t) => (t.match(/<link>([^<]+)<\/link>/g) ?? []).slice(0, 5).join('|'),
  },
  {
    name: 'npm_registry',
    url: 'https://registry.npmjs.org/typescript',
    spacing: 1000,
    fingerprint: (t) => {
      const b = JSON.parse(t);
      return `${b['dist-tags']?.latest}:${b.time?.modified}`;
    },
  },
  {
    name: 'npm_downloads',
    url: 'https://api.npmjs.org/downloads/point/last-week/typescript',
    spacing: 1000,
    fingerprint: (t) => {
      const b = JSON.parse(t);
      return `${b.start}:${b.end}:${b.downloads}`;
    },
  },
  {
    name: 'huggingface_hub',
    url: 'https://huggingface.co/api/models?limit=5&sort=downloads&direction=-1',
    spacing: 1500,
    fingerprint: (t) => JSON.parse(t).map((m) => m.id).join('|'),
  },
  {
    name: 'github_search',
    url: `https://api.github.com/search/repositories?q=${encodeURIComponent('topic:typescript stars:>500')}&sort=stars&order=desc&per_page=5`,
    headers: { accept: 'application/vnd.github+json' },
    spacing: 7000, // unauthenticated search limit is 10 req/min
    fingerprint: (t) => JSON.parse(t).items.map((x) => x.full_name).join('|'),
  },
];

const out = {};

for (const target of targets) {
  const r = { attempts: 0, ok: 0, statuses: {}, fingerprints: new Set(), latencies: [], errors: [] };
  for (let i = 0; i < N; i += 1) {
    const a = await attempt(target.url, target.headers ?? {});
    r.attempts += 1;
    r.statuses[a.status] = (r.statuses[a.status] ?? 0) + 1;
    r.latencies.push(a.ms);
    if (a.ok) {
      r.ok += 1;
      try { r.fingerprints.add(target.fingerprint(a.text)); }
      catch (e) { r.errors.push(`fingerprint: ${e.message}`); }
    } else if (a.error) {
      r.errors.push(a.error);
    }
    if (i < N - 1) await SLEEP(target.spacing);
  }
  const lat = r.latencies.slice().sort((x, y) => x - y);
  out[target.name] = {
    attempts: r.attempts,
    ok: r.ok,
    successRatePct: Math.round((r.ok / r.attempts) * 1000) / 10,
    statuses: r.statuses,
    distinctFingerprints: r.fingerprints.size,
    p50Ms: lat[Math.floor(lat.length / 2)],
    maxMs: lat[lat.length - 1],
    errors: r.errors.slice(0, 3),
  };
  console.error(`done ${target.name}: ${r.ok}/${r.attempts}`);
}

console.log(JSON.stringify(out, null, 2));
