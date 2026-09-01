export const validAnswerRequest = {
  question: '최근 한 달간 Bun과 Node.js의 관심 변화를 비교해줘.',
  timeRange: {
    from: '2026-08-01T00:00:00Z',
    to: '2026-09-01T00:00:00Z',
  },
  timezone: 'Asia/Seoul',
  language: 'ko',
};

export const validAnswerResponse = {
  requestId: 'req_fixture',
  answerId: 'ans_fixture',
  status: 'answered',
  intent: 'compare_interest',
  resolvedTimeRange: {
    from: '2026-08-01T00:00:00Z',
    to: '2026-09-01T00:00:00Z',
    timezone: 'Asia/Seoul',
  },
  answer: 'Bun의 관심이 증가했습니다. [C1]',
  observations: [
    {
      subject: 'Bun',
      metric: 'community_mentions',
      value: 42,
      unit: 'deduplicated_documents',
      change: 0.2,
    },
  ],
  citations: [
    {
      id: 'C1',
      documentRevisionId: 'rev_fixture',
      title: 'Bun release notes',
      source: 'github_releases',
      url: 'https://example.com/releases/bun',
      publishedAt: '2026-08-20T00:00:00Z',
      excerptIsVerbatim: true,
    },
  ],
  coverage: {
    dataFreshThrough: '2026-09-01T00:15:00Z',
    sourcesUsed: 3,
    documentsConsidered: 18,
    limitations: [],
  },
};

export const validCollectionJobPayload = {
  schemaVersion: 1,
  collectionRunId: 'run_fixture',
  sourceKey: 'github_releases',
  cursor: null,
};

export const requestWithUnknownField = {
  ...validAnswerRequest,
  internalPrompt: 'must be rejected',
};

export const responseWithUndeclaredFields = {
  ...validAnswerResponse,
  _internalScore: 0.99,
  coverage: {
    ...validAnswerResponse.coverage,
    rawPayload: 'must be removed',
  },
};

export const jobWithUnknownField = {
  ...validCollectionJobPayload,
  payload: { raw: 'must not travel through queue' },
};
