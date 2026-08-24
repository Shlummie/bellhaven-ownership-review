#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { applicationFailureOutcome, applyProposal } from "../lib/apply.mjs";
import { getRuntimeConfig, loadLocalEnv } from "../lib/config.mjs";
import { runPipeline } from "../lib/pipeline.mjs";
import {
  readState,
  recoverInterruptedApplications,
  verifyProposalIntent,
  withStateLock,
  writeState,
} from "../lib/state.mjs";

await loadLocalEnv();
const config = getRuntimeConfig();
const port = Number(process.env.REVIEW_API_PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("REVIEW_API_PORT must be an integer between 1024 and 65535");
}
const sessionToken = process.env.REVIEW_SESSION_TOKEN?.trim();
if (!sessionToken || sessionToken.length < 32) {
  throw new Error("REVIEW_SESSION_TOKEN must be provided by the local supervisor");
}
const reviewerId = process.env.REVIEWER_ID?.trim().slice(0, 120) || "local-reviewer";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const allowedOrigins = new Set(
  (process.env.REVIEW_ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      let origin;
      try {
        origin = new URL(value);
      } catch {
        throw new Error(`Invalid REVIEW_ALLOWED_ORIGINS entry: ${value}`);
      }
      if (
        origin.protocol !== "http:"
        || !LOOPBACK_HOSTS.has(origin.hostname)
        || origin.pathname !== "/"
        || origin.username
        || origin.password
        || origin.search
        || origin.hash
      ) {
        throw new Error(`Review origins must be loopback HTTP origins: ${value}`);
      }
      return origin.origin;
    }),
);
let mutationQueue = Promise.resolve();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function withMutationLock(callback) {
  const task = mutationQueue.then(callback, callback);
  mutationQueue = task.catch(() => {});
  return task;
}

function requestOrigin(request) {
  return request.headers.origin?.replace(/\/$/, "") || null;
}

function corsHeaders(request) {
  const origin = requestOrigin(request);
  return {
    ...(origin && allowedOrigins.has(origin) ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-review-session",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "same-site",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    vary: "Origin",
  };
}

function json(response, status, payload, request) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders(request) });
  response.end(JSON.stringify(payload));
}

