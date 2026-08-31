// EXP-005: contract gate. Boots a server, runs identical checks, prints JSON.
// Usage: node contract-gate.mjs elysia-server.mjs elysia
//        node contract-gate.mjs fastify-server.mjs fastify
import { spawn } from 'node:child_process';
import net from 'node:net';

const [scriptPath, label] = process.argv.slice(2);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function boot(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`boot timeout. stdout=${buf}`)); }
    }, 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (/READY/.test(buf) && !settled) { settled = true; clearTimeout(t); resolve({ child, port }); }
    });
    child.stderr.on('data', (d) => { buf += d.toString(); });
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(t); reject(new Error(`exited ${code}. output=${buf}`)); }
    });
  });
}

async function req(base, path, init) {
  const res = await fetch(base + path, init);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const out = { framework: label, checks: {}, errors: [] };

let child;
try {
  const port = await freePort();
  const booted = await boot(port);
  child = booted.child;
  const base = `http://127.0.0.1:${booted.port}`;
  out.port = booted.port;

  const health = await req(base, '/health/live');
  out.checks.health = health.status;

  const valid = await req(base, '/api/v1/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Playwright 최근 업데이트', language: 'ko' }),
  });
  out.checks.validRequestStatus = valid.status;
  out.checks.validResponseKeys = valid.body ? Object.keys(valid.body).sort() : null;

  const missing = await req(base, '/api/v1/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'ko' }),
  });
  out.checks.missingRequiredField = missing.status;

  const badEnum = await req(base, '/api/v1/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x', language: 'jp' }),
  });
  out.checks.invalidEnum = badEnum.status;

  const emptyQuestion = await req(base, '/api/v1/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: '' }),
  });
  out.checks.emptyStringMinLength = emptyQuestion.status;

  const extra = await req(base, '/api/v1/answers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x', unknownField: 'should be rejected or stripped' }),
  });
  out.checks.unknownRequestFieldStatus = extra.status;

  const strictExtra = await req(base, '/api/v1/answers-strict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x', unknownField: 'must be rejected' }),
  });
  out.checks.strictUnknownFieldStatus = strictExtra.status;

  const strictValid = await req(base, '/api/v1/answers-strict', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x' }),
  });
  out.checks.strictValidStatus = strictValid.status;

  const leak = await req(base, '/api/v1/answers-leak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  out.checks.leakProbeStatus = leak.status;
  out.checks.leakedInternalFields = leak.body
    ? Object.keys(leak.body).filter((k) => k.startsWith('_'))
    : null;

  // OpenAPI document discovery
  const candidates = ['/openapi.json', '/openapi/json', '/openapi', '/swagger/json', '/doc/json'];
  let doc = null;
  let docPath = null;
  for (const c of candidates) {
    const r = await req(base, c);
    if (r.status === 200 && r.body && (r.body.openapi || r.body.swagger || r.body.paths)) {
      doc = r.body; docPath = c; break;
    }
  }
  out.checks.openapiPath = docPath;
  if (doc) {
    const p = doc.paths?.['/api/v1/answers'];
    out.checks.openapiHasAnswersPath = Boolean(p);
    const reqSchema = JSON.stringify(p?.post?.requestBody ?? {});
    out.checks.openapiRequestMentionsQuestion = reqSchema.includes('question');
    out.checks.openapiRequestMentionsMinLength = reqSchema.includes('minLength');
    const resSchema = JSON.stringify(p?.post?.responses ?? {});
    out.checks.openapiResponseMentionsCitations = resSchema.includes('citations');
    out.checks.openapiResponseMentionsExcerptFlag = resSchema.includes('excerptIsVerbatim');
  } else {
    out.checks.openapiHasAnswersPath = false;
  }
} catch (e) {
  out.errors.push(e.message);
} finally {
  if (child) child.kill();
}

console.log(JSON.stringify(out, null, 2));
