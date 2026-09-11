import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadApiConfig } from '../src/config.js';
import {
  createApprovedApiModelBindings,
  DEC007_CHAT_MODEL,
  DEC007_EMBEDDING_MODEL,
  DEC012_SCOPE_ID,
} from '../src/approved-models.js';

const databaseUrl = 'postgresql://db.test:5432/techpulse';

describe('DEC-007 approved API model bindings', () => {
  test('fails closed for missing, partial, or mismatched provider configuration', () => {
    assert.equal(
      createApprovedApiModelBindings(loadApiConfig({ DATABASE_URL: databaseUrl })),
      undefined,
    );
    assert.equal(
      createApprovedApiModelBindings(
        loadApiConfig({
          DATABASE_URL: databaseUrl,
          OPENAI_API_KEY: 'chat-key',
          OPENAI_BASE_URL: 'https://api.runinfra.ai/v1',
          OPENAI_CHAT_MODEL: DEC007_CHAT_MODEL,
        }),
      ),
      undefined,
    );
    assert.equal(
      createApprovedApiModelBindings(
        loadApiConfig({
          DATABASE_URL: databaseUrl,
          OPENAI_API_KEY: 'chat-key',
          OPENAI_BASE_URL: 'https://unapproved.example/v1',
          OPENAI_CHAT_MODEL: DEC007_CHAT_MODEL,
          EMBEDDING_API_KEY: 'embed-key',
          EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
          EMBEDDING_MODEL: DEC007_EMBEDDING_MODEL,
          EMBEDDING_DIMENSIONS: '1024',
        }),
      ),
      undefined,
    );
  });

  test('constructs the exact approved pair with bounded profiles and prices', () => {
    const bindings = createApprovedApiModelBindings(
      loadApiConfig({
        DATABASE_URL: databaseUrl,
        OPENAI_API_KEY: 'chat-key',
        OPENAI_BASE_URL: 'https://api.runinfra.ai/v1',
        OPENAI_CHAT_MODEL: DEC007_CHAT_MODEL,
        EMBEDDING_API_KEY: 'embed-key',
        EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
        EMBEDDING_MODEL: DEC007_EMBEDDING_MODEL,
        EMBEDDING_DIMENSIONS: '1024',
      }),
    );

    assert.ok(bindings);
    assert.equal(bindings.chat.profile.provider, 'runinfra');
    assert.equal(bindings.chat.profile.model, DEC007_CHAT_MODEL);
    assert.equal(bindings.chat.scopeId, DEC012_SCOPE_ID);
    assert.equal(bindings.chat.caps.maxOutputTokens, 700);
    assert.equal(bindings.chat.priceRate.unitsPerThousandTokens, 150);
    assert.equal(bindings.embedding?.profile.model, DEC007_EMBEDDING_MODEL);
    assert.equal(bindings.embedding?.profile.dimensions, 1024);
    assert.equal(bindings.embedding?.priceRate.unitsPerThousandTokens, 4);
  });
});
