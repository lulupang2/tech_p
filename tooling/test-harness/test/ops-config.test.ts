import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT_DIR = resolve(__dirname, '../../..');

function readRootFile(relativePath: string): string {
  const fullPath = resolve(ROOT_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Expected file does not exist: ${relativePath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

describe('OPS-001 Docker and Compose Configuration', () => {
  const appNames = ['api', 'web', 'worker'] as const;

  describe('Dockerfiles', () => {
    it.each(appNames)('apps/%s/Dockerfile exists and is non-root multi-stage', (appName) => {
      const dockerfilePath = `apps/${appName}/Dockerfile`;
      const content = readRootFile(dockerfilePath);

      // Node version pinned to 22 LTS
      expect(content).toMatch(/FROM\s+node:22(-alpine|-slim)?/u);

      // Multi-stage build
      expect(content).toMatch(/AS\s+base/u);
      expect(content).toMatch(/AS\s+builder/u);
      expect(content).toMatch(/AS\s+runner/u);

      // Non-root user execution
      expect(content).toMatch(/USER\s+node/u);

      // Graceful shutdown signal
      expect(content).toMatch(/STOPSIGNAL\s+SIGTERM/u);

      // Healthcheck defined
      expect(content).toMatch(/HEALTHCHECK\s+/u);

      // No hardcoded secret tokens or sensitive keys
      expect(content).not.toMatch(/ghp_[a-zA-Z0-9]+/u);
      expect(content).not.toMatch(/hf_[a-zA-Z0-9]+/u);
      expect(content).not.toMatch(/sk-[a-zA-Z0-9]+/u);
      expect(content).not.toMatch(/AI_CHAT_API_KEY=\S+/u);
      expect(content).not.toMatch(/EMBEDDING_API_KEY=\S+/u);
    });

    it('exposes standard ports on api and web Dockerfiles', () => {
      const apiDockerfile = readRootFile('apps/api/Dockerfile');
      const webDockerfile = readRootFile('apps/web/Dockerfile');

      expect(apiDockerfile).toMatch(/EXPOSE\s+3000/u);
      expect(webDockerfile).toMatch(/EXPOSE\s+5173/u);
    });
  });

  describe('compose.yaml Specification', () => {
    it('contains all required services with profiles and healthchecks', () => {
      const composeContent = readRootFile('compose.yaml');

      // Infrastructure services
      expect(composeContent).toContain('postgres-persistent:');
      expect(composeContent).toContain('redis-persistent:');
      expect(composeContent).toContain('postgres-ephemeral:');
      expect(composeContent).toContain('redis-ephemeral:');

      // Application services
      expect(composeContent).toContain('api:');
      expect(composeContent).toContain('worker:');
      expect(composeContent).toContain('web:');

      // Profiles
      expect(composeContent).toMatch(/profiles:\s*\[.*persistent.*\]/u);
      expect(composeContent).toMatch(/profiles:\s*\[.*ephemeral.*\]/u);
      expect(composeContent).toMatch(/profiles:\s*\[.*stack.*\]/u);

      // Healthchecks
      expect(composeContent).toContain('healthcheck:');
      expect(composeContent).toContain('pg_isready');
      expect(composeContent).toContain('redis-cli');

      // Signal handling and graceful shutdown
      expect(composeContent).toContain('stop_signal: SIGTERM');
      expect(composeContent).toContain('stop_grace_period: 15s');

      // Dependency ordering
      expect(composeContent).toContain('condition: service_healthy');

      // Network aliases
      expect(composeContent).toContain('aliases:');
      expect(composeContent).toContain('- postgres');
      expect(composeContent).toContain('- redis');
    });

    it('labels local dev credentials clearly as unsafe', () => {
      const composeContent = readRootFile('compose.yaml');
      expect(composeContent).toContain('unsafe-local-development-only');
    });
  });

  describe('Operational Runbook & Environment Template', () => {
    it('docs/RUNBOOK.md exists and covers all operational requirements', () => {
      const runbookContent = readRootFile('docs/RUNBOOK.md');

      // One-command stack
      expect(runbookContent).toContain('docker compose --profile stack up -d --wait');

      // Profiles documented
      expect(runbookContent).toContain('--profile persistent');
      expect(runbookContent).toContain('--profile ephemeral');

      // Non-root security documented
      expect(runbookContent).toContain('Non-Root Execution');
      expect(runbookContent).toContain('USER node');

      // Neon vs Local fallback separation
      expect(runbookContent).toContain('DATABASE_URL');
      expect(runbookContent).toContain('DATABASE_URL_DIRECT');
      expect(runbookContent).toContain('Neon Serverless Postgres');

      // Browser collector runtime requirements
      expect(runbookContent).toContain('Browser Collector');
      expect(runbookContent).toContain('Playwright');
      expect(runbookContent).toContain('Node.js 22 LTS');

      // Secret rotation procedure
      expect(runbookContent).toContain('Secret Rotation');
    });

    it('.env.example exists and documents external Neon vs local Docker fallback', () => {
      const envExample = readRootFile('.env.example');

      expect(envExample).toContain('DATABASE_URL');
      expect(envExample).toContain('DATABASE_URL_DIRECT');
      expect(envExample).toContain('REDIS_URL');
      expect(envExample).toContain('Neon Serverless Postgres');
      expect(envExample).toContain('Local Docker Fallback');
      expect(envExample).toContain('OPENAI_API_KEY');
      expect(envExample).toContain('EMBEDDING_API_KEY');
    });
  });
});

describe('OPS-004 production deployment configuration', () => {
  it('defines SHA-tagged GHCR images and TLS reverse proxy routing', () => {
    const compose = readRootFile('compose.production.yaml');
    const caddy = readRootFile('Caddyfile');

    expect(compose).toContain('image: ${IMAGE_PREFIX}/api:${IMAGE_TAG}');
    expect(compose).toContain('image: ${IMAGE_PREFIX}/web:${IMAGE_TAG}');
    expect(compose).toContain('image: ${IMAGE_PREFIX}/worker:${IMAGE_TAG}');
    expect(compose).toContain("'127.0.0.1:3000:3000'");
    expect(compose).toContain("'127.0.0.1:5173:5173'");
    expect(compose).toContain('__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: signal.jisung.lol');
    expect(compose).not.toContain('caddy:');
    expect(compose).not.toContain("'80:80'");
    expect(compose).not.toContain("'443:443'");
    expect(compose).toContain('condition: service_healthy');
    expect(caddy).toContain('signal.jisung.lol');
    expect(caddy).toContain('reverse_proxy 127.0.0.1:3000');
    expect(caddy).toContain('reverse_proxy 127.0.0.1:5173');
  });

  it('defines approval, pinned SSH host verification, migration, health, rollback, and concurrency', () => {
    const workflow = readRootFile('.github/workflows/deploy-production.yml');
    const script = readRootFile('.github/scripts/deploy-production.sh');

    expect(workflow).toContain('name: production');
    expect(workflow).toContain('PRODUCTION_KNOWN_HOSTS');
    expect(workflow).toContain('StrictHostKeyChecking=yes');
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('docker/build-push-action@v6');
    expect(workflow).toContain('sha-${{ github.sha }}');
    expect(script).toContain('DATABASE_URL_DIRECT');
    expect(script).toContain('db:migrate');
    expect(script).toContain('https://signal.jisung.lol/health/live');
    expect(script).toContain('previous_tag');
    expect(script).toContain('docker compose --env-file "$ENV_FILE"');
    expect(script).toContain('docker run --rm --env-file "$ENV_FILE"');
    expect(script).toContain('caddy validate');
    expect(script).toContain('systemctl reload caddy');
    expect(script).toContain('CADDY_SNIPPET_PATH');
    expect(script).toContain('sudo install -D -m 644');
    expect(script).not.toMatch(/source\s+.*\.env/u);
  });
});
