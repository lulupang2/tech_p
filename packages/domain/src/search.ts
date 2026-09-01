export interface SearchHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentRevisionId: string;
  readonly title: string;
  readonly content: string;
  readonly headingPath: string[];
  readonly score: number;
  readonly publishedAt: Date | null;
}

export interface SearchFilter {
  readonly status?: string;
  readonly publishedAfter?: Date;
  readonly publishedBefore?: Date;
  readonly topicSlugs?: readonly string[];
}

export interface FtsQueryParams {
  readonly query: string;
  readonly filter?: SearchFilter;
  readonly limit?: number;
}

export interface ExactVectorQueryParams {
  readonly vector: readonly number[];
  readonly dimensions: number;
  readonly provider: string;
  readonly model: string;
  readonly filter?: SearchFilter;
  readonly limit?: number;
}

export interface SearchServicePort {
  readonly searchFts: (params: FtsQueryParams) => Promise<readonly SearchHit[]>;
  readonly searchExactVector: (params: ExactVectorQueryParams) => Promise<readonly SearchHit[]>;
}
