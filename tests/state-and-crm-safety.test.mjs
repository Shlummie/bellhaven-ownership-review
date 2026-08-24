import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { CrmClient } from "../lib/crm.mjs";
import {
  emptyState,
  mergePipelineRun,
  proposalIntentSignature,
  recoverInterruptedApplications,
  withStateLock,
  verifyProposalIntent,
} from "../lib/state.mjs";

async function backdate(filePath, milliseconds = 60_000) {
  const then = new Date(Date.now() - milliseconds);
  await utimes(filePath, then, then);
}

async function removeFixtureDirectory(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

let witnessCandidatePort = 12_000 + (process.pid % 2_000);

async function openWitness(port = 0) {
  const token = randomUUID();
  const server = createServer((socket) => socket.end(`${token}\n`));
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port, token };
}

async function closeWitness(witness) {
  if (!witness.server.listening) return;
  await new Promise((resolve, reject) => witness.server.close((error) => error ? reject(error) : resolve()));
}

async function closedWitnessIdentity() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = witnessCandidatePort;
    witnessCandidatePort += 1;
    try {
      const witness = await openWitness(port);
      await closeWitness(witness);
      return { port: witness.port, token: witness.token };
    } catch (error) {
      if (!["EACCES", "EADDRINUSE"].includes(error?.code)) throw error;
    }
  }
  throw new Error("Could not reserve a deterministic closed witness port for the lock fixture");
}

function pipeWitnessEndpoint(token) {
  const endpointId = createHash("sha256").update(token).digest("hex").slice(0, 32);
  if (process.platform === "win32") return `\\\\.\\pipe\\bellhaven-review-${endpointId}`;
  if (process.platform === "linux") return `\0bellhaven-review-${endpointId}`;
  return path.join(os.tmpdir(), `bellhaven-review-${process.getuid?.() ?? "user"}-${endpointId}.sock`);
}

function createHmacResponder(responseToken) {
  return createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
      const lineEnd = request.indexOf("\n");
      if (lineEnd === -1) return;
      const challenge = request.slice(0, lineEnd);
      const response = createHmac("sha256", responseToken).update(challenge).digest("base64url");
      socket.end(`${response}\n`);
    });
  });
}

async function openPipeResponder(endpointToken, responseToken) {
  const endpoint = pipeWitnessEndpoint(endpointToken);
  const server = createHmacResponder(responseToken);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return { endpoint, server };
}

async function openTcpHmacResponder(responseToken) {
  const server = createHmacResponder(responseToken);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { port: address.port, server };
}

async function closePipeResponder(responder) {
  if (responder.server.listening) {
    await new Promise((resolve, reject) => responder.server.close((error) => error ? reject(error) : resolve()));
  }
  if (!["linux", "win32"].includes(process.platform)) {
    await rm(responder.endpoint, { force: true });
  }
}

function source(locations = []) {
  return {
    scraped_at: "2026-08-24T00:00:00.000Z",
    website_base: "https://example.test",
    directory_pages: 1,
    directory_claimed_count: locations.length,
    homepage_claimed_count: locations.length,
    count_discrepancy: false,
    locations,
  };
}

function proposal() {
  return {
    id: "prop_state_fixture",
    fingerprint: "state_fixture",
    kind: "update",
    title: "Fixture update",
    application: {
      type: "patch",
      account_id: "account-fixture",
      patch: { status: "Active" },
      expected: { status: "Inactive" },
    },
  };
}

function merge(state, proposals, day) {
  return mergePipelineRun(state, {
    source: source(),
    accounts: [],
    proposals,
    startedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    completedAt: `2026-08-${String(day).padStart(2, "0")}T00:00:01.000Z`,
    signingKey: "fixture-signing-key-with-enough-entropy",
  });
}

