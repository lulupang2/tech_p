# ADR-0003: Queue and scheduling

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: **Redis + BullMQ**를 전달·예약 계층으로 사용한다. business completion은 PostgreSQL에 기록하고 queue 상태만으로 완료를 판단하지 않는다
- 근거: [EXP-005](../experiments/EXP-005-foundation-spike.md) run 3 측정

## Context

수집·정규화·임베딩은 외부 실패와 긴 실행 시간을 가지며 API 요청 생명주기에서 분리해야 한다. 예약 실행, retry, backpressure, replay가 필요하다.

## Decision drivers

- TypeScript worker support
- 예약 job, retry/backoff, concurrency, observability
- at-least-once 처리와 멱등성
- 로컬 Docker 복잡도
- PostgreSQL을 queue polling으로 과부하시키지 않을 것

## Alternatives

### Redis + BullMQ

- 장점: mature TS API, worker concurrency, retry/backoff, job schedulers, Docker로 재현 가능
- 단점: Redis 운영·모니터링이 추가되고 queue state를 DB truth와 조정해야 함

### PostgreSQL job/outbox table

- 장점: 인프라가 하나이며 transaction과 job 생성 원자성 단순
- 단점: polling/locking/retry UI를 직접 만들고 검색 DB workload와 경쟁할 수 있음

### Cron + 직접 worker 호출

- 장점: 가장 단순
- 단점: 단계별 retry, backpressure, replay, 중복 실행 통제가 약함

## Recommendation

**Redis + BullMQ**를 추천한다. 단, business completion은 PostgreSQL에 기록하고 BullMQ는 전달·예약 계층으로만 사용한다. DB commit과 후속 job 생성 사이 유실에는 outbox를 검토한다.

## EXP-005 측정 결과 (2026-09-01)

Redis + BullMQ 조합을 실측했고 **추천 구조가 성립함을 확인했다.** 상세는 [EXP-005 run 3](../experiments/EXP-005-foundation-spike.md)에 있다.

- bullmq 6.3.3, ioredis 6.0.0, redis 7, PostgreSQL 17.11 + pgvector 0.8.6.
- 같은 `jobId`로 2회 add하면 BullMQ가 두 번째를 중복으로 버렸다.
- 다른 `jobId`에 동일 payload를 넣고 commit 이후 crash + retry까지 섞었을 때, **handler는 5회 호출됐고 business row는 3개, 중복 자연 키는 0개**였다.
- 즉 at-least-once 전달이 실제로 관찰되는 조건에서 자연 키 unique 제약과 upsert가 중복을 막았다. **queue 수준 중복 제거와 handler 수준 멱등성이 독립적으로 동작한다.**

이 결과는 "BullMQ는 전달·예약 계층으로만 쓰고 business completion은 PostgreSQL에 기록한다"는 이 ADR의 핵심 전제를 뒷받침한다. 다만 아래 항목은 아직 측정하지 않았다.

- 프로세스 강제 종료 후 재시작(SIGKILL) 복구
- 다중 worker 경합과 backpressure
- DB commit 후 job 생성 유실에 대한 outbox 필요성

`DEC-004` 승인 시 위 미측정 항목을 `QUE-001`의 acceptance로 넘긴다.

## Consequences if accepted

- Docker Compose에 Redis가 추가된다.
- 모든 job payload는 ID와 versioned schema만 포함한다.
- job handler는 멱등해야 하며 queue의 “exactly once”를 가정하지 않는다.
- dead-letter/replay 운영 경로와 queue retention을 정의한다.
- scheduler는 source마다 다른 주기와 rate 예산을 다뤄야 한다. 확정된 11개 source의 주기는 1시간에서 1일까지 갈리고, arXiv는 요청 간 3초·단일 연결, Stack Exchange는 응답 본문 `backoff`, Discourse는 429·`Retry-After`를 각각 요구한다. 상세는 [SOURCE_CATALOG §13](../SOURCE_CATALOG.md)에 있다.
- source별 concurrency 상한을 개별로 설정할 수 있어야 한다. 전역 concurrency 하나로는 단일 연결을 요구하는 source를 지킬 수 없다.

## Validation before acceptance

- scheduler 중복 upsert, worker crash, retry, backpressure spike
- DB commit 후 job 유실 시나리오와 outbox 필요성
- Redis 재시작 후 job 복구
- 운영 UI 없이도 필요한 상태를 DB/API에서 조회 가능한지 확인

## References

- [BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers/)
- [BullMQ retrying jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)
- [BullMQ deduplication](https://docs.bullmq.io/patterns/deduplication)

