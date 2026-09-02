# TechPulse Operational Runbook

This runbook defines the operational procedures, deployment topologies, container configurations, and troubleshooting workflows for the TechPulse platform.

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

All TechPulse container images follow strict security and production-readiness standards:

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

Per **ADR-0011** and **DATABASE.md §5**, TechPulse uses a strict separation between hosted production (Neon) and local development (Docker Compose):

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
