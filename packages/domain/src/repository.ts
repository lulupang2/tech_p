export interface SourceRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly scheduleConfig: Record<string, unknown>;
  readonly policyReviewedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocumentRecord {
  readonly id: string;
  readonly artifactType: string;
  readonly canonicalUrl: string | null;
  readonly duplicateClusterId: string | null;
  readonly currentRevisionId: string | null;
  readonly createdAt: Date;
}

export interface DocumentRevisionRecord {
  readonly id: string;
  readonly documentId: string;
  readonly rawItemId: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly author: string | null;
  readonly language: string;
  readonly publishedAt: Date | null;
  readonly licenseId: string | null;
  readonly normalizedHash: string;
  readonly normalizerVersion: string;
  readonly status: string;
  readonly searchableAt: Date | null;
  readonly createdAt: Date;
}

export interface ChunkRecord {
  readonly id: string;
  readonly documentRevisionId: string;
  readonly ordinal: number;
  readonly headingPath: string[];
  readonly content: string;
  readonly tokenCount: number;
  readonly contentHash: string;
  readonly chunkerVersion: string;
  readonly createdAt: Date;
}

export interface PaginationParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface DocumentFilter {
  readonly status?: string;
  readonly artifactType?: string;
  readonly publishedAfter?: Date;
  readonly publishedBefore?: Date;
}

export interface DocumentRepositoryPort {
  readonly findById: (id: string) => Promise<DocumentRecord | null>;
  readonly findRevisionById: (revisionId: string) => Promise<DocumentRevisionRecord | null>;
  readonly listDocuments: (
    filter: DocumentFilter,
    pagination?: PaginationParams,
  ) => Promise<PaginatedResult<DocumentRecord>>;
  readonly listChunksByRevision: (revisionId: string) => Promise<readonly ChunkRecord[]>;
  readonly publishRevision: (
    documentId: string,
    revisionId: string,
    searchableAt?: Date,
  ) => Promise<DocumentRevisionRecord>;
}

export interface SourceRepositoryPort {
  readonly findByKey: (key: string) => Promise<SourceRecord | null>;
  readonly listEnabled: () => Promise<readonly SourceRecord[]>;
}
