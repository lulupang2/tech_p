# Signal Archive Operational Runbook

This runbook defines the operational procedures, deployment topologies, container configurations, and troubleshooting workflows for the Signal Archive platform.

2026-09-10: ADR-0015 구현과 COV-008 검증 뒤 DEC-007 model 및 ADR-0016의 제한된 DEC-012
source/지출 범위가 승인됐고 COV-009 bounded live run을 완료했다. 새 실행·검증 상태는 TASKS COV 작업과 §12를 따른다.

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

2026-09-11 deployment preparation: production Compose enables the worker health listener
on port 3001 and the API checks it over the internal Compose network. Optional CI database
integration is enabled by `TECHPULSE_CI_ENABLE_INTEGRATION=true` after configuring an isolated
`DATABASE_URL`; secrets cannot be used directly in a GitHub job-level condition.

Production uses [ADR-0013](./adr/0013-production-deployment.md): GHCR images, Docker Compose, SSH, and the host-owned systemd Caddy snippet. A push to `main` starts the workflow, but the GitHub `production` Environment approval is required before the deploy job can run.

Required GitHub Environment secrets are `PRODUCTION_HOST`, `PRODUCTION_USER`, `PRODUCTION_SSH_KEY`, `PRODUCTION_KNOWN_HOSTS`, and `GHCR_READ_TOKEN`. The server must already contain `/opt/signal-archive/.env` with `DATABASE_URL`, `DATABASE_URL_DIRECT`, and the validated runtime/provider settings. No real `.env` is copied from CI.

The server must have Docker Compose v2, outbound GHCR access, inbound TCP 80/443, systemd Caddy configured to include `/etc/caddy/conf.d/*.caddy`, and a deployment user able to run Docker and the required `sudo` Caddy commands. The workflow copies only `compose.production.yaml`, the Caddy snippet, and the deployment script. The script uses the server-owned `.env` only through Docker's `--env-file` option; it never sources or prints that file. It validates and reloads the complete Caddy config, pulls `sha-<commit>` images, runs `DATABASE_URL_DIRECT` migrations before `docker compose up -d --wait`, and checks `https://signal.jisung.lol/health/live` over TLS. The previous successful SHA is recorded in `/opt/signal-archive/current-tag`; a failed health check attempts an application-image rollback. Forward-only migrations are never automatically reversed.

DNS and certificate status are observational checks only. Before approving the first deployment, verify that `signal.jisung.lol` resolves to the production host and that Caddy can obtain a publicly trusted certificate; the deployment changes only this site's included snippet and does not replace the host config or Discord route.

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
# 1. Seed or update all 12 supported sources with multi-target configurations (Bun, Node, Playwright, TS, React)
DATABASE_URL="$DATABASE_URL_DIRECT" pnpm --filter @techpulse/database run db:seed:mvp

# 2. 상태 확인
pnpm --filter @techpulse/api ops status

# 3. 변경 없이 수집 범위와 권한 확인 (dry-run)
pnpm --filter @techpulse/api ops collect \
  --source github_releases \
  --limit 50 \
  --dry-run

# 4. 실제 bounded 수집 (다중 타겟 순환 및 멱등키 보장)
# 4.1 GitHub Releases (Playwright, TypeScript, Node.js, Bun, React 순환)
pnpm --filter @techpulse/api ops collect \
  --source github_releases \
  --limit 50 \
  --idempotency-key collect-github-releases-2026-09-03

# 4.2 GitHub Search (TypeScript, Node.js, Bun, Playwright, React 쿼리 순환)
pnpm --filter @techpulse/api ops collect \
  --source github_search \
  --limit 30 \
  --idempotency-key collect-github-search-2026-09-03

# 4.3 Stack Exchange (TypeScript, Node.js, Bun, Playwright, React 태그 순환)
pnpm --filter @techpulse/api ops collect \
  --source stack_exchange \
  --limit 30 \
  --idempotency-key collect-stack-exchange-2026-09-03

# 4.4 npm Registry & Downloads (TypeScript, React, Playwright, bun-types 등)
pnpm --filter @techpulse/api ops collect \
  --source npm_registry \
  --limit 5 \
  --idempotency-key collect-npm-registry-2026-09-03

pnpm --filter @techpulse/api ops collect \
  --source npm_downloads \
  --limit 5 \
  --idempotency-key collect-npm-downloads-2026-09-03

# 4.5 React Blog (공식 블로그 RSS / CC-BY-4.0)
pnpm --filter @techpulse/api ops collect \
  --source react_blog \
  --limit 20 \
  --idempotency-key collect-react-blog-2026-09-03

# 4.6 Chrome Release Notes
pnpm --filter @techpulse/api ops collect \
  --source chrome_release_notes \
  --limit 10 \
  --idempotency-key collect-chrome-release-notes-2026-09-03

# 5. 실패 run의 정규화 단계만 replay
pnpm --filter @techpulse/api ops replay \
  --scope stage \
  --target <raw-or-run-id> \
  --idempotency-key replay-normalization-<target-id>

# 6. 최근 run과 단일 run 확인
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

## 12. Coverage cutover와 운영 gate

