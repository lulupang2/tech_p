# Signal Archive Operational Runbook

This runbook defines the operational procedures, deployment topologies, container configurations, and troubleshooting workflows for the Signal Archive platform.

---

## 1. Quickstart: One-Command Local Stack

### 1.1 Prerequisites
- **Node.js**: `>= 22.0.0` (pinned LTS, see `package.json` engines)
- **pnpm**: `10.32.1` (`corepack enable && corepack prepare pnpm@10.32.1 --activate`)
- **Docker & Docker Compose**: Compose v2.20+ / v5+

### 1.2 Full Application Stack (One Command)
To launch all services (`api`, `web`, `worker`, `postgres`, `redis`) with healthchecks and automatic dependency ordering:

```bash
# 1. Clone repository and setup local environment
cp .env.example .env

# 2. Start full local stack with health wait
docker compose --profile stack up -d --wait
# If provider credentials are stored in the local worker env file, use it for
# Compose interpolation without committing or copying the secret:
# docker compose --env-file apps/worker/.env --profile stack up -d --wait


# 3. Apply database migrations
pnpm --filter @techpulse/database run db:migrate

# 4. Verify service availability
curl -s http://127.0.0.1:3000/health/ready | jq .
curl -s http://127.0.0.1:5173/ | head -n 10
```

### 1.3 Local Dependency Stack (Development Mode)
When running application code locally via `pnpm dev` while using containerized infrastructure:

```bash
# Option A: Persistent database & Redis (named volume survives container stop)
docker compose --profile persistent up -d --wait

# Option B: Ephemeral database & Redis (tmpfs/in-memory, clean slate every run)
docker compose --profile ephemeral up -d --wait

# Run local development processes
pnpm --filter @techpulse/api start
pnpm --filter @techpulse/worker start
pnpm --filter @techpulse/web dev
```

---

## 2. Architecture & Service Topology

```
+-------------------------------------------------------------------------------+
|                               Docker Compose Stack                            |
|                                                                               |
|  +------------------+     +------------------+     +-----------------------+  |
|  |     web (UI)     | --> |    api (HTTP)    | --> | postgres (pgvector)   |  |
|  |  (Port: 5173)    |     |  (Port: 3000)    |     | (Port: 5432)          |  |
|  |  SvelteKit       |     |  Elysia on Node  |     | PostgreSQL 17         |  |
|  +------------------+     +------------------+     +-----------------------+  |
|                                     |                         ^               |
|                                     v                         |               |
|                           +------------------+                |               |
|                           |  worker (Jobs)   | ---------------+               |
|                           |  BullMQ on Node  |                                |
|                           +------------------+                                |
|                                     |                                         |
|                                     v                                         |
|                           +------------------+                                |
|                           |  redis (Queue)   |                                |
|                           |  (Port: 6379)    |                                |
|                           |  Redis 7.4       |                                |
|                           +------------------+                                |
+-------------------------------------------------------------------------------+
```

### Service Summary

| Service | Technology | Port | Profile | Healthcheck | Primary Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`api`** | Elysia on Node 22 | `3000` | `stack`, `full`, `api` | `GET /health/live`, `/health/ready` | Public API & RAG query serving |
| **`web`** | SvelteKit (Vite) | `5173` | `stack`, `full`, `web` | `GET /` | Web UI frontend |
| **`worker`** | BullMQ on Node 22 | N/A | `stack`, `full`, `worker` | Process check | Asynchronous data collection & pipeline |
| **`postgres`** | PostgreSQL 17 + pgvector | `5432` | `persistent`, `stack`, `ephemeral` | `pg_isready` + pgvector check | Relational & vector data storage |
| **`redis`** | Redis 7.4 Alpine | `6379` | `persistent`, `stack`, `ephemeral` | `redis-cli ping` | Distributed job queue & rate limiter |

---

## 3. Container Security & Image Design

All Signal Archive container images follow strict security and production-readiness standards:

1. **Non-Root Execution**:
   - All runtime images run under unprivileged user `USER node` (UID/GID 1000).
   - Container root filesystem permissions are restricted; only `/app` is owned by `node:node`.

