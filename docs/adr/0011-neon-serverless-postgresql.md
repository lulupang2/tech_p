# ADR-0011: Serverless Neon PostgreSQL runtime and connection strategy

- 상태: Accepted
- 작성일: 2026-09-02
- 승인일: 2026-09-02
- 승인 주체: 사용자
- 결정: PostgreSQL + pgvector의 authoritative business store는 유지하되, 공유·운영 환경의 관리형 PostgreSQL 제공자를 Neon Serverless Postgres로 사용한다. Drizzle ORM과 Drizzle Kit은 그대로 유지한다. Node 기반 API·worker는 Neon의 pooled connection endpoint를 일반 쿼리에 사용하고, 여러 문장을 하나의 원자적 작업으로 묶어야 하는 짧은 transaction에는 Neon의 Node 호환 WebSocket `Pool`/`Client` 경로를 사용한다. migration은 pooled endpoint가 아닌 Neon direct endpoint에 대해 Drizzle Kit의 커밋된 forward-only migration을 적용한다.

## Context

Signal Archive는 raw item, immutable document revision, citation provenance, metric observation을 PostgreSQL + pgvector에 보존한다. [ADR-0009](./0009-drizzle-orm-migrations.md)가 `packages/database`의 Drizzle ORM·Drizzle Kit과 검토 가능한 SQL migration을 이미 승인했으므로, 이번 결정은 ORM이나 데이터 권위를 바꾸지 않고 PostgreSQL 실행·연결 경로만 정한다.

운영 DB를 직접 관리하는 Docker PostgreSQL로 고정하면 백업, compute 확장, connection 관리와 운영 부담이 포트폴리오 MVP의 범위를 넘어선다. 반면 serverless 환경에서는 요청·job 실행 단위가 짧고 동시성이 변동하므로 연결을 무제한으로 만들거나 세션 상태를 전제로 한 ORM 사용은 안전하지 않다.

로컬 재현성과 통합 테스트는 계속 Docker의 실제 PostgreSQL + pgvector를 사용한다. Neon은 공유·운영 환경의 PostgreSQL provider이며, 로컬 Docker를 대체하지 않는다.

## Decision drivers

- PostgreSQL + pgvector, transaction, jsonb, full-text search와 제약을 authoritative store로 유지할 것
- 기존 Drizzle schema·repository 경계와 Drizzle Kit migration 이력을 보존할 것
- serverless 동시성에서 connection 폭증과 유휴 연결을 피할 것
- transaction이 필요한 publish, idempotency, provenance 변경의 원자성을 보존할 것
- migration credential과 runtime credential을 분리하고 secret을 로그·번들에 노출하지 않을 것
- 빈 DB, 기존 DB forward migration, pgvector 검색과 transaction을 자동 검증할 수 있을 것

## Alternatives

### Neon Serverless Postgres

- 장점: 관리형 PostgreSQL, scale-to-zero/autoscaling 선택지, branching과 pooled endpoint를 제공해 MVP 운영 부담과 연결 관리 부담을 줄인다. PostgreSQL + pgvector authority와 Drizzle 경계를 유지할 수 있다.
- 단점: provider endpoint와 serverless driver 방식에 의존한다. pooled transaction mode에서는 session 상태·세션 변수·prepared statement를 전제로 한 코드가 제한되며, 네트워크 단절과 cold start를 관측·재시도해야 한다.

### 직접 운영하는 Docker/PostgreSQL

- 장점: 연결, extension, 백업, 네트워크와 버전을 전부 통제하고 로컬·운영 구성이 가깝다.
- 단점: 운영 인프라·백업·복구·가용성 책임이 커지고, 서버리스 배포와 연결 수명 관리가 별도 과제가 된다.

### 다른 관리형 PostgreSQL

- 장점: PostgreSQL 호환성과 운영형 백업·가용성 옵션을 제공한다.
- 단점: 이 결정에서 필요한 serverless branching·pooled endpoint의 운영 모델을 기준으로 비교·검증해야 하며, provider를 추가로 선택하면 현재 승인 범위를 넓힌다.

## Recommendation

Neon Serverless Postgres를 공유·운영 PostgreSQL provider로 채택한다. 데이터 모델과 권위는 PostgreSQL + pgvector에 남고, Drizzle ORM·Drizzle Kit 사용 규칙은 [ADR-0009](./0009-drizzle-orm-migrations.md)를 따른다.

### Runtime and connection behavior

1. `packages/database`만 Neon driver와 connection 설정을 소유한다. domain port에는 Drizzle type, Neon client, connection string을 노출하지 않는다.
2. Node API·worker의 일반 단일 쿼리는 Neon pooled endpoint를 사용한다. process마다 무제한 client를 만들지 않고, bounded pool/driver 설정과 종료 시 정리 절차를 둔다.
3. 여러 쓰기와 상태 전환이 함께 성공하거나 실패해야 하는 작업은 짧은 transaction으로 실행한다. 이 경로는 Node 호환 WebSocket `Pool`/`Client`를 사용하고 transaction callback 안에서만 query를 수행한다. transaction 도중 queue·외부 API·LLM을 기다리거나 장기 세션을 유지하지 않는다.
4. HTTP 기반 stateless query 경로는 단일 독립 쿼리 또는 transaction이 필요 없는 읽기에만 사용한다. publish, idempotency key, outbox와 provenance 갱신처럼 원자성이 필요한 경로에는 사용하지 않는다.
5. Neon pooled endpoint의 transaction pooling 제약을 고려해 session 변수, temporary table, advisory lock, connection-local state와 named prepared statement에 의존하는 기능을 기본 경로에 넣지 않는다. 필요한 경우 해당 사용 이유와 전용 연결 경로를 별도 결정으로 기록한다.
6. retry는 연결 수립·일시적 네트워크 오류처럼 transaction이 시작되기 전이거나 전체 작업을 안전하게 재시도할 수 있을 때만 bounded 방식으로 적용한다. commit 결과가 불명확한 transaction을 무조건 재실행하지 않으며, 자연 키·idempotency 제약으로 중복을 방지한다.

