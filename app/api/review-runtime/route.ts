export const dynamic = "force-dynamic";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const STATE_TIMEOUT_MS = 12_000;

function response(status: number, payload: object) {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), geolocation=(), microphone=()",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

function isInitialReviewState(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { proposals?: unknown; counts?: unknown; source?: unknown };
  return Array.isArray(candidate.proposals)
    && Boolean(candidate.counts && typeof candidate.counts === "object" && !Array.isArray(candidate.counts))
    && (candidate.source === null || typeof candidate.source === "object");
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!LOOPBACK_HOSTS.has(requestUrl.hostname) || (fetchSite && !["same-origin", "none"].includes(fetchSite))) {
    return response(403, { error: "The review runtime is available only from the local application." });
  }

  const apiBase = process.env.REVIEW_UI_API_BASE?.trim().replace(/\/$/, "");
  const sessionToken = process.env.REVIEW_UI_SESSION_TOKEN?.trim();
  if (!apiBase || !sessionToken || sessionToken.length < 32) {
    return response(503, { error: "The local review supervisor has not supplied a runtime session." });
  }

  let apiUrl: URL;
  try {
    apiUrl = new URL(apiBase);
  } catch {
    return response(503, { error: "The local review supervisor supplied an invalid API address." });
  }
  if (apiUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(apiUrl.hostname)) {
    return response(503, { error: "The local review supervisor supplied an unsafe API address." });
  }

  try {
    const stateResponse = await fetch(`${apiBase}/api/state`, {
      cache: "no-store",
      headers: {
        origin: requestUrl.origin,
        "x-review-session": sessionToken,
      },
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    });
    const stateText = await stateResponse.text();
    let initialState: unknown;
    try {
      initialState = stateText ? JSON.parse(stateText) : null;
    } catch {
      return response(502, { error: "The local review service returned an unreadable initial state." });
    }
    if (!stateResponse.ok) {
      const sessionRejected = [401, 403].includes(stateResponse.status);
      return response(sessionRejected ? 503 : 502, {
        error: sessionRejected
          ? "The local review session was rejected. Restart npm run dev to create a fresh session."
          : `The local review service could not load its initial state (${stateResponse.status}).`,
      });
    }
    if (!isInitialReviewState(initialState)) {
      return response(502, { error: "The local review service returned an invalid initial state." });
    }
    return response(200, {
      api_base: apiBase,
      session_token: sessionToken,
      initial_state: initialState,
    });
  } catch (caught) {
    const timedOut = caught instanceof DOMException && ["AbortError", "TimeoutError"].includes(caught.name);
    return response(timedOut ? 504 : 502, {
      error: timedOut
        ? "The local review service timed out while loading its initial state."
        : "The local review service is unreachable. Confirm npm run dev is still running.",
    });
  }
}
