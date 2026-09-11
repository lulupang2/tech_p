# ADR-0016: Low-cost live source activation and operating envelope

- 상태: Accepted (DEC-012, 2026-09-10)
- 작성일: 2026-09-10
- 연결 결정: DEC-012
- 승인 주체: 사용자
- 결정: GitHub Releases 5개 target과 이 문서의 cadence, budget, retention envelope

## Context

COV-008은 fixture provider와 격리 PostgreSQL/Redis에서 runtime cutover를 검증했다. COV-009에서
실제 source와 승인 model을 호출하려면 target, cadence, API/byte/token/spend limit, 보존 범위를
별도로 승인해야 한다. DISC-003은 조사 근거이며 활성화 권한은 아니다.

이 안은 첫 live canary와 제한된 90일 backfill에 필요한 최소 범위만 연다. 운영 배포와 대량
수집은 포함하지 않는다.

## Decision drivers

- 무료 또는 매우 낮은 실제 비용
- 권리와 model-input/embed 허용 범위가 명확한 target
- 90일 pagination, ETag, immutable citation 검증 가능성
- PostgreSQL budget으로 호출·byte·token·금액을 차단할 수 있는 작은 범위

## Alternatives

### A. GitHub Releases 5개 target만 활성화

- 장점: 공개 API, 명확한 repository license, pagination/ETag, 낮은 호출량
- 단점: community Q&A와 논문 coverage는 이번 canary에 포함되지 않음

### B. DISC-003의 허용 후보 전체 활성화

- 장점: 초기 coverage가 넓음
- 단점: 호출량과 권리·attribution 검증 범위가 한 번에 커짐

### C. 실제 source 활성화를 계속 보류

- 장점: 외부 호출과 비용 없음
- 단점: COV-009 live corpus acceptance 진행 불가

## Decision

대안 A를 채택해 아래 target만 COV-009 대상으로 승인한다.

| Source | Target | License | History |
|---|---|---|---|
| `github_releases` | `microsoft/TypeScript` | Apache-2.0 | 최근 90일 pagination |
| `github_releases` | `nodejs/node` | MIT | 최근 90일 pagination |
| `github_releases` | `microsoft/playwright` | Apache-2.0 | 최근 90일 pagination |
| `github_releases` | `facebook/react` | MIT | 최근 90일 pagination |
| `github_releases` | `pgvector/pgvector` | PostgreSQL License | 최근 90일 pagination |

`redis/redis`, Reddit, Stack Exchange, arXiv, feed-only/metric source와 나머지 후보는 disabled로
유지한다. discovery 결과는 자동 활성화하지 않는다.

## Approved operating envelope

### Collection

| 항목 | Hard limit |
|---|---:|
| Initial backfill | 승인 시점 기준 최근 90일, target당 1회 |
| Backfill / incremental concurrency | 각각 전체 1 |
| Incremental cadence | target당 6시간, ±15분 deterministic jitter |
| GitHub API requests | 200/day, 1,000/COV-009 total |
| Response bytes | 25 MiB/day, 250 MiB/COV-009 total |
| Request timeout/retry | 10초, 429/5xx/network만 최대 1회, `Retry-After` 준수 |
| On-demand acquisition | 비활성 |

PAT는 read-only 최소 권한으로 사용하며 ETag/Last-Modified를 적용한다. usage가 누락되거나 한도를
알 수 없으면 해당 lane을 fail closed한다.

### Model and spend

Model mapping은 DEC-007의 두 값으로 고정한다.

| Lane | Daily limit | COV-009 total | Spend cap |
|---|---:|---:|---:|
| ingestion embedding | 1,000 chunks / 1M input tokens | 5M input tokens | USD 0.10 |
| query embedding | 100 requests / 100K input tokens | 500 requests | USD 0.05 |
| chat answer | 100 requests / 500K input + 50K output tokens | 500 answers | USD 1.00 |

전체 provider spend hard cap은 **USD 2.00**이며 월간 반복 지출은 승인하지 않는다. 가격·usage가
불명확하거나 remote outcome을 알 수 없으면 예약액을 소비된 것으로 유지하고 자동 재호출하지
않는다. 자동 model fallback은 없다.

### Retention

| Data class | Retention |
|---|---:|
| Raw revision, normalized document, chunk, embedding | 120일 |
| Metric observations | 365일 |
| Question, answer, assembled prompt | 30일 |
| Payload/prompt 없는 operational logs | 14일 |
| Raw response 없는 sanitized evaluation hash/aggregate | 프로젝트 수명 |

삭제 동기화와 tombstone은 위 기간보다 우선한다. 만료 lineage는 citation dependency를 확인한 뒤
같이 tombstone/purge/reindex한다. 초기 90일 backfill horizon은 retention으로 해석하지 않는다.

## Consequences if accepted

- 위 5개 target만 `enabled=true`로 만들 수 있으며 COV-009 뒤 자동 확대하지 않는다.
- target당 1 page canary에서 status, bytes, rights metadata, citation provenance를 확인한 뒤에만
  90일 backfill을 시작한다.
- DEC-007 model은 사용할 수 있지만 AI-002 adapter/contract test 완료 전 model lane은 닫힌다.
- 실제 운영 배포, 추가 source/target, 반복 월간 지출, 더 긴 retention은 새 승인이 필요하다.

## Validation before acceptance

- target revision이 DISC-003 canonical URL과 license를 기록하는지 확인
- provider budget scope가 lane별 daily/token/spend limit를 표현하는지 확인
- retention dry-run이 삭제 대상 수와 citation dependency만 출력하는지 확인
- dataset hash, model/config, raw measurement 위치와 USD/KRW 환율 기준일을 실행 전에 고정

## References

- [DISC-003 rights and capability investigation](../experiments/DISC-003-source-rights-and-capability-investigation.md)
- [GitHub REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub conditional-request guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)
- [ADR-0012 model decision](./0012-chat-provider-revalidation.md)

---

승인 시 SSOT, SOURCE_CATALOG, DATA_PIPELINE, DATABASE, SECURITY, RUNBOOK, TASKS,
TRACEABILITY를 같은 변경에서 동기화한다.