test("a superseded intent returns to pending when the same evidence recurs", () => {
  const state = emptyState();
  const item = proposal();
  merge(state, [item], 24);
  merge(state, [], 25);
  assert.equal(state.proposals[item.id].status, "superseded");

  const run = merge(state, [item], 26);
  assert.equal(state.proposals[item.id].status, "pending");
  assert.equal(state.proposals[item.id].decision, null);
  assert.equal(state.proposals[item.id].application_result, null);
  assert.equal(run.pending_count, 1);
});

test("an unknown failed intent preserves approval evidence across supersession and reactivation", () => {
  const state = emptyState();
  const item = proposal();
  merge(state, [item], 24);
  state.proposals[item.id].status = "failed";
  state.proposals[item.id].decision = { value: "approve", decided_at: "2026-08-24T01:00:00.000Z" };
  state.proposals[item.id].application_result = {
    error: "fixture verification failure",
    failed_at: "2026-08-24T01:00:01.000Z",
    outcome: "unknown",
  };

  merge(state, [], 25);
  assert.equal(state.proposals[item.id].status, "superseded");
  assert.equal(state.proposals[item.id].decision.value, "approve");
  assert.equal(state.proposals[item.id].application_result.outcome, "unknown");

  const run = merge(state, [item], 26);
  assert.equal(state.proposals[item.id].status, "failed");
  assert.equal(state.proposals[item.id].decision.value, "approve");
  assert.equal(state.proposals[item.id].application_result.outcome, "unknown");
  assert.equal(run.pending_count, 0);
});

test("an interrupted approval that disappears is superseded with an unknown outcome", () => {
  const state = emptyState();
  const item = proposal();
  merge(state, [item], 24);
  state.proposals[item.id].status = "applying";
  state.proposals[item.id].decision = { value: "approve", decided_at: "2026-08-24T01:00:00.000Z" };
  state.proposals[item.id].application_result = {
    error: "prior retryable validation failure",
    failed_at: "2026-08-24T00:30:00.000Z",
    outcome: "no_write",
  };

  merge(state, [], 25);
  assert.equal(state.proposals[item.id].status, "superseded");
  assert.equal(state.proposals[item.id].decision.value, "approve");
  assert.equal(state.proposals[item.id].application_result.outcome, "unknown");
  assert.match(state.proposals[item.id].application_result.error, /interrupted/i);
});

test("interrupted applying operations recover to an explicit retryable failure", () => {
  const state = emptyState();
  const item = proposal();
  state.proposals[item.id] = { ...item, status: "applying", application_result: null };

  assert.equal(recoverInterruptedApplications(state, "2026-08-24T02:00:00.000Z"), 1);
  assert.equal(state.proposals[item.id].status, "failed");
  assert.equal(state.proposals[item.id].application_result.outcome, "unknown");
  assert.match(state.proposals[item.id].application_result.error, /interrupted/i);
});

test("proposal intent signatures reject local state tampering", () => {
  const signingKey = "fixture-signing-key-with-enough-entropy";
  const signed = proposal();
  signed.intent_signature = proposalIntentSignature(signed, signingKey);
  assert.equal(verifyProposalIntent(signed, signingKey), true);

  signed.application.patch.status = "Inactive";
  assert.equal(verifyProposalIntent(signed, signingKey), false);
});

test("the cross-process state lock serializes competing mutations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-state-lock-"));
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, JSON.stringify({ value: 0 }), "utf8");
  try {
    const increment = () => withStateLock(statePath, async () => {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      state.value += 1;
      await writeFile(statePath, JSON.stringify(state), "utf8");
    });
    await Promise.all([increment(), increment()]);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).value, 2);
  } finally {
    await removeFixtureDirectory(directory);
  }
});

