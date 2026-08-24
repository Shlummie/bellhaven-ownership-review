const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function retryDelay(response, attempt) {
  const retryAfterHeader = response?.headers.get("retry-after")?.trim();
  if (retryAfterHeader) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(retryAfter * 1000, 2_000);
    }
  }
  return Math.min(200 * (2 ** attempt), 1_500);
}

export async function fetchWithPolicy(url, init = {}, {
  timeoutMs = 15_000,
  attempts = 1,
  retryStatuses = RETRYABLE_STATUS,
  fetchImpl = fetch,
} = {}) {
  const method = String(init.method || "GET").toUpperCase();
  const safeAttempts = method === "GET" || method === "HEAD" ? Math.max(1, attempts) : 1;
  let lastError;

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetchImpl(url, { ...init, signal });
      if (attempt + 1 < safeAttempts && retryStatuses.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        await sleep(retryDelay(response, attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= safeAttempts || init.signal?.aborted) throw error;
      await sleep(retryDelay(null, attempt));
    }
  }
  throw lastError ?? new Error(`Request failed for ${url}`);
}

export async function readTextLimited(response, maxBytes = 2 * 1024 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response too large").catch(() => {});
        throw new Error(`Response exceeded the ${maxBytes}-byte safety limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
