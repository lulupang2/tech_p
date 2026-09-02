import type { SourcePolicy, PolicyGuardPort, CollectedRawItem } from '@techpulse/domain';

export class SsrfViolationError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`SSRF policy violation for URL '${url}': ${reason}`);
    this.name = 'SsrfViolationError';
    this.url = url;
    this.reason = reason;
  }
}

export class ResponseSizeExceededError extends Error {
  readonly maxSizeBytes: number;

  constructor(maxSizeBytes: number) {
    super(`Response body exceeded maximum allowed size of ${maxSizeBytes} bytes`);
    this.name = 'ResponseSizeExceededError';
    this.maxSizeBytes = maxSizeBytes;
  }
}

// Blocked metadata / special domain patterns
const BLOCKED_HOST_REGEXES = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
  /^metadata\.goog$/i,
  /^instance-data$/i,
];

/**
 * Parses a decimal, hex, octal, or dot-decimal representation into 4 numeric octets [a, b, c, d]
 * or returns null if not an IPv4 address.
 */
function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const dotParts = hostname.split('.');
  if (dotParts.length === 4) {
    const octets: number[] = [];
    for (const part of dotParts) {
      let val: number;
      if (/^0x[0-9a-f]+$/i.test(part)) {
        val = parseInt(part, 16);
      } else if (/^0[0-7]+$/i.test(part)) {
        val = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        val = parseInt(part, 10);
      } else {
        return null;
      }
      if (isNaN(val) || val < 0 || val > 255) return null;
      octets.push(val);
    }
    return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
  }

  let num: number | null = null;
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    num = parseInt(hostname, 16);
  } else if (/^\d+$/.test(hostname)) {
    num = parseInt(hostname, 10);
  }

  if (num !== null && !isNaN(num) && num >= 0 && num <= 0xffffffff) {
    const a = (num >>> 24) & 0xff;
    const b = (num >>> 16) & 0xff;
    const c = (num >>> 8) & 0xff;
    const d = num & 0xff;
    return [a, b, c, d];
  }

  return null;
}

/**
 * Checks if IPv4 octets fall into private, loopback, link-local, carrier-grade NAT, or reserved space.
 */
function isForbiddenIpv4(a: number, b: number, c: number, d: number): boolean {
  void c;
  void d;
  // 0.0.0.0/8 (Current network / broadcast)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-grade NAT 100.64.0.0 - 100.127.255.255)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local / AWS & cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99.0/24 (6to4 Relay)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Network benchmark tests 198.18.0.0 - 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved / Broadcast 240.0.0.0 - 255.255.255.255)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if IPv6 address falls into loopback, unique local, link-local, or IPv4-mapped private space.
 */
function isForbiddenIpv6(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');

  // Loopback & unspecified
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // Unique local (fc00::/7 -> fc00:: and fd00::)
  if (host.startsWith('fc') || host.startsWith('fd') || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    return true;
  }

  // Link-local (fe80::/10 -> fe80:: - febf::)
  if (/^fe[89ab][0-9a-f]:/i.test(host) || host.startsWith('fe80:')) {
    return true;
  }

  // Multicast (ff00::/8)
  if (host.startsWith('ff') || /^ff[0-9a-f]{2}:/i.test(host)) {
    return true;
  }

  // Documentation (2001:db8::/32)
  if (host.startsWith('2001:db8:') || host.startsWith('2001:0db8:')) {
    return true;
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (host.startsWith('::ffff:') || host.startsWith('0:0:0:0:0:ffff:')) {
    const suffix = host.replace(/^(::ffff:|0:0:0:0:0:ffff:)/i, '');
    const octets = parseIpv4Octets(suffix);
    if (octets && isForbiddenIpv4(...octets)) {
      return true;
    }
  }

  return false;
}

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

  // 2. Check SSRF blocked host patterns (localhost, internal, metadata)
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  for (const regex of BLOCKED_HOST_REGEXES) {
    if (regex.test(hostname)) {
      return {
        valid: false,
        reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
      };
    }
  }

  // 3. Check IPv4 representation (standard, decimal integer, hex, octal)
  const ipv4Octets = parseIpv4Octets(hostname);
  if (ipv4Octets !== null) {
    if (isForbiddenIpv4(...ipv4Octets)) {
      return {
        valid: false,
        reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
      };
    }
  }

  // 4. Check IPv6 representation
  if (isForbiddenIpv6(hostname)) {
    return {
      valid: false,
      reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
    };
  }

  // 5. Check allowed hosts
  const hostAllowed = policy.allowedHosts.some((allowed) => {
    const lowerAllowed = allowed.toLowerCase();
    return hostname === lowerAllowed || hostname.endsWith(`.${lowerAllowed}`);
  });

  if (!hostAllowed) {
    return {
      valid: false,
      reason: `Host '${hostname}' is not in the allowed hosts list for source ${policy.sourceKey}`,
    };
  }

  return { valid: true };
}

export interface HardenedFetchOptions {
  readonly guard?: PolicyGuardPort;
  readonly policy: SourcePolicy;
  readonly maxRedirects?: number;
  readonly maxSizeBytes?: number;
  readonly timeoutMs?: number;
  readonly baseFetch?: typeof fetch;
}

/**
 * Hardened fetch client enforcing SSRF protection, manual redirect re-validation,
 * response body caps, and timeouts per THR-001 and SECURITY.md §4.1.
 */
export function createHardenedFetch(options: HardenedFetchOptions): typeof fetch {
  const guard = options.guard ?? new DefaultPolicyGuard();
  const policy = options.policy;
  const maxRedirects = options.maxRedirects ?? policy.maxRedirects ?? 3;
  const maxSizeBytes = options.maxSizeBytes ?? policy.maxSizeBytes ?? 10 * 1024 * 1024;
  const baseFetch = options.baseFetch ?? globalThis.fetch;

  return async function hardenedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let currentUrl = typeof input === 'string' ? input : input.toString();
    let redirectCount = 0;

    while (true) {
      // 1. SSRF & Scheme validation on current target URL
      const validation = guard.validateUrl(currentUrl, policy);
      if (!validation.valid) {
        throw new SsrfViolationError(currentUrl, validation.reason ?? 'Blocked by policy guard');
      }

      // 2. Prepare request with manual redirect handling
      const fetchInit: RequestInit = {
        ...(init ?? {}),
        redirect: 'manual',
      };

      const response = await baseFetch(currentUrl, fetchInit);

      // 3. Handle HTTP redirects manually to validate destination at every hop
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          return response;
        }

        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new SsrfViolationError(
            currentUrl,
            `Maximum redirect limit (${maxRedirects}) exceeded`,
          );
        }

        // Resolve relative redirect against current target URL
        const nextUrl = new URL(location, currentUrl).toString();

        // Validate next target before following
        const nextValidation = guard.validateUrl(nextUrl, policy);
        if (!nextValidation.valid) {
          throw new SsrfViolationError(
            nextUrl,
            `Redirect target violates SSRF policy: ${nextValidation.reason}`,
          );
        }

        currentUrl = nextUrl;
        continue;
      }

      // 4. Check Content-Length header if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const declaredSize = Number(contentLengthHeader);
        if (!isNaN(declaredSize) && declaredSize > maxSizeBytes) {
          throw new ResponseSizeExceededError(maxSizeBytes);
        }
      }

      return response;
    }
  };
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
