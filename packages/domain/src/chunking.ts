import { createHash } from 'node:crypto';

export const CHUNKER_VERSION = 'heading-aware-v1.0.0' as const;
export const DEFAULT_CHUNK_MAX_TOKENS = 400 as const;

export interface ChunkingInput {
  readonly title?: string;
  readonly bodyText: string;
  readonly maxTokens?: number;
  readonly chunkerVersion?: string;
}

export interface ChunkDraft {
  readonly ordinal: number;
  readonly headingPath: readonly string[];
  readonly content: string;
  readonly tokenCount: number;
  readonly contentHash: string;
  readonly chunkerVersion: string;
}

export interface ChunkingResult {
  readonly chunkerVersion: string;
  readonly chunks: readonly ChunkDraft[];
}

interface TextBlock {
  readonly lines: readonly string[];
  readonly headingPath: readonly string[];
  readonly atomic: boolean;
}

function countTokens(text: string): number {
  // This intentionally stable approximation is independent of a tokenizer/provider.
  const tokens = text.match(/[\p{L}\p{N}_]+|[^\s]/gu);
  return tokens?.length ?? 0;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function headingMatch(line: string): { readonly level: number; readonly title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  return match ? { level: match[1]?.length ?? 1, title: match[2]?.trim() ?? '' } : null;
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|', 1);
}

function splitOversizedBlock(block: TextBlock, maxTokens: number): TextBlock[] {
  const content = block.lines.join('\n').trim();
  if (block.atomic || countTokens(content) <= maxTokens) return [block];

  const words = content.split(/\s+/u).filter(Boolean);
  const result: TextBlock[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const word of words) {
    const wordTokens = countTokens(word);
    if (current.length > 0 && currentTokens + wordTokens > maxTokens) {
      result.push({ lines: [current.join(' ')], headingPath: block.headingPath, atomic: false });
      current = [];
      currentTokens = 0;
    }
    current.push(word);
    currentTokens += wordTokens;
  }
  if (current.length > 0) {
    result.push({ lines: [current.join(' ')], headingPath: block.headingPath, atomic: false });
  }
  return result;
}

function collectBlocks(bodyText: string): TextBlock[] {
  const lines = bodyText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks: TextBlock[] = [];
  const headingPath: string[] = [];
  let pending: string[] = [];
  let fenced = false;
  let fenceBuffer: string[] = [];
  let tableBuffer: string[] = [];

  const flushPending = (): void => {
    const content = pending.join('\n').trim();
    if (content) blocks.push({ lines: [content], headingPath: [...headingPath], atomic: false });
    pending = [];
  };
  const flushTable = (): void => {
    if (tableBuffer.length > 0) {
      blocks.push({ lines: [...tableBuffer], headingPath: [...headingPath], atomic: true });
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (fenced) {
      fenceBuffer.push(line);
      if (/^```/u.test(trimmed) || /^~~~\s*$/u.test(trimmed)) {
        blocks.push({ lines: [...fenceBuffer], headingPath: [...headingPath], atomic: true });
        fenceBuffer = [];
        fenced = false;
      }
      continue;
    }
    if (/^```|^~~~\s*$/u.test(trimmed)) {
      flushPending();
      flushTable();
      fenceBuffer = [line];
      fenced = true;
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      flushPending();
      flushTable();
      headingPath.splice(heading.level - 1);
      headingPath[heading.level - 1] = heading.title;
      continue;
    }
    if (isTableLine(line)) {
      flushPending();
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    if (trimmed.length === 0) flushPending();
    else pending.push(line);
  }

  if (fenceBuffer.length > 0)
    blocks.push({ lines: fenceBuffer, headingPath: [...headingPath], atomic: true });
  flushTable();
  flushPending();
  return blocks;
}

export function chunkDocument(input: ChunkingInput): ChunkingResult {
  const chunkerVersion = input.chunkerVersion ?? CHUNKER_VERSION;
  const maxTokens = input.maxTokens ?? DEFAULT_CHUNK_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError('maxTokens must be a positive integer');
  }

  const blocks = collectBlocks(input.bodyText);
  const chunks: ChunkDraft[] = [];
  for (const block of blocks) {
    for (const splitBlock of splitOversizedBlock(block, maxTokens)) {
      const content = splitBlock.lines.join('\n').trim();
      if (!content) continue;
      chunks.push({
        ordinal: chunks.length,
        headingPath: splitBlock.headingPath,
        content,
        tokenCount: Math.max(1, countTokens(content)),
        contentHash: hashContent(content),
        chunkerVersion,
      });
    }
  }
  return { chunkerVersion, chunks };
}

export function createChunker(defaults: { readonly maxTokens?: number } = {}): {
  readonly chunkerVersion: typeof CHUNKER_VERSION;
  readonly chunk: (
    input: Omit<ChunkingInput, 'maxTokens'> & { readonly maxTokens?: number },
  ) => ChunkingResult;
} {
  return {
    chunkerVersion: CHUNKER_VERSION,
    chunk: (input) => {
      const maxTokens = input.maxTokens ?? defaults.maxTokens;
      return maxTokens === undefined
        ? chunkDocument(input)
        : chunkDocument({ ...input, maxTokens });
    },
  };
}