2. **Multi-Stage Build Pipeline**:
   - **`base`**: Minimal Node 22 Alpine base image with Corepack and pnpm.
   - **`builder`**: Full workspace dependency resolution with frozen lockfile (`pnpm install --frozen-lockfile`) and TypeScript compilation.
   - **`runner`**: Clean runtime stage copying only necessary build artifacts and production dependencies.

3. **No Secret Baking**:
   - Dockerfiles contain **ZERO** secret values, tokens, or default passwords.
   - All credentials and sensitive connection strings must be injected at runtime via environment variables or secret managers.

4. **Graceful Shutdown**:
   - All containers configure `STOPSIGNAL SIGTERM`.
   - Docker Compose specifies `stop_grace_period: 15s`.
   - Node processes handle `SIGTERM` / `SIGINT` to gracefully finish in-flight requests, drain worker jobs, and close database/Redis pools before exiting.

---

## 4. Database Connection Strategy: Neon vs. Local Fallback

Per **ADR-0011** and **DATABASE.md §5**, Signal Archive uses a strict separation between hosted production (Neon) and local development (Docker Compose):

```
+------------------------------------------------------------------------------+
| Production / Staging (Neon Serverless Postgres)                              |
|   DATABASE_URL        -> Pooled Connection (e.g. ep-xyz-pooler.neon.tech)   |
|   DATABASE_URL_DIRECT -> Direct Connection (e.g. ep-xyz.neon.tech)          |
|   TLS Requirement     -> sslmode=require (Mandatory)                         |
+------------------------------------------------------------------------------+
| Local Development (Docker Compose pgvector)                                  |
|   DATABASE_URL        -> postgresql://techpulse_dev_unsafe:...@localhost:5432|
|   DATABASE_URL_DIRECT -> postgresql://techpulse_dev_unsafe:...@localhost:5432|
|   TLS Requirement     -> Disable or local plaintext                          |
+------------------------------------------------------------------------------+
```

### Migration Execution
- Migrations (`drizzle-orm` / `drizzle-kit`) require direct connection access for schema DDL operations:
  ```bash
  # Local:
  DATABASE_URL=$DATABASE_URL_DIRECT pnpm --filter @techpulse/database run db:migrate

  # Remote / Neon:
  DATABASE_URL="postgresql://<user>:<password>@<direct-host>/<db>?sslmode=require" \
    pnpm --filter @techpulse/database run db:migrate
  ```

---

## 5. Browser Collector & Runtime Requirements

Per **ADR-0001**, **ADR-0004**, and **SSOT §3**:

- **Runtime Target**: Node.js 22 LTS (Bun was rejected in EXP-005 due to Playwright transport failures).
- **Collector Architecture**: `@techpulse/collectors` defines zero-dependency structural interfaces for Playwright (`chrome-origin-trials`).
- **Headless Browser Execution**:
  - When running browser collectors inside containers or CI runners, install browser dependencies:
    ```bash
    pnpm exec playwright install --with-deps chromium
    ```
  - For containerized headless Chromium, ensure necessary shared libraries (`libnss3`, `libatk-1.0-0`, `libx11-xcb1`) are present if running in Debian/Ubuntu base images, or use the official Playwright base image for dedicated browser worker tasks.

---

## 6. Operational Procedures

### 6.0 Production deployment (`signal.jisung.lol`)

Production uses [ADR-0012](./adr/0012-production-deployment.md): GHCR images, Docker Compose, SSH, and Caddy. A push to `main` starts the workflow, but the GitHub `production` Environment approval is required before the deploy job can run.

Required GitHub Environment secrets are `PRODUCTION_HOST`, `PRODUCTION_USER`, `PRODUCTION_SSH_KEY`, `PRODUCTION_KNOWN_HOSTS`, and `GHCR_READ_TOKEN`. The server must already contain `/opt/signal-archive/.env` with `DATABASE_URL`, `DATABASE_URL_DIRECT`, and the validated runtime/provider settings. No real `.env` is copied from CI.

