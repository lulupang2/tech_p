/**
 * Encodes an arbitrary cursor payload into a base64url string.
 */
export function encodeOpaqueCursor(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decodes a base64url opaque cursor into its original object payload.
 */
export function decodeOpaqueCursor<T extends Record<string, unknown> = Record<string, unknown>>(
  opaqueCursor: string,
): T | null {
  try {
    const json = Buffer.from(opaqueCursor, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
