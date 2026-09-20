export function estimateJsonBytesBounded(value: unknown, limit: number, seen = new WeakSet<object>()): number {
  const normalizedLimit = normalizeLimit(limit);
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return jsonStringBytesBounded(value, normalizedLimit);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return Math.min(normalizedLimit + 1, 4);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    return bytes > normalizedLimit ? normalizedLimit + 1 : bytes;
  }

  if (seen.has(value)) return normalizedLimit + 1;
  seen.add(value);
  try {
    let bytes = 2;
    if (bytes > normalizedLimit) return normalizedLimit + 1;

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) {
          bytes += 1;
          if (bytes > normalizedLimit) return normalizedLimit + 1;
        }
        const remaining = Math.max(0, normalizedLimit - bytes);
        bytes += estimateJsonBytesBounded(value[index], remaining, seen);
        if (bytes > normalizedLimit) return normalizedLimit + 1;
      }
      return bytes;
    }

    let first = true;
    const record = value as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (!first) {
        bytes += 1;
        if (bytes > normalizedLimit) return normalizedLimit + 1;
      }
      first = false;
      const keyBytes = jsonStringBytesBounded(key, Math.max(0, normalizedLimit - bytes));
      bytes += keyBytes + 1;
      if (bytes > normalizedLimit) return normalizedLimit + 1;
      bytes += estimateJsonBytesBounded(record[key], Math.max(0, normalizedLimit - bytes), seen);
      if (bytes > normalizedLimit) return normalizedLimit + 1;
    }
    return bytes;
  } finally {
    seen.delete(value);
  }
}

function jsonStringBytesBounded(value: string, limit: number): number {
  let bytes = 2;
  if (bytes > limit) return limit + 1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : Number.MAX_SAFE_INTEGER;
}