The server must have Docker Compose v2, outbound GHCR access, inbound TCP 80/443, and a deployment user able to run Docker. The workflow copies only `compose.production.yaml`, `Caddyfile`, and the deployment script. It pulls `sha-<commit>` images, runs `DATABASE_URL_DIRECT` migrations before `docker compose up -d --wait`, and checks `https://signal.jisung.lol/health/live` over TLS. The previous successful SHA is recorded in `/opt/signal-archive/current-tag`; a failed health check attempts an application-image rollback. Forward-only migrations are never automatically reversed.

DNS and certificate status are observational checks only. Before approving the first deployment, verify that `signal.jisung.lol` resolves to the production host and that Caddy can obtain a publicly trusted certificate; do not change DNS, certificates, or server configuration from this repository.

### 6.1 Starting the Stack
```bash
# Start all services in background with health validation
docker compose --profile stack up -d --wait
```

### 6.2 Inspecting Service Health & Logs
```bash
# View status of running containers
docker compose --profile stack ps

# Stream logs for a specific service
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f web

# Check API health endpoint
curl -i http://localhost:3000/health/ready
```

### 6.3 Stopping the Stack
```bash
# Graceful stop of all services
docker compose --profile stack down

# Stop persistent dependencies (preserves database data)
docker compose --profile persistent down

# Stop persistent dependencies and DELETE volumes (fresh reset)
docker compose --profile persistent down --volumes
```

### 6.4 Secret Rotation Procedure
1. Update secrets in secure storage / environment configuration (`.env` or secret manager).
2. For database password rotation on Neon:
   - Generate new credentials in Neon console.
   - Update `DATABASE_URL` and `DATABASE_URL_DIRECT`.
   - Perform rolling restart of API and Worker services.
   - Verify health via `curl http://localhost:3000/health/ready`.
3. For LLM API key rotation:
   - Update `OPENAI_API_KEY` or `EMBEDDING_API_KEY`.
   - Restart API service: `docker compose restart api`.

---

## 7. Troubleshooting & Common Issues

| Symptom | Probable Cause | Resolution |
| :--- | :--- | :--- |
| **`failed to connect to docker API`** | Docker daemon / Docker Desktop is not running. | Start Docker Desktop or Docker service on host. If running tests without Docker, unit tests will execute and integration tests will safely skip. |
| **API `/health/ready` returns 503** | PostgreSQL database unreachable or pgvector extension missing. | Check `DATABASE_URL`, verify `postgres` container is healthy (`docker compose ps`), and ensure migrations ran (`pnpm --filter @techpulse/database run db:migrate`). |
| **Worker fails on startup with `REDIS_URL is required`** | Redis container not running or URL malformed. | Verify `REDIS_URL=redis://localhost:6379` (or `redis://redis:6379` inside Compose network). |
| **CORS errors in Web UI** | Web origin not listed in API CORS configuration. | Update `CORS_ALLOWED_ORIGINS` to include `http://localhost:5173` or client URL. |
| **Port conflict on 3000 / 5173 / 5432** | Another process is binding the port on host. | Change `PORT` in `.env` or stop conflicting local service. |

---

## 8. Collection and Replay

운영 변경 명령은 public API와 분리된 operations API를 사용하며 `OPS_API_KEY`가 필요하다. 비밀값을 명령행 인자나 shell history에 남기지 말고 환경 변수 또는 secret manager로 주입한다.

```bash
# 상태 확인
pnpm --filter @techpulse/api ops status

# 변경 없이 수집 범위와 권한 확인
pnpm --filter @techpulse/api ops collect \
  --source github_releases \
  --limit 50 \
  --dry-run

# 실제 bounded 수집
pnpm --filter @techpulse/api ops collect \
  --source github_releases \
  --limit 50 \
  --idempotency-key collect-github-releases-2026-09-02

# 실패 run의 정규화 단계만 replay
pnpm --filter @techpulse/api ops replay \
  --scope stage \
  --target <raw-or-run-id> \
  --idempotency-key replay-normalization-<target-id>

# 최근 run과 단일 run 확인
pnpm --filter @techpulse/api ops runs --limit 20
pnpm --filter @techpulse/api ops run <run-id>
```