function validSession(request) {
  const supplied = request.headers["x-review-session"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(sessionToken, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function validateHost(request) {
  const host = request.headers.host;
  if (!host) throw new HttpError(400, "Host header is required");
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new HttpError(400, "Host header is invalid");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new HttpError(403, "Loopback Host header is required");
  }
}

function authorize(request, { requireOrigin = true } = {}) {
  validateHost(request);
  if (!validSession(request)) throw new HttpError(401, "Invalid local review session");
  const origin = requestOrigin(request);
  if (requireOrigin && (!origin || !allowedOrigins.has(origin))) {
    throw new HttpError(403, "Request origin is not allowed");
  }
  if (origin && !allowedOrigins.has(origin)) {
    throw new HttpError(403, "Request origin is not allowed");
  }
}

async function readJson(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body contains invalid JSON");
  }
}

function publicProposal(storedProposal) {
  const proposal = { ...storedProposal };
  delete proposal.intent_signature;
  return proposal;
}

function reviewView(state) {
  const proposals = Object.values(state.proposals)
    .map(publicProposal)
    .sort((left, right) => {
      const order = { pending: 0, failed: 1, applying: 2, approved: 3, rejected: 4, superseded: 5 };
      return (order[left.status] ?? 9) - (order[right.status] ?? 9)
        || left.title.localeCompare(right.title);
    });
  const counts = proposals.reduce((result, proposal) => {
    result[proposal.status] = (result[proposal.status] ?? 0) + 1;
    return result;
  }, {});
  return {
    version: state.version,
    updated_at: state.updated_at,
    latest_run: state.runs.find((run) => run.id === state.latest_run_id) ?? null,
    last_pipeline_failure: state.last_pipeline_failure,
    counts,
    source: state.latest_snapshot ? {
      scraped_at: state.latest_snapshot.source.scraped_at,
      website_location_count: state.latest_snapshot.source.locations.length,
      homepage_claimed_count: state.latest_snapshot.source.homepage_claimed_count,
      directory_claimed_count: state.latest_snapshot.source.directory_claimed_count,
      count_discrepancy: state.latest_snapshot.source.count_discrepancy,
    } : null,
    proposals,
  };
}

async function decide(proposalId, body) {
  return withMutationLock(() => withStateLock(config.statePath, async () => {
    const state = await readState(config.statePath);
    const proposal = state.proposals[proposalId];
    if (!proposal) return { status: 404, payload: { error: "Proposal not found" } };
    if (!["approve", "reject"].includes(body.decision)) {
      return { status: 400, payload: { error: "decision must be approve or reject" } };
    }
    const reviewerNote = String(body.reviewer_note ?? "").trim();
    if (reviewerNote.length > 2_000) {
      return { status: 400, payload: { error: "reviewer_note must be 2,000 characters or fewer" } };
    }
    if (state.last_pipeline_failure !== null && state.last_pipeline_failure !== undefined) {
      return {
        status: 409,
        payload: {
          error: "The latest scan failed, so approvals and rejections are paused to prevent decisions on stale evidence. Run a successful daily scan, then review the refreshed proposal.",
        },
      };
    }
    if (proposal.status === "superseded") {
      return { status: 409, payload: { error: "Proposal is no longer supported by the latest scan" } };
    }
    if (proposal.status === "applying") {
      return { status: 409, payload: { error: "Proposal is already being applied" } };
    }
    if (["approved", "rejected"].includes(proposal.status)) {
      if ((proposal.status === "approved" && body.decision === "approve") || (proposal.status === "rejected" && body.decision === "reject")) {
        return { status: 200, payload: { proposal: publicProposal(proposal) } };
      }
      return { status: 409, payload: { error: `Proposal was already ${proposal.status}` } };
    }
    if (!["pending", "failed"].includes(proposal.status)) {
      return { status: 409, payload: { error: `Proposal cannot be decided from status ${proposal.status}` } };
    }
    if (
      proposal.status === "failed"
      && body.decision === "reject"
      && proposal.application_result?.outcome !== "no_write"
    ) {
      return {
        status: 409,
        payload: {
          error: "The previous approval may already have changed the CRM, so this proposal cannot be rejected. Retry approval to reconcile the idempotent operation, or run a fresh scan and review the resulting state.",
        },
      };
    }
    if (!verifyProposalIntent(proposal, config.intentSigningKey)) {
      return { status: 409, payload: { error: "Proposal intent signature is missing or invalid. Run a fresh pipeline scan before deciding it." } };
    }

    const decidedAt = new Date().toISOString();
    proposal.decision = {
      value: body.decision,
      reviewer_note: reviewerNote,
      reviewer_id: reviewerId,
      decided_at: decidedAt,
    };
    if (body.decision === "reject") {
      proposal.status = "rejected";
      proposal.application_result = null;
      await writeState(config.statePath, state);
      return { status: 200, payload: { proposal: publicProposal(proposal) } };
    }

    const unresolvedPriorOutcome = proposal.status === "failed"
      && proposal.application_result?.outcome !== "no_write";
    proposal.status = "applying";
    proposal.application_result = null;
    await writeState(config.statePath, state);
    let result;
    try {
      result = await applyProposal(proposal, config);
    } catch (error) {
      proposal.status = "failed";
      proposal.application_result = {
        error: error instanceof Error ? error.message : String(error),
        failed_at: new Date().toISOString(),
        outcome: unresolvedPriorOutcome ? "unknown" : applicationFailureOutcome(error),
      };
      await writeState(config.statePath, state);
      return { status: 502, payload: { error: proposal.application_result.error, proposal: publicProposal(proposal) } };
    }
    proposal.status = "approved";
    proposal.application_result = {
      result,
      applied_at: new Date().toISOString(),
    };
    await writeState(config.statePath, state);
    return { status: 200, payload: { proposal: publicProposal(proposal) } };
  }));
}

await withStateLock(config.statePath, async () => {
  const state = await readState(config.statePath);
  if (recoverInterruptedApplications(state)) await writeState(config.statePath, state);
});

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      validateHost(request);
      const origin = requestOrigin(request);
      if (!origin || !allowedOrigins.has(origin)) throw new HttpError(403, "Request origin is not allowed");
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      validateHost(request);
      json(response, 200, { ok: true, service: "bellhaven-review-api" }, request);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      authorize(request);
      json(response, 200, reviewView(await readState(config.statePath)), request);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/pipeline/run") {
      authorize(request);
      const result = await withMutationLock(() => runPipeline({ config }));
      json(response, 200, { run: result.run }, request);
      return;
    }
    const decisionMatch = url.pathname.match(/^\/api\/proposals\/(prop_[a-f0-9]+)\/decision$/);
    if (request.method === "POST" && decisionMatch) {
      authorize(request);
      const outcome = await decide(decisionMatch[1], await readJson(request));
      json(response, outcome.status, outcome.payload, request);
      return;
    }
    json(response, 404, { error: "Not found" }, request);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    json(response, status, { error: error instanceof Error ? error.message : String(error) }, request);
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, "127.0.0.1", () => {
  console.log(`Review API listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.send?.({ type: "shutdown-request" });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