1. COV-001 contract manifest와 COV-002 migration을 검토하고 **빈 격리 PostgreSQL+pgvector**에서 forward 적용·기존 citation FK·rollback 동작을 확인한다. production DB에 자동 적용하지 않는다.
2. 기존 producer를 정지하고 old jobs를 drain하거나 DB 상태로 재계획한다. opaque multi-target cursor를 임의 복제하지 않는다. v2 ID-only delivery와 outbox 복구를 검증한 뒤 구버전 producer/consumer·export를 제거한다.
3. target은 기본 disabled로 등록한다. DISC-003의 최신 권리/capability 근거와 DEC-012의 cadence/byte/API/token/spend/retention 적용 범위가 있어야 활성화한다. 초기 90일은 retention 기간이 아니다.
4. backfill 계획은 dry-run으로 target·기간·page/request 예산·history unsupported/partial을 먼저 확인한다. 실행 중 checkpoint·outbox 미완료·source quota를 확인하고 중단 후 재개한다. incremental 예산은 별도 유지한다.
5. embedding calling 이후 장애는 outcome_unknown과 예약 금액을 확인한다. provider 공식 조회/idempotency 없이는 자동 재호출하지 않으며 사용자 확인 없는 비용 재시도를 하지 않는다.
6. worker health는 scheduler/outbox 진전·stage consumer 생존을 관측한다. 기존 `process.exit(0)` healthcheck는 업무 정상 증빙이 아니다.
7. 로컬 정상 동작 증거는 실제 PG+Redis와 실제 app 프로세스, fixture HTTP source·fake model을 사용한다. 이것은 유료 provider·실제 corpus 품질 증빙과 별개다.
8. 실제 모델/source 실행은 DEC-007/DEC-012 승인 뒤 COV-009에서 수행한다. COV-010과 EVAL-002 기준 미달이면 MVP 출시 완료로 표시하지 않는다.

### 12.1 DEC-012 승인값 (2026-09-10)

- allowlist: `microsoft/TypeScript`, `nodejs/node`, `microsoft/playwright`, `facebook/react`,
  `pgvector/pgvector`의 GitHub Releases만 허용한다.
- target당 1 page canary를 먼저 확인한 뒤 최근 90일 backfill을 concurrency 1로 실행한다.
- incremental은 6시간 ±15분 jitter, concurrency 1이다.
- API 200/day·1,000 total, bytes 25 MiB/day·250 MiB total, provider spend USD 2 total을 넘으면
  중지한다. On-demand acquisition은 끈다.
- retention purge는 120/365/30/14일 분류를 dry-run하고 citation dependency와 backup을 확인한
  뒤에만 별도 irreversible 단계로 수행한다.
- AI-002 contract와 COV-009 live model lane 검증은 완료됐다. 실제 credential은 로컬 env로만 주입했고
  sanitized measurement는 `docs/experiments/cov-009/live-measurement.json`에 고정했다.

### 12.2 COV-009 실측 결과 (2026-09-10)

- 연결된 PostgreSQL+pgvector와 Redis를 사용했으며 Docker 서비스나 기존 volume/data 변경은 없었다.
- 5개 target의 backfill/incremental 10개 partition이 모두 완료됐다. on-demand, partial, failed, cancelled는 0이다. `pgvector/pgvector`는 90일 retained release 0건으로 coverage gap이다.
- worker 재시작 뒤 pending outbox를 복구해 500 chunks/500 embeddings와 pending delivery 0을 확인했다.
- GitHub usage는 11 requests/1,274,586 bytes, embedding usage는 188,073 tokens/USD 0.000912다.
- DEC-013은 승인됐으며 고정 corpus의 품질/성능 threshold는 ADR-0018을 따른다. 실험 완료와 gate 통과를 구분한다.

새 ops 명령은 COV-001 manifest→COV-008 구현·smoke 이후 이 절에 실행 가능한 명령으로 등록한다. 현재 문서의 절차를 아직 존재하지 않는 CLI가 구현됐다는 주장으로 읽지 않는다.

### 12.3 EVAL-002 실행과 누적 예산 차단

실제 구현된 평가 CLI와 모드는 [EVAL-002 README](./experiments/eval-002/README.md)를 따른다. credential-free 계획은 `pnpm --filter @techpulse/api exec node --import=tsx/esm src/release-evaluation-cli.ts --mode=plan`으로 생성한다. 실제 DB preflight/FTS 진단과 유료 live 평가를 혼동하지 않는다.

2026-09-10 과거 recording 감사에서 query embedding 최소 195회/6,290 tokens를 확인했다. 승인 call cap 100회를 넘었으므로 live 실행은 `release_budget_exhausted`로 차단된다. chat/총비용과 정확한 전체 usage는 여전히 unknown이다. `prior-usage.json`을 0으로 바꾸거나 journal을 새로 만들어 allowance를 복구하지 않는다. 추가 호출은 명시적 신규/변경 승인과 역사 사용량 보존을 요구한다. lock·미완료 reservation·잘린 journal은 자동 복구/환불하지 않는다.

43개 회귀, 필수 예시 4개, live 라벨 및 의미적 인용 검토와 COV-010 acceptance가 없으면 EVAL-002/COV-010/MVP를 완료로 표시하지 않는다.