test("witness cleanup destroys incomplete local clients without delaying lock completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-witness-cleanup-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  let client;
  let clientClosed;
  const startedAt = performance.now();

  try {
    await withStateLock(statePath, async () => {
      const owner = JSON.parse(await readFile(lockPath, "utf8"));
      const target = owner.witness_kind === "tcp-hmac"
        ? { host: "127.0.0.1", port: owner.witness_port }
        : pipeWitnessEndpoint(owner.witness_token);
      client = createConnection(target);
      clientClosed = new Promise((resolve) => client.once("close", resolve));
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      client.write("incomplete");
    }, { timeoutMs: 100 });
    await Promise.race([
      clientClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("witness client did not close")), 400)),
    ]);
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 500, `witness cleanup was held open for ${elapsedMs.toFixed(1)}ms`);
    assert.equal(client.destroyed, true);
  } finally {
    client?.destroy();
    await removeFixtureDirectory(directory);
  }
});

test("simultaneous stale-lock contenders cannot remove a replacement generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-stale-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const witness = await closedWitnessIdentity();
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "dead-lock-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: witness.port,
    witness_token: witness.token,
  }), { encoding: "utf8", mode: 0o600 });
  await backdate(lockPath);

  let active = 0;
  let maximumActive = 0;
  let completed = 0;
  try {
    await Promise.all(Array.from({ length: 12 }, () => withStateLock(statePath, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 8));
        completed += 1;
      } finally {
        active -= 1;
      }
    }, { timeoutMs: 5_000, staleAfterMs: 0 })));

    assert.equal(maximumActive, 1);
    assert.equal(completed, 12);
    await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.json.lock")), []);
  } finally {
    await removeFixtureDirectory(directory);
  }
});

test("a dead stale-lock reaper claim can be recovered without touching a new generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-reaper-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const nonce = "dead-reaper-generation";
  const generation = `nonce-${createHash("sha256").update(nonce).digest("hex")}`;
  const markerPath = `${lockPath}.owner.${generation.slice(0, 48)}`;
  const lockWitness = await closedWitnessIdentity();
  const claimWitness = await closedWitnessIdentity();
  const crashedClaimPath = `${markerPath}.reap.${process.pid}.${claimWitness.port}.${claimWitness.token}`;
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce,
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: lockWitness.port,
    witness_token: lockWitness.token,
  }), { encoding: "utf8", mode: 0o600 });
  await writeFile(crashedClaimPath, JSON.stringify({
    pid: process.pid,
    nonce: "crashed-reaper",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: claimWitness.port,
    witness_token: claimWitness.token,
  }), { encoding: "utf8", mode: 0o600 });
  await backdate(lockPath);
  await backdate(crashedClaimPath);

  try {
    let entered = false;
    await withStateLock(statePath, async () => {
      entered = true;
    }, { timeoutMs: 5_000, staleAfterMs: 0 });
    assert.equal(entered, true);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.json.lock")), []);
  } finally {
    await removeFixtureDirectory(directory);
  }
});

test("a dead authenticated TCP reaper claim is parsed and recovered", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-tcp-reaper-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const nonce = "dead-tcp-reaper-generation";
  const generation = `nonce-${createHash("sha256").update(nonce).digest("hex")}`;
  const markerPath = `${lockPath}.owner.${generation.slice(0, 48)}`;
  const lockWitness = await closedWitnessIdentity();
  const claimWitness = await closedWitnessIdentity();
  const claimToken = randomUUID();
  const crashedClaimPath = `${markerPath}.reap.${process.pid}.tcp-hmac.${claimWitness.port}.${claimToken}`;
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce,
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: lockWitness.port,
    witness_token: lockWitness.token,
  }), { encoding: "utf8", mode: 0o600 });
  await writeFile(crashedClaimPath, JSON.stringify({
    pid: process.pid,
    nonce: "crashed-tcp-reaper",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_kind: "tcp-hmac",
    witness_port: claimWitness.port,
    witness_token: claimToken,
  }), { encoding: "utf8", mode: 0o600 });
  await backdate(lockPath);
  await backdate(crashedClaimPath);

  try {
    let entered = false;
    await withStateLock(statePath, async () => { entered = true; }, { timeoutMs: 5_000, staleAfterMs: 0 });
    assert.equal(entered, true);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.json.lock")), []);
  } finally {
    await removeFixtureDirectory(directory);
  }
});

