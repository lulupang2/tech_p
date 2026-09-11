import {
  createOpenAiCompatibleChatPort,
  createOpenAiCompatibleEmbeddingPort,
} from '@techpulse/domain';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const chatModel = required('OPENAI_CHAT_MODEL');
  const embeddingModel = required('EMBEDDING_MODEL');
  const dimensions = Number(required('EMBEDDING_DIMENSIONS'));

  const embedding = createOpenAiCompatibleEmbeddingPort({
    apiKey: required('EMBEDDING_API_KEY'),
    baseUrl: required('EMBEDDING_BASE_URL'),
    model: embeddingModel,
    dimensions,
    acceptedResponseModels: ['pplx-embed-v1-0.6b'],
    defaultTimeoutMs: 15_000,
  });
  const chat = createOpenAiCompatibleChatPort({
    apiKey: required('OPENAI_API_KEY'),
    baseUrl: required('OPENAI_BASE_URL'),
    model: chatModel,
    defaultTimeoutMs: 15_000,
    temperature: 0,
    requireJsonObject: true,
  });

  const [embeddingOutcome, chatOutcome] = await Promise.allSettled([
    embedding.embed({
      input: 'TypeScript runtime compatibility update',
      timeoutMs: 15_000,
    }),
    chat.complete({
      messages: [
        { role: 'system', content: 'Return one JSON object only.' },
        { role: 'user', content: 'Return {"ok":true}.' },
      ],
      responseFormat: 'json_object',
      maxOutputTokens: 16,
      timeoutMs: 15_000,
    }),
  ]);

  const embeddingResult = embeddingOutcome.status === 'fulfilled' ? embeddingOutcome.value : null;
  const chatResult = chatOutcome.status === 'fulfilled' ? chatOutcome.value : null;
  let validJson = false;
  if (chatResult) {
    try {
      const parsed = JSON.parse(chatResult.content) as unknown;
      validJson = typeof parsed === 'object' && parsed !== null;
    } catch {
      validJson = false;
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      embedding: {
        ok: embeddingResult !== null,
        ...(embeddingResult
          ? {
              model: embeddingResult.metadata.model,
              dimensions: embeddingResult.metadata.dimensions,
              vectorLength: embeddingResult.vector.length,
              finite: embeddingResult.vector.every(Number.isFinite),
              nonzero: embeddingResult.vector.some((value) => value !== 0),
              inputTokens: embeddingResult.metadata.usage.inputTokens,
              latencyMs: embeddingResult.metadata.latencyMs,
            }
          : {
              error:
                embeddingOutcome.reason instanceof Error
                  ? embeddingOutcome.reason.message
                  : 'unknown',
            }),
      },
      chat: {
        ok: chatResult !== null,
        ...(chatResult
          ? {
              model: chatResult.metadata.model,
              usage: chatResult.metadata.usage,
              latencyMs: chatResult.metadata.latencyMs,
            }
          : {
              error: chatOutcome.reason instanceof Error ? chatOutcome.reason.message : 'unknown',
            }),
        validJson,
      },
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown live model canary failure';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
