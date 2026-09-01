import {
  TOPIC_CLASSIFIER_VERSION,
  TOPIC_TAXONOMY,
  classifyTopics,
  type TopicClassification,
} from './topic-classification.js';
import { chunkDocument, type ChunkDraft } from './chunking.js';
import type {
  ChunkRepositoryPort,
  SaveChunkInput,
  SaveDocumentTopicInput,
  TopicRepositoryPort,
} from './repository.js';

export interface EnrichmentInput {
  readonly documentId: string;
  readonly revisionId: string;
  readonly title: string;
  readonly bodyText: string;
  readonly sourceKey?: string | null;
  readonly maxChunkTokens?: number;
}

export interface EnrichmentResult {
  readonly classifications: readonly TopicClassification[];
  readonly chunks: readonly ChunkDraft[];
  readonly topicsSaved: number;
  readonly chunksSaved: number;
  readonly classifierVersion: typeof TOPIC_CLASSIFIER_VERSION;
}

export interface EnrichmentServiceOptions {
  readonly topicRepository: TopicRepositoryPort;
  readonly chunkRepository: ChunkRepositoryPort;
}

export interface EnrichmentServicePort {
  readonly enrich: (input: EnrichmentInput) => Promise<EnrichmentResult>;
}

/** Persists only new taxonomy/chunker versions; existing evidence is never deleted. */
export function createEnrichmentService(options: EnrichmentServiceOptions): EnrichmentServicePort {
  return {
    async enrich(input: EnrichmentInput): Promise<EnrichmentResult> {
      const classifications = classifyTopics({
        title: input.title,
        bodyText: input.bodyText,
        ...(input.sourceKey !== undefined ? { sourceKey: input.sourceKey } : {}),
      });
      const topicInputs: SaveDocumentTopicInput[] = [];
      for (const classification of classifications) {
        const definition = TOPIC_TAXONOMY.find((entry) => entry.slug === classification.slug);
        if (!definition) continue;
        const topic = await options.topicRepository.upsert({
          slug: definition.slug,
          displayName: definition.displayName,
          aliases: definition.aliases,
          taxonomyVersion: classification.taxonomyVersion,
        });
        topicInputs.push({
          documentId: input.documentId,
          topicId: topic.id,
          method: classification.method,
          confidence: classification.confidence,
          classifierVersion: classification.classifierVersion,
        });
      }
      const savedTopics = await options.topicRepository.saveDocumentTopics(topicInputs);

      const chunkInput = {
        title: input.title,
        bodyText: input.bodyText,
        ...(input.maxChunkTokens !== undefined ? { maxTokens: input.maxChunkTokens } : {}),
      };
      const chunkResult = chunkDocument(chunkInput);
      const chunkInputs: SaveChunkInput[] = chunkResult.chunks.map((chunk) => ({
        documentRevisionId: input.revisionId,
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash,
        chunkerVersion: chunk.chunkerVersion,
      }));
      const savedChunks = await options.chunkRepository.saveChunks(chunkInputs);
      return {
        classifications,
        chunks: chunkResult.chunks,
        topicsSaved: savedTopics.length,
        chunksSaved: savedChunks.length,
        classifierVersion: TOPIC_CLASSIFIER_VERSION,
      };
    },
  };
}
