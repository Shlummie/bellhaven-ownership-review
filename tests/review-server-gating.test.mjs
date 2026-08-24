import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  emptyState,
  mergePipelineRun,
  readState,
  recordPipelineFailure,
  writeState,
} from "../lib/state.mjs";

const SESSION_TOKEN = "fixture-review-session-token-000000000000";
const CRM_TOKEN = "fixture-crm-token";
const ALLOWED_ORIGIN = "http://localhost:3000";
const BLOCKED_MESSAGE = "The latest scan failed, so approvals and rejections are paused to prevent decisions on stale evidence. Run a successful daily scan, then review the refreshed proposal.";
const UNCERTAIN_REJECTION_MESSAGE = "The previous approval may already have changed the CRM, so this proposal cannot be rejected. Retry approval to reconcile the idempotent operation, or run a fresh scan and review the resulting state.";

function source() {
  return {
    scraped_at: "2026-08-24T00:00:00.000Z",
    website_base: "https://website.test",
    directory_pages: 1,
    directory_claimed_count: 0,
    homepage_claimed_count: 0,
    count_discrepancy: false,
    locations: [],
  };
}

function proposal() {
  return {
    id: "prop_deadbeef",
    fingerprint: "review_server_gate_fixture",
    kind: "update",
    title: "Fixture update",
    summary: "A deterministic fixture proposal.",
    risk: "standard",
    location: null,
    account: { account_id: "account-fixture", name: "Fixture account" },
    related_account: null,
    match: null,
    application: {
      type: "patch",
      account_id: "account-fixture",
      patch: { status: "Active" },
      expected: {
        status: "Inactive",
        parent_id: "bellhaven-parent",
        lifetime_revenue: 0,
        outstanding_ar: 0,
      },
    },
  };
}

function signingKey() {
  return createHash("sha256").update(`bellhaven-review-intent:${CRM_TOKEN}`).digest();
}

function mergeSuccessfulRun(state, item, day) {
  return mergePipelineRun(state, {
    source: source(),
    accounts: [],
    proposals: [item],
    startedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    completedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:01.000Z`,
    signingKey: signingKey(),
  });
}

async function availablePort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Review server exited with ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The server may not have bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for review server: ${output()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  let timer;
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), 2_000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (timedOut && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function submitDecision(baseUrl, decision) {
  const response = await fetch(`${baseUrl}/api/proposals/prop_deadbeef/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ALLOWED_ORIGIN,
      "x-review-session": SESSION_TOKEN,
    },
    body: JSON.stringify({ decision, reviewer_note: "fixture" }),
  });
  return { response, payload: await response.json() };
}

test("the review API pauses every decision after a failed scan until a successful run clears the gate", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bellhaven-review-gate-"));
  const statePath = path.join(temporaryRoot, "review-state.json");
  const configPath = path.join(temporaryRoot, ".env.test");
  await writeFile(configPath, "# Isolate the child process from user configuration.\n", "utf8");

  const crmServer = createServer((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "fixture pre-write failure" }));
  });
  crmServer.listen(0, "127.0.0.1");
  await once(crmServer, "listening");
  const crmAddress = crmServer.address();
  assert(crmAddress && typeof crmAddress === "object");
  t.after(() => new Promise((resolve, reject) => crmServer.close((error) => error ? reject(error) : resolve())));

  const item = proposal();
  const state = emptyState();
  mergeSuccessfulRun(state, item, 24);
  recordPipelineFailure(state, {
    startedAt: "2026-08-25T00:00:00.000Z",
    completedAt: "2026-08-25T00:00:01.000Z",
    error: "fixture source scan failed",
  });
  await writeState(statePath, state);

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, ["scripts/review-server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BELLHAVEN_CONFIG_PATH: configPath,
      BELLHAVEN_RUNTIME_DIR: temporaryRoot,
      BELLHAVEN_WEBSITE_BASE: "https://website.test",
      ALLOW_INSECURE_LOOPBACK: "1",
      CRM_ALLOWED_HOSTS: "127.0.0.1",
      CRM_API_BASE: `http://127.0.0.1:${crmAddress.port}/api/v1`,
      CRM_API_TOKEN: CRM_TOKEN,
      REVIEW_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      REVIEW_API_PORT: String(port),
      REVIEWER_ID: "test-reviewer",
      REVIEW_SESSION_TOKEN: SESSION_TOKEN,
      REVIEW_STATE_PATH: statePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await stopServer(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => `${stdout}\n${stderr}`);

  for (const decision of ["approve", "reject"]) {
    const { response, payload } = await submitDecision(baseUrl, decision);
    assert.equal(response.status, 409);
    assert.deepEqual(payload, { error: BLOCKED_MESSAGE });
  }

  const blockedState = await readState(statePath);
  assert.equal(blockedState.proposals[item.id].status, "pending");
  assert.equal(blockedState.proposals[item.id].decision, null);
  assert.equal(blockedState.last_pipeline_failure.error, "fixture source scan failed");

  mergeSuccessfulRun(blockedState, item, 26);
  await writeState(statePath, blockedState);
  assert.equal((await readState(statePath)).last_pipeline_failure, null);

  blockedState.proposals[item.id].status = "failed";
  blockedState.proposals[item.id].decision = {
    value: "approve",
    reviewer_note: "fixture approval",
    reviewer_id: "test-reviewer",
    decided_at: "2026-08-26T01:00:00.000Z",
  };
  blockedState.proposals[item.id].application_result = {
    error: "CRM patch could not be verified",
    failed_at: "2026-08-26T01:00:01.000Z",
    outcome: "unknown",
  };
  await writeState(statePath, blockedState);

  const uncertain = await submitDecision(baseUrl, "reject");
  assert.equal(uncertain.response.status, 409);
  assert.deepEqual(uncertain.payload, { error: UNCERTAIN_REJECTION_MESSAGE });
  const uncertainState = await readState(statePath);
  assert.equal(uncertainState.proposals[item.id].status, "failed");
  assert.equal(uncertainState.proposals[item.id].decision.value, "approve");
  assert.equal(uncertainState.proposals[item.id].application_result.outcome, "unknown");

  const retry = await submitDecision(baseUrl, "approve");
  assert.equal(retry.response.status, 502);
  assert.match(retry.payload.error, /fixture pre-write failure/);
  assert.equal(Object.hasOwn(retry.payload.proposal, "intent_signature"), false);
  const retryState = await readState(statePath);
  assert.equal(retryState.proposals[item.id].status, "failed");
  assert.equal(retryState.proposals[item.id].application_result.outcome, "unknown");

  const rejectAfterRetry = await submitDecision(baseUrl, "reject");
  assert.equal(rejectAfterRetry.response.status, 409);
  assert.deepEqual(rejectAfterRetry.payload, { error: UNCERTAIN_REJECTION_MESSAGE });

  retryState.proposals[item.id].application_result.outcome = "no_write";
  await writeState(statePath, retryState);
  const { response, payload } = await submitDecision(baseUrl, "reject");
  assert.equal(response.status, 200);
  assert.equal(payload.proposal.status, "rejected");
  assert.equal(payload.proposal.decision.value, "reject");
  assert.equal(payload.proposal.decision.reviewer_id, "test-reviewer");
  assert.equal(Object.hasOwn(payload.proposal, "intent_signature"), false);
  assert.equal(typeof (await readState(statePath)).proposals[item.id].intent_signature, "string");
});
