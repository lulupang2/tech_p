import { randomUUID } from 'node:crypto';
import { type StructuredLogger, createStructuredLogger } from '@techpulse/observability';

export interface OpsCliOptions {
  readonly apiKey?: string | undefined;
  readonly apiUrl?: string | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly appHandler?: ((request: Request) => Promise<Response>) | undefined;
}

export interface CliExecutionResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly output: unknown;
  readonly error?: string | undefined;
}

export async function runOpsCli(
  args: readonly string[],
  options: OpsCliOptions = {},
): Promise<CliExecutionResult> {
  const logger = options.logger ?? createStructuredLogger({ service: 'ops-cli' });
  logger.debug('ops.cli.invoked', { argsCount: args.length });
  const apiKey = options.apiKey || process.env['OPS_API_KEY'];
  const apiUrl = (options.apiUrl || process.env['OPS_API_URL'] || 'http://localhost:3000').replace(
    /\/+$/u,
    '',
  );
  const fetchFn = options.fetchFn ?? fetch;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const helpText = `
Signal Archive Operations CLI (API-004)

Usage:
  ops <command> [options]

Commands:
  status                                          Check operations endpoint health
  collect --source <key> [options]                Trigger bounded manual collection
  replay --scope <run|raw|stage> --target <id>    Request bounded pipeline replay
  source enable <key>                             Enable source and restore searchable status
  source disable <key> [options]                  Disable source and apply tombstone
  runs [options]                                  List collection runs
  run <id>                                        Get collection run details

Options:
  --api-key <key>        Operations API Key (or OPS_API_KEY env)
  --api-url <url>        Base API URL (default http://localhost:3000)
  --idempotency-key <k>  Explicit idempotency key (defaults to auto-generated UUID)
  --actor <name>         Operator username for audit trail (default: cli_operator)
  --limit <n>            Maximum item count (bounded 1-500)
  --dry-run              Simulate operation without mutating database or dispatching jobs
`;
    return {
      success: true,
      exitCode: 0,
      output: helpText.trim(),
    };
  }

  // Parse command and flags
  const command = args[0];
  const flags: Record<string, string> = {};
  const booleanFlags = new Set<string>();

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        flags[key] = nextArg;
        i++;
      } else {
        booleanFlags.add(key);
      }
    }
  }

  const effectiveApiKey = flags['api-key'] || apiKey;
  if (!effectiveApiKey) {
    const err =
      'Operations API key is required. Pass --api-key or set OPS_API_KEY environment variable.';
    return {
      success: false,
      exitCode: 1,
      output: null,
      error: err,
    };
  }

  const idempotencyKey = flags['idempotency-key'] || `cli_${randomUUID().replace(/-/gu, '')}`;
  const actor = flags['actor'] || process.env['USER'] || 'cli_operator';

  const makeRequest = async (
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${effectiveApiKey}`,
      'x-actor': actor,
    };
    if (method === 'POST' || method === 'PATCH') {
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = idempotencyKey;
    }

    const fullUrl = `${apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let res: Response;
    if (options.appHandler) {
      res = await options.appHandler(new Request(fullUrl, init));
    } else {
      res = await fetchFn(fullUrl, init);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };

  try {
    if (command === 'status') {
      const { status, data } = await makeRequest('/api/v1/ops/status', 'GET');
      return {
        success: status === 200,
        exitCode: status === 200 ? 0 : 1,
        output: data,
        error: status !== 200 ? 'Failed to fetch ops status' : undefined,
      };
    }

    if (command === 'collect') {
      const sourceKey = flags['source'] || flags['source-key'];
      if (!sourceKey) {
        return {
          success: false,
          exitCode: 1,
          output: null,
          error: 'Missing required flag: --source <key>',
        };
      }
      const limit = flags['limit'] ? Number(flags['limit']) : undefined;
      const dryRun = booleanFlags.has('dry-run');

      const { status, data } = await makeRequest('/api/v1/ops/collection-runs', 'POST', {
        sourceKey,
        ...(limit !== undefined ? { limit } : {}),
        dryRun,
      });

      return {
        success: status === 200 || status === 201,
        exitCode: status === 200 || status === 201 ? 0 : 1,
        output: data,
        error:
          status >= 400
            ? (data as Record<string, unknown>)?.['error']
              ? JSON.stringify((data as Record<string, unknown>)['error'])
              : 'Collect operation failed'
            : undefined,
      };
    }

    if (command === 'replay') {
      const scope = flags['scope'] as 'run' | 'raw' | 'stage';
      const targetId = flags['target'] || flags['target-id'];
      if (!scope || !targetId) {
        return {
          success: false,
          exitCode: 1,
          output: null,
          error: 'Missing required flags: --scope <run|raw|stage> --target <id>',
        };
      }
      const stage = flags['stage'] as 'normalization' | 'deduplication' | undefined;
      const limit = flags['limit'] ? Number(flags['limit']) : undefined;
      const dryRun = booleanFlags.has('dry-run');

      const { status, data } = await makeRequest('/api/v1/ops/pipeline-replays', 'POST', {
        scope,
        targetId,
        ...(stage ? { stage } : {}),
        ...(limit !== undefined ? { limit } : {}),
        dryRun,
      });

      return {
        success: status === 200 || status === 201,
        exitCode: status === 200 || status === 201 ? 0 : 1,
        output: data,
        error:
          status >= 400
            ? (data as Record<string, unknown>)?.['error']
              ? JSON.stringify((data as Record<string, unknown>)['error'])
              : 'Replay operation failed'
            : undefined,
      };
    }

    if (command === 'source') {
      const subCommand = args[1];
      const sourceKey = args[2] || flags['key'] || flags['source'];
      if (!subCommand || !sourceKey) {
        return {
          success: false,
          exitCode: 1,
          output: null,
          error: 'Usage: ops source <enable|disable> <source-key>',
        };
      }

      if (subCommand === 'enable') {
        const requestedBy = flags['requested-by'] || actor;
        const { status, data } = await makeRequest(
          `/api/v1/ops/sources/${sourceKey}/enable`,
          'POST',
          {
            requestedBy,
          },
        );
        return {
          success: status === 200,
          exitCode: status === 200 ? 0 : 1,
          output: data,
          error:
            status >= 400
              ? (data as Record<string, unknown>)?.['error']
                ? JSON.stringify((data as Record<string, unknown>)['error'])
                : 'Enable source failed'
              : undefined,
        };
      }

      if (subCommand === 'disable') {
        const reason = flags['reason'] || 'Disabled via CLI';
        const requestedBy = flags['requested-by'] || actor;
        const { status, data } = await makeRequest(
          `/api/v1/ops/sources/${sourceKey}/disable`,
          'POST',
          {
            reason,
            requestedBy,
          },
        );
        return {
          success: status === 200,
          exitCode: status === 200 ? 0 : 1,
          output: data,
          error:
            status >= 400
              ? (data as Record<string, unknown>)?.['error']
                ? JSON.stringify((data as Record<string, unknown>)['error'])
                : 'Disable source failed'
              : undefined,
        };
      }
    }

    if (command === 'runs') {
      const queryParams = new URLSearchParams();
      if (flags['source']) queryParams.set('sourceKey', flags['source']);
      if (flags['status']) queryParams.set('status', flags['status']);
      if (flags['limit']) queryParams.set('limit', flags['limit']);
      if (flags['from']) queryParams.set('from', flags['from']);
      if (flags['to']) queryParams.set('to', flags['to']);

      const queryStr = queryParams.toString();
      const path = `/api/v1/ops/collection-runs${queryStr ? `?${queryStr}` : ''}`;
      const { status, data } = await makeRequest(path, 'GET');
      return {
        success: status === 200,
        exitCode: status === 200 ? 0 : 1,
        output: data,
        error: status !== 200 ? 'Failed to fetch collection runs' : undefined,
      };
    }

    if (command === 'run') {
      const runId = args[1] || flags['id'];
      if (!runId) {
        return {
          success: false,
          exitCode: 1,
          output: null,
          error: 'Usage: ops run <run-id>',
        };
      }
      const { status, data } = await makeRequest(`/api/v1/ops/collection-runs/${runId}`, 'GET');
      return {
        success: status === 200,
        exitCode: status === 200 ? 0 : 1,
        output: data,
        error: status !== 200 ? 'Failed to fetch collection run details' : undefined,
      };
    }

    return {
      success: false,
      exitCode: 1,
      output: null,
      error: `Unknown command: ${command}. Run ops --help for available commands.`,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      exitCode: 1,
      output: null,
      error: errorMsg,
    };
  }
}
