# ADR-0002: AI orchestration

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: LangGraph.js의 deterministic workflow를 사용한다. autonomous agent loop는 MVP에서 사용하지 않는다

## Context

Signal Archive는 질의 해석, 문서/지표 검색, 근거 충분성 판단, 답변 생성, citation 검증을 재현 가능한 흐름으로 실행해야 한다. 필수 조건은 LangChain 또는 LangGraph 사용이다.

## Decision drivers

- 단계와 상태를 명시적으로 관찰·테스트할 수 있음
- 결정적 코드와 LLM 호출을 구분할 수 있음
- provider 교체와 structured output 검증
- timeout, bounded retry, failure branch
- portfolio에서 RAG 설계가 드러남

## Alternatives

### LangChain.js runnable/agent

- 장점: 모델·retriever integration이 풍부하고 단순 chain을 빠르게 구성
- 단점: 자유도가 높은 agent loop는 Signal Archive의 제한된 의도에 과도하며 상태·분기 통제가 흐려질 수 있음

### LangGraph.js workflow

- 장점: state, node, edge로 분기와 failure/abstention을 명시하고 workflow를 시각화·테스트하기 쉬움
- 단점: 단순 chain보다 학습·설계 비용이 크며 checkpoint 같은 기능은 MVP에 과도할 수 있음

### 직접 orchestration + 최소 LangChain adapter

- 장점: 작은 코드와 낮은 framework coupling
- 단점: 필수 기술의 의미가 약하고 tracing/state/error protocol을 직접 설계해야 함

## Recommendation

**LangGraph.js의 deterministic workflow**를 추천한다. agent가 임의 tool을 고르는 대신, parse → retrieve → evaluate evidence → generate → validate의 고정 노드와 제한된 branch를 사용한다. 모델 integration에는 필요한 LangChain component를 함께 사용할 수 있다.

## Consequences if accepted

- graph state는 JSON-serializable contract로 정의한다.
- 날짜 계산, SQL, citation 검증은 deterministic node로 둔다.
- `verbatim_only` source 근거의 재서술 여부 검사와 라이선스·귀속 주입도 deterministic node로 둔다. 모델이 판단하게 하지 않는다. 근거는 [RAG §6.1](../RAG.md)과 [SOURCE_RIGHTS §10.1](../SOURCE_RIGHTS.md)에 있다.
- MVP에서는 장기 memory와 autonomous tool loop를 사용하지 않는다.
- graph/checkpoint persistence 필요성은 API 응답 방식 결정 후 별도 평가한다.

## Validation before acceptance

- 사용자 예시 4개와 insufficient-evidence branch 실행
- [EVAL_GOLDEN_SET](../EVAL_GOLDEN_SET.md)의 라이선스·인용 항목(G-030~G-033)에서 재서술 차단 branch가 동작하는지 확인
- fake model로 모든 edge를 unit test 가능함을 확인
- workflow overhead와 trace 가독성 비교
- provider timeout 시 중단·재시도 의미 검증

## References

- [LangGraph.js overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [LangGraph workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)