- `--limit`은 1~500으로 제한한다.
- mutation은 idempotency key를 재사용해 중복 dispatch를 막는다.
- disabled source는 먼저 정책·권리 상태를 확인한다. `source enable`은 tombstone과 재색인 영향을 검토한 뒤 실행한다.
- replay는 기존 raw item, document revision, citation을 덮어쓰지 않는다.

## 9. Query and Evaluation

### 9.1 Public query smoke

```bash
curl -sS http://127.0.0.1:3000/api/v1/answers \
  -H 'content-type: application/json' \
  --data '{
    "question": "최근 한 달간 Bun과 Node.js의 관심 변화를 비교해줘.",
    "timezone": "Asia/Seoul",
    "language": "ko"
  }'
```

응답에서 `status`, `resolvedTimeRange`, `coverage.dataFreshThrough`, `citations[].documentRevisionId`, 원 source URL을 확인한다. `insufficient_evidence`는 정상적인 200 응답이며 운영자가 임의 답변으로 대체하지 않는다.

### 9.2 Deterministic and browser gates

```bash
pnpm run static
pnpm run test
pnpm --filter @techpulse/web test:e2e:install
pnpm --filter @techpulse/web test:e2e

```

RAG evaluation은 `docs/EVAL_GOLDEN_SET.md`의 고정 질문·라벨과 `@techpulse/rag` 평가 명령을 사용하며 결과에 commit, model, config, dataset version을 기록한다.

Playwright UI E2E는 Chromium, retry 0, 결정적 API/fake-model fixture를 사용한다. 실제 provider 평가는 blocking PR suite와 분리하며 `TECHPULSE_EVAL_PAID_LLM=true`인 승인된 수동 실행에서만 수행한다.

## 10. Backup, Restore, Retention, and Tombstone

### 10.1 Backup

공유 production branch가 아닌 승인된 대상과 UTC timestamp가 포함된 파일명을 사용한다.

```bash
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file signal-archive-<UTC_TIMESTAMP>.dump \
  \"$DATABASE_URL_DIRECT\"
```

백업 파일을 repository, CI artifact, 일반 로그에 업로드하지 않는다. 암호화된 전용 저장소에 보관하고 checksum과 보존 만료일을 함께 기록한다.

### 10.2 Restore drill

빈 격리 database를 준비하고 그 연결 문자열만 `RESTORE_DATABASE_URL`에 설정한다. 기존 database 위에 복원하지 않는다.

```bash
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --dbname \"$RESTORE_DATABASE_URL\" \
  signal-archive-<UTC_TIMESTAMP>.dump
```

복원 후 migration hash, pgvector extension, source/document/revision/chunk 수, citation FK를 확인한다. 검증이 끝나기 전에는 복원 database를 production endpoint로 승격하지 않는다.

### 10.3 Retention and source removal

1. retention 대상 수와 기간을 dry-run으로 확인한다.
2. 보존 대상 raw/revision/citation이 참조 중인지 확인한다.
3. source 정책 변경 시 source를 disable하고 검색 제외 tombstone을 먼저 생성한다.
4. 재색인·citation 영향과 audit event를 확인한다.
5. irreversible purge는 별도 승인과 백업 확인 뒤 실행한다.

## 11. Known Limits

- GitHub repository attention은 수집 시작 이전 기간을 backfill할 수 없다.
- 외부 source의 rate limit·지연으로 freshness가 낮아질 수 있으며 이를 0으로 대체하지 않는다.
- provider credential이 없으면 live chat/embedding 평가를 실행할 수 없다. 결정적 fake 기반 테스트 통과를 live provider 검증으로 해석하지 않는다.
- PostgreSQL integration test는 `DATABASE_URL`이 없으면 skip된다. skip은 통과 증빙이 아니다.
- Stack Exchange는 `verbatim_only`이며 허용된 발췌와 귀속 없이 재서술하지 않는다.
- 자동 provider fallback은 없다. 모델 변경은 명시적 평가와 embedding 재색인을 요구한다.