test("a bound kernel witness keeps a live lock fail-closed even when its PID is reused", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-live-witness-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const witness = await openWitness();
  const owner = {
    pid: process.pid,
    nonce: "live-witness-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: witness.port,
    witness_token: witness.token,
  };
  const serializedOwner = JSON.stringify(owner);
  await writeFile(lockPath, serializedOwner, { encoding: "utf8", mode: 0o600 });

  try {
    await assert.rejects(
      withStateLock(statePath, async () => {}, { timeoutMs: 60, staleAfterMs: 0 }),
      /Timed out waiting for the review-state lock/,
    );
    assert.equal(await readFile(lockPath, "utf8"), serializedOwner);
  } finally {
    await closeWitness(witness);
    await removeFixtureDirectory(directory);
  }
});

test("a live publisher marker prevents takeover of a legacy partial lock file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-partial-publish-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const publisherWitness = await openWitness();
  const publisherNonce = "live-partial-publisher";
  const generation = `nonce-${createHash("sha256").update(publisherNonce).digest("hex")}`;
  const markerPath = `${lockPath}.owner.${generation.slice(0, 48)}`;
  const publisher = {
    pid: process.pid,
    nonce: publisherNonce,
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: publisherWitness.port,
    witness_token: publisherWitness.token,
  };
  await writeFile(markerPath, JSON.stringify(publisher), { encoding: "utf8", mode: 0o600 });
  await writeFile(lockPath, "", { encoding: "utf8", mode: 0o600 });
  await backdate(lockPath);

  try {
    let entered = false;
    await assert.rejects(
      withStateLock(statePath, async () => { entered = true; }, { timeoutMs: 80, staleAfterMs: 0 }),
      /Timed out waiting for the review-state lock/,
    );
    assert.equal(entered, false);
    assert.equal(await readFile(lockPath, "utf8"), "");
    assert.equal(await readFile(markerPath, "utf8"), JSON.stringify(publisher));
  } finally {
    await closeWitness(publisherWitness);
    await removeFixtureDirectory(directory);
  }
});

test("an unrelated listener reusing a dead witness port cannot impersonate the lock owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-reused-witness-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const unrelatedWitness = await openWitness();
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "dead-owner-reused-port-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: unrelatedWitness.port,
    witness_token: randomUUID(),
  }), { encoding: "utf8", mode: 0o600 });

  try {
    let entered = false;
    await withStateLock(statePath, async () => {
      entered = true;
    }, { timeoutMs: 2_000, staleAfterMs: 0 });
    assert.equal(entered, true);
    assert.equal(unrelatedWitness.server.listening, true);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.json.lock")), []);
  } finally {
    await closeWitness(unrelatedWitness);
    await removeFixtureDirectory(directory);
  }
});

test("an empty legacy witness response is rejected without crashing the contender", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-empty-witness-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const emptyResponder = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    emptyResponder.once("error", reject);
    emptyResponder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = emptyResponder.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "dead-owner-empty-witness-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: address.port,
    witness_token: randomUUID(),
  }), { encoding: "utf8", mode: 0o600 });

  try {
    let entered = false;
    await withStateLock(statePath, async () => { entered = true; }, { timeoutMs: 2_000, staleAfterMs: 0 });
    assert.equal(entered, true);
  } finally {
    await new Promise((resolve, reject) => emptyResponder.close((error) => error ? reject(error) : resolve()));
    await removeFixtureDirectory(directory);
  }
});

