# ADR-0009: Drizzle ORM and Drizzle Kit migration strategy

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: `packages/database`에서 Drizzle ORM을 PostgreSQL query/schema 접근 계층으로 사용하고, Drizzle Kit으로 검토 가능한 SQL migration을 생성·적용한다. pgvector extension bootstrap을 첫 migration에 포함하며, 공유 환경과 운영 환경에서는 `drizzle-kit push`가 아니라 커밋된 migration을 적용한다

## Context

Signal Archive는 PostgreSQL + pgvector를 authoritative business store로 사용한다. raw item, immutable revision, citation provenance, metric observation의 제약과 인덱스를 TypeScript schema와 SQL migration 양쪽에서 검토 가능하게 유지하면서, domain이 ORM에 직접 의존하지 않는 경계가 필요하다.

기존 [ADR-0007](./0007-repository-layout.md)은 ORM과 migration tool을 결정하지 않은 상태에서 작성됐다. 이 ADR은 그 미결정 항목만 결정하며, 저장소 package 경계와 PostgreSQL·pgvector 데이터 규칙은 변경하지 않는다.

## Decision drivers

- PostgreSQL 제약, transaction, `jsonb`, full-text search, pgvector 기능을 필요한 SQL로 표현할 수 있을 것
- TypeScript schema와 runtime query의 타입 안정성
- 생성 migration을 코드 리뷰하고 forward-fix로 운영할 수 있을 것
- 빈 PostgreSQL + pgvector에서 migration을 재현하고 integration test로 검증할 수 있을 것
- domain port와 `packages/database` adapter의 의존 방향을 보존할 것

## Alternatives

### Drizzle ORM + Drizzle Kit

- 장점: TypeScript schema와 query API가 가볍게 결합되고, PostgreSQL용 SQL migration을 생성·검토할 수 있다. SQL escape hatch로 pgvector extension, operator class, expression/partial index를 직접 관리할 수 있다.
- 단점: 생성 migration의 정확성과 위험한 schema 변경 검토를 팀이 책임져야 하며, 일부 PostgreSQL 기능은 custom SQL migration이 필요하다.

### Prisma ORM + Prisma Migrate

- 장점: schema 모델, migration, client 생성 흐름과 문서화가 일관되고 기본 CRUD 생산성이 높다.
- 단점: PostgreSQL 특화 기능과 pgvector 인덱스·extension 표현에서 custom SQL과 별도 검토가 필요하며, generated client가 database 경계에 추가되는 구조적 비용이 있다.

### Kysely + 수동 SQL migration

- 장점: query 표현이 SQL에 가깝고 migration 실행 방식을 전부 통제할 수 있다.
- 단점: schema 선언·migration·타입 생성의 연결을 직접 유지해야 하며, 이 프로젝트의 초기 database package에 불필요한 보일러플레이트가 늘어난다.

## Recommendation

**Drizzle ORM + Drizzle Kit**을 사용한다. schema 선언은 `packages/database` 내부에 두고, `drizzle-kit generate`로 만든 SQL을 반드시 검토·커밋한다. `drizzle-kit migrate`는 커밋된 migration과 PostgreSQL migration metadata를 기준으로 적용하며, `push`는 disposable local exploration으로도 authoritative schema 변경 경로로 사용하지 않는다.

Migration 전략은 다음과 같다.

1. 첫 migration에서 PostgreSQL의 `vector` extension을 bootstrap하고, 이후 migration에서 테이블·제약·인덱스를 순서대로 추가한다. extension과 pgvector operator/index 같은 도구가 자동 생성하지 못하는 부분은 명시적인 custom SQL로 둔다.
2. migration은 immutable revision과 citation provenance를 보존하는 forward-only 변경으로 운영한다. 이미 적용된 migration을 수정하거나 삭제하지 않고, 오류는 호환 가능한 forward-fix migration으로 고친다.
3. schema 선언 변경 → generated SQL 생성 → SQL·위험한 lock/rewriting 검토 → migration commit → 빈 DB와 기존 DB 적용 검증 순서를 따른다. `drizzle-kit push`는 migration history를 남기는 배포 경로를 대체하지 않는다.
4. ORM 호출은 `packages/database`의 repository adapter에 가둔다. domain port는 Drizzle type과 PostgreSQL client를 노출하지 않으며, web은 계속 `packages/contracts`만 import한다.
5. schema, normalizer, chunker, taxonomy, embedding, prompt, workflow 버전과 citation이 가리키는 immutable revision은 migration으로 덮어쓰지 않는다.

## Consequences if accepted

- `packages/database`가 Drizzle ORM과 Drizzle Kit 설정·schema·migration의 소유 경계가 된다.
- migration SQL과 migration metadata는 저장소와 PostgreSQL에서 추적 가능해야 한다.
- pgvector extension, vector dimensions, operator class와 approximate index 도입은 각각 명시적인 migration과 검토를 거친다.
- migration rollback을 적용된 SQL의 자동 역변환으로 가정하지 않는다. 배포는 backward-compatible 단계를 우선하고, 장애 복구는 백업/PITR 또는 forward-fix 절차로 수행한다.
- DB-001은 도구 선택이 아니라 첫 Drizzle migration, pgvector extension bootstrap, 빈 DB 적용 검증을 구현·검증하는 task가 된다.
- embedding provider/model/dimensions와 HNSW 도입 여부는 이 ADR로 결정하지 않는다.

## Validation before implementation

[DB-001](../../TASKS.md)의 acceptance에서 다음을 확인한다.

- 빈 실제 PostgreSQL + pgvector에 첫 migration과 Drizzle migration metadata가 적용되는지
- 같은 migration을 재적용할 때 이미 적용된 migration이 중복 실행되지 않는지
- generated SQL과 custom SQL이 extension, FK, unique/check, full-text·vector 관련 제약을 의도대로 표현하는지
- database adapter가 Drizzle type을 domain port 밖으로 누출하지 않는지
- 기존 citation이 가리키는 immutable revision을 schema migration이 수정·삭제하지 않는지

## References

- [Drizzle ORM overview](https://orm.drizzle.team/docs/overview)
- [Drizzle Kit overview](https://orm.drizzle.team/docs/kit-overview)
- [Drizzle ORM PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql)
- [PostgreSQL CREATE EXTENSION](https://www.postgresql.org/docs/current/sql-createextension.html)
- [pgvector](https://github.com/pgvector/pgvector)
