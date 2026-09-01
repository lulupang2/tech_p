import type { SourcePolicy, PolicyGuardPort, CollectedRawItem } from '@techpulse/domain';

// Reserved/Private IPv4 and loopback blocks for SSRF prevention
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // Link-local / AWS metadata
  /^0\.0\.0\.0$/,
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 unique local
];

/**
 * Validates URLs against SSRF threats, host allowlist, and scheme restrictions.
 */
export function validateUrl(
  urlString: string,
  policy: SourcePolicy,
): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // 1. Check scheme
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (!policy.allowedSchemes.includes(scheme as 'http' | 'https')) {
    return { valid: false, reason: `Scheme '${scheme}' is not permitted by source policy` };
  }

  // 2. Check SSRF blocked hosts (loopback, private networks, cloud metadata)
  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        valid: false,
        reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
      };
    }
  }

  // 3. Check allowed hosts
  const hostAllowed = policy.allowedHosts.some(
    (allowed) =>
      hostname === allowed.toLowerCase() || hostname.endsWith(`.${allowed.toLowerCase()}`),
  );
  if (!hostAllowed) {
    return {
      valid: false,
      reason: `Host '${hostname}' is not in the allowed hosts list for source ${policy.sourceKey}`,
    };
  }

  return { valid: true };
}

/**
 * Deeply removes PII fields specified by the policy from raw payload objects.
 */
export function stripPii<T extends Record<string, unknown>>(payload: T, policy: SourcePolicy): T {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const result = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  for (const path of policy.piiFieldsToStrip) {
    removeNestedField(result, path.split('.'));
  }

  return result as T;
}

function removeNestedField(
  target: Record<string, unknown> | unknown[],
  pathSegments: string[],
): void {
  if (!target || pathSegments.length === 0) return;

  const [current, ...rest] = pathSegments;
  if (!current) return;

  if (Array.isArray(target)) {
    for (const item of target) {
      if (item && typeof item === 'object') {
        removeNestedField(item as Record<string, unknown>, pathSegments);
      }
    }
    return;
  }

  if (rest.length === 0) {
    delete target[current];
  } else if (target[current] && typeof target[current] === 'object') {
    removeNestedField(target[current] as Record<string, unknown> | unknown[], rest);
  }
}

/**
 * Policy guard implementation fulfilling PolicyGuardPort.
 */
export class DefaultPolicyGuard implements PolicyGuardPort {
  validateUrl(url: string, policy: SourcePolicy): { valid: boolean; reason?: string } {
    return validateUrl(url, policy);
  }

  stripPii<T extends Record<string, unknown>>(payload: T, policy: SourcePolicy): T {
    return stripPii(payload, policy);
  }

  enforceContentPolicy(item: CollectedRawItem): { valid: boolean; reason?: string } {
    if (!item.externalId || item.externalId.trim() === '') {
      return { valid: false, reason: 'Missing externalId in raw item' };
    }
    if (!item.rawHash || item.rawHash.length !== 64) {
      return {
        valid: false,
        reason: 'Invalid or missing rawHash (must be sha256 64 hex characters)',
      };
    }
    return { valid: true };
  }
}