test("a silent listener on a reused legacy witness port cannot pin a dead owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-silent-witness-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const exitedChild = spawn(process.execPath, ["--eval", ""]);
  const exitedPid = exitedChild.pid;
  assert.ok(Number.isInteger(exitedPid));
  await new Promise((resolve, reject) => {
    exitedChild.once("error", reject);
    exitedChild.once("exit", resolve);
  });
  const silentResponder = createServer(() => {});
  await new Promise((resolve, reject) => {
    silentResponder.once("error", reject);
    silentResponder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = silentResponder.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(lockPath, JSON.stringify({
    pid: exitedPid,
    nonce: "dead-owner-silent-witness-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: address.port,
    witness_token: randomUUID(),
  }), { encoding: "utf8", mode: 0o600 });

  try {
    let entered = false;
    await withStateLock(statePath, async () => { entered = true; }, { timeoutMs: 2_000, staleAfterMs: 0 });
    assert.equal(entered, true);
  } finally {
    await new Promise((resolve, reject) => silentResponder.close((error) => error ? reject(error) : resolve()));
    await removeFixtureDirectory(directory);
  }
});

test("a responder on the same pipe cannot impersonate an owner without its private witness token", {
  skip: !["linux", "win32"].includes(process.platform),
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-spoofed-pipe-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const ownerToken = randomUUID();
  const responder = await openPipeResponder(ownerToken, randomUUID());
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "dead-owner-spoofed-pipe-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_kind: "pipe",
    witness_token: ownerToken,
  }), { encoding: "utf8", mode: 0o600 });

  try {
    let entered = false;
    await withStateLock(statePath, async () => { entered = true; }, { timeoutMs: 2_000, staleAfterMs: 0 });
    assert.equal(entered, true);
    assert.equal(responder.server.listening, true);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.json.lock")), []);
  } finally {
    await closePipeResponder(responder);
    await removeFixtureDirectory(directory);
  }
});

test("a matching authenticated TCP witness preserves a live fallback lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-live-tcp-hmac-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const ownerToken = randomUUID();
  const responder = await openTcpHmacResponder(ownerToken);
  const owner = {
    pid: process.pid,
    nonce: "live-tcp-hmac-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_kind: "tcp-hmac",
    witness_port: responder.port,
    witness_token: ownerToken,
  };
  const serializedOwner = JSON.stringify(owner);
  await writeFile(lockPath, serializedOwner, { encoding: "utf8", mode: 0o600 });

  try {
    await assert.rejects(
      withStateLock(statePath, async () => {}, { timeoutMs: 80, staleAfterMs: 0 }),
      /Timed out waiting for the review-state lock/,
    );
    assert.equal(await readFile(lockPath, "utf8"), serializedOwner);
  } finally {
    await new Promise((resolve, reject) => responder.server.close((error) => error ? reject(error) : resolve()));
    await removeFixtureDirectory(directory);
  }
});

test("wrong-HMAC and closed TCP endpoints cannot impersonate a fallback owner", async () => {
  for (const endpointKind of ["wrong-hmac", "closed"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `bellhaven-dead-tcp-hmac-${endpointKind}-`));
    const statePath = path.join(directory, "state.json");
    const lockPath = `${statePath}.lock`;
    const ownerToken = randomUUID();
    const responder = endpointKind === "wrong-hmac"
      ? await openTcpHmacResponder(randomUUID())
      : null;
    const closedIdentity = endpointKind === "closed" ? await closedWitnessIdentity() : null;
    const port = responder?.port ?? closedIdentity.port;
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      nonce: `dead-tcp-hmac-${endpointKind}-generation`,
      created_at: "2026-08-24T00:00:00.000Z",
      witness_kind: "tcp-hmac",
      witness_port: port,
      witness_token: ownerToken,
    }), { encoding: "utf8", mode: 0o600 });

    try {
      let entered = false;
      await withStateLock(statePath, async () => { entered = true; }, { timeoutMs: 2_000, staleAfterMs: 0 });
      assert.equal(entered, true, `${endpointKind} endpoint pinned the fallback lock`);
    } finally {
      if (responder?.server.listening) {
        await new Promise((resolve, reject) => responder.server.close((error) => error ? reject(error) : resolve()));
      }
      await removeFixtureDirectory(directory);
    }
  }
});