### Migration path

- `DATABASE_URL`은 애플리케이션 runtime용 pooled Neon endpoint로 관리하고, `DATABASE_URL_DIRECT`는 Drizzle Kit migration용 Neon direct endpoint로 별도 관리한다.
- CI/release의 migration 단계는 `drizzle-kit migrate`와 커밋된 migration metadata/SQL만 사용한다. pooled endpoint, `drizzle-kit push`, 수동 dashboard schema 변경은 공유·운영 migration 경로가 아니다.
- migration 적용 전 direct endpoint에서 연결성·`vector` extension·권한을 확인한다. 적용 후 schema version과 핵심 extension/index 상태를 확인하고 migration audit event를 남긴다.
- migration은 immutable forward-only다. 실패 시 이미 적용된 파일을 수정하지 않고 호환 가능한 forward-fix를 추가한다. 확장 설치 권한이 runtime role에 없을 수 있으므로 pgvector bootstrap은 migration role로 수행한다.

### Secrets and access

- Neon pooled/direct connection string은 secret manager 또는 배포 환경 주입으로만 제공하고 `.env.example`, client bundle, 로그, 오류 본문에 기록하지 않는다.
- runtime role과 migration role을 분리한다. API·worker runtime에는 필요한 table/action만 부여하고, extension·DDL 권한은 migration 단계에만 부여한다.
- pooled와 direct URL은 값과 역할을 혼용하지 않으며, secret rotation 후 API 재배포와 worker restart를 수행한다. connection string의 host·database·role을 관측성 로그에 남기지 않는다.
- Neon branching을 사용할 때도 branch connection string은 환경별 secret으로 취급하고 production branch를 테스트에 사용하지 않는다.

## Consequences if accepted

- Neon이 공유·운영 PostgreSQL provider가 되고, PostgreSQL + pgvector는 계속 business processing의 authoritative store다.
- `packages/database`가 Drizzle ORM·Drizzle Kit과 Neon connection adapter의 경계를 소유한다. web은 database package나 secret에 접근하지 않는다.
- connection pooling과 transaction 경로가 분리되므로 repository adapter는 query 종류를 명시해야 한다. 세션 기반 PostgreSQL 기능은 기본적으로 사용할 수 없다.
- 로컬 Docker PostgreSQL + pgvector와 Neon 간 extension/version/SQL 호환성을 지속적으로 확인해야 한다.
- provider lock-in, 네트워크 지연, cold start, pooled connection saturation과 transaction retry ambiguity를 운영 지표와 장애 runbook에서 다뤄야 한다.
- 운영 hosting, API/worker serverless 배포 방식, LLM·embedding provider는 이 ADR로 결정하지 않는다.

## Validation before implementation

`DB-001`, `DB-002`, `OPS-001`의 acceptance와 연결해 다음을 확인한다.

- Neon test branch 또는 격리된 Neon database에 direct endpoint로 빈 DB migration을 적용하고 `vector` extension, 핵심 제약·index, Drizzle migration metadata를 확인한다.
- 같은 migration을 재실행해 중복 적용되지 않음을 확인하고, 기존 schema에서 다음 forward migration을 적용한다.
- pooled endpoint의 단일 쿼리와 WebSocket transaction에서 publish/idempotency/provenance 원자성을 확인한다. transaction 중 연결 오류·재시도와 commit 불명확 상태를 안전하게 처리한다.
- 동시 API 요청·worker burst에서 pool saturation, query latency, connection 오류율을 측정하고 bounded pool 설정을 고정한다.
- runtime credential로 DDL/extension 변경이 거부되고 migration credential만 migration을 수행하는지 확인한다.
- secret scan, built asset scan, redacted error/log 검증으로 pooled/direct connection string과 provider 오류 본문이 유출되지 않음을 확인한다.
- 동일한 schema/migration 시나리오를 로컬 Docker PostgreSQL + pgvector에서도 실행해 Neon 전용 동작과 portable SQL을 구분한다.

## References

- [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver)
- [Neon connection pooling](https://neon.com/docs/connect/connection-pooling)
- [Neon branching](https://neon.com/docs/introduction/branching)
- [Drizzle ORM overview](https://orm.drizzle.team/docs/overview)
- [Drizzle Kit overview](https://orm.drizzle.team/docs/kit-overview)
- [PostgreSQL CREATE EXTENSION](https://www.postgresql.org/docs/current/sql-createextension.html)
- [pgvector](https://github.com/pgvector/pgvector)
