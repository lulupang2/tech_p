# ADR-0013: Production deployment with Compose, GHCR, and SSH

- Status: **Accepted**
- Date: 2026-09-03
- Decision owner: repository owner (user-approved)

## Context

The application runs as separate API, web, and worker Node 22 containers. Production
needs a repeatable deployment path while keeping PostgreSQL on the already accepted
Neon Serverless Postgres topology. The production public hostname is
`signal.jisung.lol`.

## Decision drivers

- immutable, auditable image versions;
- a small operational footprint on one already managed host;
- explicit approval before production deployment;
- migration-before-rollout and a documented application rollback path;
- no credentials or host state in the repository.

## Alternatives

- **Docker Compose + GHCR + SSH**: low operational overhead and fits the existing
  container boundaries; requires careful host hardening and SSH key management.
- Managed container platform: stronger orchestration, but introduces a new hosting
  and networking decision outside the current scope.
- Host-local builds: avoids registry setup, but is not reproducible or auditable
  enough for production.

## Decision

Use GitHub Actions to build the API, web, and worker images and push them to GHCR.
Every production image is tagged with the immutable commit SHA (`sha-<40-char SHA>`).
The `production` GitHub Environment supplies approval and deployment secrets.

The deploy job connects over SSH using a pinned `known_hosts` value, copies the
versioned production Compose and Caddy snippet, and runs a host-side script. The
snippet is installed under the host Caddy include directory and the complete
server-owned configuration is validated before systemd Caddy is reloaded; the
existing Discord site configuration is never replaced.
That script pulls the exact SHA images, runs the database migration using
`DATABASE_URL_DIRECT`, then starts the stack with `docker compose up -d --wait`.
The Caddy reverse proxy terminates TLS for `signal.jisung.lol`, routes `/api/*` and
`/health/*` to `127.0.0.1:3000`, and routes the remaining traffic to
`127.0.0.1:5173`. Compose publishes only those loopback ports and does not own
host ports 80/443.

The host keeps the last successful image SHA. If post-rollout HTTPS health checks
fail, the script restores the previous application image and repeats the health
check. Database migrations are forward-only; an application rollback does not
attempt to reverse a migration and must be reviewed for schema compatibility.

## Consequences

- GHCR package access, SSH private key, host fingerprint, and the production env
  file remain outside GitHub repository contents.
- The single host must have Docker Compose v2, outbound GHCR access, inbound 80/443,
  systemd Caddy with an include directory, and a deployment user with the required
  `sudo` permissions.
- Caddy certificate issuance depends on DNS for `signal.jisung.lol` pointing to the
  host and ports 80/443 being reachable. This repository does not modify DNS or
  certificates.
- A one-host Compose rollout is not a multi-node zero-downtime deployment.

## Validation

- workflow YAML and production Compose configuration are parsed in CI/local static
  validation;
- image references are SHA-tagged and no production secret is committed;
- deployment performs host-Caddy validation/reload, migration-before-rollout, container
  health wait, HTTPS health check, concurrency serialization, and previous-SHA rollback.

## Status

Accepted by the user on 2026-09-03. This decision resolves the production hosting
and deployment adapter previously left open in `TASKS.md`.