test("a silent TCP fallback witness remains fail-closed while its owner PID is live", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-silent-tcp-hmac-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const responderSockets = new Set();
  const silentResponder = createServer((socket) => {
    responderSockets.add(socket);
    socket.once("close", () => responderSockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    silentResponder.once("error", reject);
    silentResponder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = silentResponder.address();
  assert.ok(address && typeof address !== "string");
  const serializedOwner = JSON.stringify({
    pid: process.pid,
    nonce: "live-silent-tcp-hmac-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_kind: "tcp-hmac",
    witness_port: address.port,
    witness_token: randomUUID(),
  });
  await writeFile(lockPath, serializedOwner, { encoding: "utf8", mode: 0o600 });

  try {
    await assert.rejects(
      withStateLock(statePath, async () => {}, { timeoutMs: 150, staleAfterMs: 0 }),
      /Timed out waiting for the review-state lock/,
    );
    assert.equal(await readFile(lockPath, "utf8"), serializedOwner);
  } finally {
    for (const socket of responderSockets) socket.destroy();
    await new Promise((resolve, reject) => silentResponder.close((error) => error ? reject(error) : resolve()));
    await removeFixtureDirectory(directory);
  }
});

test("the generic POSIX fallback uses TCP HMAC and tears down incomplete clients", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-posix-fallback-lock-"));
  const statePath = path.join(directory, "state.json");
  const resultPath = path.join(directory, "result.json");
  const stateModuleUrl = new URL("../lib/state.mjs", import.meta.url).href;
  const workerSource = `
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { readFile, readdir, writeFile } = await import("node:fs/promises");
    const { createConnection } = await import("node:net");
    const { withStateLock } = await import(${JSON.stringify(stateModuleUrl)});
    const statePath = process.env.LOCK_STATE_PATH;
    const lockPath = \`\${statePath}.lock\`;
    let client;
    let clientClosed;
    let owner;
    await withStateLock(statePath, async () => {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
      client = createConnection({ host: "127.0.0.1", port: owner.witness_port });
      clientClosed = new Promise((resolve) => client.once("close", resolve));
      await new Promise((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      client.write("incomplete");
    }, { timeoutMs: 1_000 });
    await Promise.race([
      clientClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("TCP witness client did not close")), 400)),
    ]);
    const leftovers = (await readdir(${JSON.stringify(directory)}))
      .filter((name) => name.startsWith("state.json.lock"));
    await writeFile(process.env.RESULT_PATH, JSON.stringify({ owner, leftovers }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
    env: { ...process.env, LOCK_STATE_PATH: statePath, RESULT_PATH: resultPath },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });

  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`POSIX fallback worker exited with ${code ?? signal}: ${errorOutput}`));
      });
    });
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.owner.witness_kind, "tcp-hmac");
    assert.ok(Number.isInteger(result.owner.witness_port));
    assert.deepEqual(result.leftovers, []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await removeFixtureDirectory(directory);
  }
});

test("separate processes serialize while taking over the same stale generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-process-lock-"));
  const statePath = path.join(directory, "state.json");
  const tracePath = path.join(directory, "trace.log");
  const lockPath = `${statePath}.lock`;
  const witness = await closedWitnessIdentity();
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "dead-cross-process-generation",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: witness.port,
    witness_token: witness.token,
  }), { encoding: "utf8", mode: 0o600 });
  await backdate(lockPath);

  const stateModuleUrl = new URL("../lib/state.mjs", import.meta.url).href;
  const workerSource = `
    import { appendFile } from "node:fs/promises";
    import { withStateLock } from ${JSON.stringify(stateModuleUrl)};
    await withStateLock(process.env.LOCK_STATE_PATH, async () => {
      await appendFile(process.env.LOCK_TRACE_PATH, \`start:\${process.env.LOCK_WORKER_ID}\\n\`);
      await new Promise((resolve) => setTimeout(resolve, 35));
      await appendFile(process.env.LOCK_TRACE_PATH, \`end:\${process.env.LOCK_WORKER_ID}\\n\`);
    }, { timeoutMs: 8_000, staleAfterMs: 0 });
  `;

  try {
    const workers = Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
        env: {
          ...process.env,
          LOCK_STATE_PATH: statePath,
          LOCK_TRACE_PATH: tracePath,
          LOCK_WORKER_ID: String(index),
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let errorOutput = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { errorOutput += chunk; });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Lock worker ${index} exited with ${code ?? signal}: ${errorOutput}`));
      });
    }));
    await Promise.all(workers);

    let active = 0;
    const completed = new Set();
    for (const line of (await readFile(tracePath, "utf8")).trim().split(/\r?\n/)) {
      const [event, worker] = line.split(":");
      if (event === "start") {
        active += 1;
        assert.equal(active, 1, `worker ${worker} overlapped another lock holder`);
      } else {
        assert.equal(event, "end");
        assert.equal(active, 1, `worker ${worker} ended without owning the lock`);
        active -= 1;
        completed.add(worker);
      }
    }
    assert.equal(active, 0);
    assert.equal(completed.size, 6);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("state.json.lock")), []);
  } finally {
    await removeFixtureDirectory(directory);
  }
});

test("orphaned lock sidecars and state snapshots are swept after crash windows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-orphan-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const ownerGeneration = `nonce-${createHash("sha256").update("orphan-owner").digest("hex")}`;
  const ownerMarker = `${lockPath}.owner.${ownerGeneration.slice(0, 48)}`;
  const claimGeneration = `nonce-${createHash("sha256").update("orphan-claim").digest("hex")}`;
  const claimMarker = `${lockPath}.owner.${claimGeneration.slice(0, 48)}`;
  const ownerWitness = await closedWitnessIdentity();
  const claimWitness = await closedWitnessIdentity();
  const orphanClaim = `${claimMarker}.reap.${process.pid}.${claimWitness.port}.${claimWitness.token}`;
  const orphanStateTemp = `${statePath}.4242.${randomUUID()}.tmp`;
  const unrelatedTemps = [
    `${statePath}.notes.tmp`,
    `${statePath}.42.${"a".repeat(36)}.tmp`,
    `${statePath}.42.00000000-0000-5000-8000-000000000000.tmp`,
    `${statePath}.42.00000000-0000-4000-7000-000000000000.tmp`,
    `${statePath}.0.${randomUUID()}.tmp`,
    `${statePath}.042.${randomUUID()}.tmp`,
  ];
  const staleOwner = {
    pid: process.pid,
    nonce: "orphan-owner",
    created_at: "2026-08-24T00:00:00.000Z",
    witness_port: ownerWitness.port,
    witness_token: ownerWitness.token,
  };

  await writeFile(ownerMarker, JSON.stringify(staleOwner), { encoding: "utf8", mode: 0o600 });
  await writeFile(orphanClaim, JSON.stringify({
    ...staleOwner,
    nonce: "orphan-claim",
    witness_port: claimWitness.port,
    witness_token: claimWitness.token,
  }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(orphanStateTemp, JSON.stringify({ sensitive: "stale snapshot" }), { encoding: "utf8", mode: 0o600 });
  await Promise.all(unrelatedTemps.map((temporaryPath, index) => (
    writeFile(temporaryPath, `preserve-${index}`, { encoding: "utf8", mode: 0o600 })
  )));
  await backdate(ownerMarker);
  await backdate(orphanClaim);

  try {
    await withStateLock(statePath, async () => {}, { timeoutMs: 2_000, staleAfterMs: 0 });
    const remaining = await readdir(directory);
    assert.deepEqual(remaining.filter((name) => name.startsWith("state.json.lock")), []);
    assert.equal(remaining.includes(path.basename(orphanStateTemp)), false);
    await Promise.all(unrelatedTemps.map(async (temporaryPath, index) => {
      assert.equal(await readFile(temporaryPath, "utf8"), `preserve-${index}`);
    }));
  } finally {
    await removeFixtureDirectory(directory);
  }
});

test("lock wait timeout remains bounded under active contention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-timeout-lock-"));
  const statePath = path.join(directory, "state.json");
  let releaseHolder;
  let reportHeld;
  const holderReleased = new Promise((resolve) => { releaseHolder = resolve; });
  const holderEntered = new Promise((resolve) => { reportHeld = resolve; });

  const holder = withStateLock(statePath, async () => {
    reportHeld();
    await holderReleased;
  });
  const originalDateNow = Date.now;

  try {
    await holderEntered;
    Date.now = () => originalDateNow() - 24 * 60 * 60 * 1000;
    const startedAt = performance.now();
    await assert.rejects(
      withStateLock(statePath, async () => {}, { timeoutMs: 60 }),
      /Timed out waiting for the review-state lock/,
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs >= 40, `lock timeout returned too early after ${elapsedMs.toFixed(1)}ms`);
    assert.ok(elapsedMs < 500, `lock timeout exceeded its bounded allowance: ${elapsedMs.toFixed(1)}ms`);
  } finally {
    Date.now = originalDateNow;
    releaseHolder();
    await holder;
    await removeFixtureDirectory(directory);
  }
});

test("orphan cleanup cannot delay a contended lock timeout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bellhaven-cleanup-timeout-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  const witness = await openWitness();
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "live-owner-with-orphans",
    created_at: new Date().toISOString(),
    witness_port: witness.port,
    witness_token: witness.token,
  }), { encoding: "utf8", mode: 0o600 });
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(
    `${lockPath}.owner.nonce-orphan-${index}.gc.fixture`,
    "orphan",
    "utf8",
  )));

  try {
    const startedAt = performance.now();
    await assert.rejects(
      withStateLock(statePath, async () => {}, { timeoutMs: 20, staleAfterMs: 0 }),
      /Timed out waiting for the review-state lock/,
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 250, `pre-acquisition cleanup escaped the lock deadline: ${elapsedMs.toFixed(1)}ms`);
    const remainingOrphans = (await readdir(directory)).filter((name) => name.includes(".gc.fixture"));
    assert.ok(remainingOrphans.length > 0, "cleanup should yield at the acquisition deadline");
  } finally {
    await closeWitness(witness);
    await removeFixtureDirectory(directory);
  }
});

function crmAccount(index) {
  return { account_id: `account-${String(index).padStart(3, "0")}`, name: `Account ${index}` };
}

function clientWithPages(pageProvider) {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    return Response.json(pageProvider(Number(url.searchParams.get("page"))));
  };
  return new CrmClient({ baseUrl: "https://crm.test/api/v1", token: "fixture-token", fetchImpl });
}

test("CRM pagination returns each declared account exactly once", async () => {
  const first = Array.from({ length: 100 }, (_, index) => crmAccount(index));
  const second = [crmAccount(100)];
  const crm = clientWithPages((page) => ({ data: page === 1 ? first : second, total: 101 }));

  const accounts = await crm.listAccounts();
  assert.equal(accounts.length, 101);
  assert.equal(new Set(accounts.map((account) => account.account_id)).size, 101);
});

test("CRM pagination rejects duplicate account ids across pages", async () => {
  const first = Array.from({ length: 100 }, (_, index) => crmAccount(index));
  const crm = clientWithPages((page) => ({ data: page === 1 ? first : [crmAccount(0)], total: 101 }));

  await assert.rejects(crm.listAccounts(), /duplicate account account-000/i);
});

test("CRM pagination rejects a total that changes mid-scan", async () => {
  const first = Array.from({ length: 100 }, (_, index) => crmAccount(index));
  const crm = clientWithPages((page) => ({
    data: page === 1 ? first : [crmAccount(100)],
    total: page === 1 ? 101 : 102,
  }));

  await assert.rejects(crm.listAccounts(), /total changed during pagination/i);
});

test("CRM pagination rejects an incomplete empty page", async () => {
  const first = Array.from({ length: 100 }, (_, index) => crmAccount(index));
  const crm = clientWithPages((page) => ({ data: page === 1 ? first : [], total: 101 }));

  await assert.rejects(crm.listAccounts(), /pagination ended at 100 of 101/i);
});
