import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { canonicalize } from "./normalization.mjs";

const STATE_VERSION = 2;
const INVALID_LOCK_GRACE_MS = 5_000;
const LOCK_WITNESS_HOST = "127.0.0.1";
const LOCK_WITNESS_PROBE_MS = 100;
const LOCK_WITNESS_KIND = "pipe";
const LOCK_WITNESS_TCP_HMAC_KIND = "tcp-hmac";
const TRANSIENT_LOCK_IO_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const TRANSIENT_LOCK_IO_DELAYS_MS = [5, 10, 20, 40, 80];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function deadlineExpired(deadline) {
  return performance.now() >= deadline;
}

function validWitnessPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function validWitnessToken(token) {
  return typeof token === "string" && /^[a-f0-9-]{36}$/.test(token);
}

function witnessTokensMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function witnessEndpoint(token) {
  const endpointId = createHash("sha256").update(token).digest("hex").slice(0, 32);
  if (process.platform === "win32") return `\\\\.\\pipe\\bellhaven-review-${endpointId}`;
  if (process.platform === "linux") return `\0bellhaven-review-${endpointId}`;
  return path.join(os.tmpdir(), `bellhaven-review-${process.getuid?.() ?? "user"}-${endpointId}.sock`);
}

function witnessResponse(token, challenge) {
  return createHmac("sha256", token).update(challenge).digest("base64url");
}

async function createLockWitness() {
  const token = randomUUID();
  const kind = ["linux", "win32"].includes(process.platform)
    ? LOCK_WITNESS_KIND
    : LOCK_WITNESS_TCP_HMAC_KIND;
  const endpoint = kind === LOCK_WITNESS_KIND ? witnessEndpoint(token) : null;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let request = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.length > 64) {
        socket.destroy();
        return;
      }
      const lineEnd = request.indexOf("\n");
      if (lineEnd === -1) return;
      const challenge = request.slice(0, lineEnd);
      if (!validWitnessToken(challenge) || request.slice(lineEnd + 1)) {
        socket.destroy();
        return;
      }
      socket.end(`${witnessResponse(token, challenge)}\n`);
    });
  });
  server.unref();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    const listenTarget = kind === LOCK_WITNESS_KIND
      ? endpoint
      : { host: LOCK_WITNESS_HOST, port: 0, exclusive: true };
    server.listen(listenTarget, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  const port = kind === LOCK_WITNESS_TCP_HMAC_KIND && address && typeof address !== "string"
    ? address.port
    : null;
  if (kind === LOCK_WITNESS_TCP_HMAC_KIND && !validWitnessPort(port)) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Could not establish the review-state TCP witness");
  }
  return { server, endpoint, kind, port, sockets, token };
}

async function closeLockWitness(witness) {
  if (!witness?.server) return;
  if (!witness.server.listening) {
    for (const socket of witness.sockets ?? []) socket.destroy();
    return;
  }
  await new Promise((resolve, reject) => {
    witness.server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    for (const socket of witness.sockets) socket.destroy();
  });
  if (witness.kind === LOCK_WITNESS_KIND && !["linux", "win32"].includes(process.platform)) {
    await removeIfPresent(witness.endpoint).catch(() => {});
  }
}

async function legacyPortWitnessIsHeld(port, token, deadline = Number.POSITIVE_INFINITY) {
  if (!validWitnessPort(port) || !validWitnessToken(token)) return null;
  if (deadlineExpired(deadline)) return true;
  const remainingMs = deadline - performance.now();
  const probeTimeoutMs = Number.isFinite(remainingMs)
    ? Math.max(1, Math.min(LOCK_WITNESS_PROBE_MS, remainingMs))
    : LOCK_WITNESS_PROBE_MS;
  return new Promise((resolve) => {
    const expected = `${token}\n`;
    const socket = createConnection({ host: LOCK_WITNESS_HOST, port });
    let settled = false;
    let received = "";
    const finish = (held) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(held);
    };
    // A legacy TCP listener that accepts but does not authenticate is
    // inconclusive. Fall back to the recorded PID instead of letting an
    // unrelated process that later reuses the port pin the lock forever.
    const timer = setTimeout(() => finish(null), probeTimeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
      if (!expected.startsWith(received) || received.length > expected.length) {
        finish(false);
      } else if (received.length === expected.length) {
        finish(witnessTokensMatch(received, expected));
      }
    });
    socket.once("end", () => finish(witnessTokensMatch(received, expected)));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? false : null));
  });
}

async function authenticatedWitnessIsHeld(connectTarget, token, deadCodes, deadline = Number.POSITIVE_INFINITY) {
  if (!validWitnessToken(token)) return null;
  if (deadlineExpired(deadline)) return true;
  const remainingMs = deadline - performance.now();
  const probeTimeoutMs = Number.isFinite(remainingMs)
    ? Math.max(1, Math.min(LOCK_WITNESS_PROBE_MS, remainingMs))
    : LOCK_WITNESS_PROBE_MS;
  const challenge = randomUUID();
  const expected = `${witnessResponse(token, challenge)}\n`;
  return new Promise((resolve) => {
    const socket = createConnection(connectTarget);
    let settled = false;
    let received = "";
    const finish = (held) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(held);
    };
    const timer = setTimeout(() => finish(null), probeTimeoutMs);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${challenge}\n`));
    socket.on("data", (chunk) => {
      received += chunk;
      if (!expected.startsWith(received) || received.length > expected.length) {
        finish(false);
      } else if (received.length === expected.length) {
        finish(witnessTokensMatch(received, expected));
      }
    });
    socket.once("end", () => finish(witnessTokensMatch(received, expected)));
    socket.once("error", (error) => finish(deadCodes.has(error?.code) ? false : null));
  });
}

async function pipeWitnessIsHeld(token, deadline = Number.POSITIVE_INFINITY) {
  return authenticatedWitnessIsHeld(
    witnessEndpoint(token),
    token,
    new Set(["ECONNREFUSED", "ENOENT"]),
    deadline,
  );
}

async function tcpHmacWitnessIsHeld(port, token, deadline = Number.POSITIVE_INFINITY) {
  if (!validWitnessPort(port)) return null;
  return authenticatedWitnessIsHeld(
    { host: LOCK_WITNESS_HOST, port },
    token,
    new Set(["ECONNREFUSED"]),
    deadline,
  );
}

async function ownerIsAlive(owner, deadline) {
  const witnessed = owner.witness_kind === LOCK_WITNESS_KIND
    ? await pipeWitnessIsHeld(owner.witness_token, deadline)
    : owner.witness_kind === LOCK_WITNESS_TCP_HMAC_KIND
      ? await tcpHmacWitnessIsHeld(owner.witness_port, owner.witness_token, deadline)
      : await legacyPortWitnessIsHeld(owner.witness_port, owner.witness_token, deadline);
  return witnessed ?? processIsAlive(owner.pid);
}

function lockTimeoutError() {
  return new Error("Timed out waiting for the review-state lock; another scan or approval is still running");
}

function nonceGeneration(nonce) {
  return `nonce-${createHash("sha256").update(nonce).digest("hex")}`;
}

async function inspectLock(filePath, deadline = Number.POSITIVE_INFINITY) {
  let contents;
  for (let attempt = 0; ; attempt += 1) {
    if (deadlineExpired(deadline)) {
      return { missing: false, transient: true, alive: true, generation: null };
    }
    try {
      contents = await readFile(filePath, "utf8");
      break;
    } catch (error) {
      if (error?.code === "ENOENT") return { missing: true, alive: false, generation: null };
      if (!TRANSIENT_LOCK_IO_CODES.has(error?.code)) throw error;
      if (attempt >= TRANSIENT_LOCK_IO_DELAYS_MS.length) {
        return { missing: false, transient: true, alive: true, generation: null };
      }
      const remainingMs = deadline - performance.now();
      const delayMs = Number.isFinite(remainingMs)
        ? Math.min(TRANSIENT_LOCK_IO_DELAYS_MS[attempt], Math.max(0, remainingMs))
        : TRANSIENT_LOCK_IO_DELAYS_MS[attempt];
      if (delayMs <= 0) return { missing: false, transient: true, alive: true, generation: null };
      await sleep(delayMs);
    }
  }
  const fingerprint = createHash("sha256").update(contents).digest("hex");
  try {
    const owner = JSON.parse(contents);
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== "string" || !owner.nonce) {
      return { missing: false, invalid: true, alive: false, generation: `invalid-${fingerprint}` };
    }
    return {
      ...owner,
      missing: false,
      invalid: false,
      alive: await ownerIsAlive(owner, deadline),
      generation: nonceGeneration(owner.nonce),
    };
  } catch {
    return { missing: false, invalid: true, alive: false, generation: `invalid-${fingerprint}` };
  }
}

async function fileAge(filePath, deadline = Number.POSITIVE_INFINITY) {
  for (let attempt = 0; ; attempt += 1) {
    if (deadlineExpired(deadline)) return null;
    try {
      const details = await stat(filePath);
      return Date.now() - details.mtimeMs;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (!TRANSIENT_LOCK_IO_CODES.has(error?.code)) throw error;
      if (attempt >= TRANSIENT_LOCK_IO_DELAYS_MS.length) return null;
      const remainingMs = deadline - performance.now();
      const delayMs = Number.isFinite(remainingMs)
        ? Math.min(TRANSIENT_LOCK_IO_DELAYS_MS[attempt], Math.max(0, remainingMs))
        : TRANSIENT_LOCK_IO_DELAYS_MS[attempt];
      if (delayMs <= 0) return null;
      await sleep(delayMs);
    }
  }
}

function removableLock(snapshot, age, staleAfterMs) {
  if (snapshot.missing) return false;
  if (!snapshot.invalid) return snapshot.alive === false;
  return age !== null && age > Math.max(staleAfterMs, INVALID_LOCK_GRACE_MS);
}

function ownerMarkerPath(lockPath, generation) {
  return `${lockPath}.owner.${generation.slice(0, 48)}`;
}

function lockPathFromMarker(markerPath) {
  const separatorIndex = markerPath.lastIndexOf(".owner.");
  if (separatorIndex <= 0) throw new Error("Invalid review-state lock owner marker path");
  return markerPath.slice(0, separatorIndex);
}

function reaperClaimPrefix(markerPath) {
  return `${path.basename(markerPath)}.reap.`;
}

function reaperClaimPath(markerPath, witness) {
  if (witness.kind === LOCK_WITNESS_TCP_HMAC_KIND) {
    return `${markerPath}.reap.${process.pid}.${witness.kind}.${witness.port}.${witness.token}`;
  }
  return `${markerPath}.reap.${process.pid}.${witness.kind}.${witness.token}`;
}

function claimIdentity(markerPath, claimPath) {
  const prefix = `${markerPath}.reap.`;
  if (!claimPath.startsWith(prefix)) return { pid: null, witnessPort: null };
  const parts = claimPath.slice(prefix.length).split(".");
  const [pidPart, witnessPart] = parts;
  const pid = Number(pidPart);
  const witnessKind = witnessPart === LOCK_WITNESS_KIND ? LOCK_WITNESS_KIND : null;
  const tcpHmac = witnessPart === LOCK_WITNESS_TCP_HMAC_KIND;
  const witnessPort = Number(tcpHmac ? parts[2] : witnessPart);
  const tokenPart = tcpHmac ? parts[3] : parts[2];
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    witnessKind: tcpHmac ? LOCK_WITNESS_TCP_HMAC_KIND : witnessKind,
    witnessPort: validWitnessPort(witnessPort) ? witnessPort : null,
    witnessToken: validWitnessToken(tokenPart) ? tokenPart : null,
  };
}

async function cleanupPipeWitness(identity) {
  const kind = identity.witnessKind ?? identity.witness_kind;
  const token = identity.witnessToken ?? identity.witness_token;
  if (["linux", "win32"].includes(process.platform) || kind !== LOCK_WITNESS_KIND || !validWitnessToken(token)) return;
  await removeIfPresent(witnessEndpoint(token)).catch(() => {});
}

async function claimIsAlive(markerPath, claimPath, deadline = Number.POSITIVE_INFINITY) {
  const identity = claimIdentity(markerPath, claimPath);
  const witnessed = identity.witnessKind === LOCK_WITNESS_KIND
    ? await pipeWitnessIsHeld(identity.witnessToken, deadline)
    : identity.witnessKind === LOCK_WITNESS_TCP_HMAC_KIND
      ? await tcpHmacWitnessIsHeld(identity.witnessPort, identity.witnessToken, deadline)
      : await legacyPortWitnessIsHeld(identity.witnessPort, identity.witnessToken, deadline);
  if (witnessed !== null) return witnessed;
  return identity.pid ? processIsAlive(identity.pid) : null;
}

async function removableClaim(markerPath, claimPath, staleAfterMs, deadline = Number.POSITIVE_INFINITY) {
  const alive = await claimIsAlive(markerPath, claimPath, deadline);
  if (alive !== null) return alive === false;
  const age = await fileAge(claimPath, deadline);
  return age !== null && age > Math.max(staleAfterMs, INVALID_LOCK_GRACE_MS);
}

async function hasLivePublisherMarker(lockPath, deadline = Number.POSITIVE_INFINITY) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.owner.`;
  const markerNames = (await readdir(directory)).filter((name) => (
    name.startsWith(prefix)
    && !name.includes(".reap.")
    && !name.includes(".gc.")
  ));
  for (const markerName of markerNames) {
    if (deadlineExpired(deadline)) return true;
    const marker = await inspectLock(path.join(directory, markerName), deadline);
    if (!marker.invalid && !marker.missing && marker.alive) return true;
  }
  return false;
}

function sidecarGeneration(lockPath, fileName) {
  const prefix = `${path.basename(lockPath)}.owner.`;
  if (!fileName.startsWith(prefix)) return null;
  const suffix = fileName.slice(prefix.length);
  const separators = [suffix.indexOf(".reap."), suffix.indexOf(".gc.")]
    .filter((index) => index >= 0);
  const boundary = separators.length ? Math.min(...separators) : suffix.length;
  const generation = suffix.slice(0, boundary);
  return generation || null;
}

async function removeIfPresent(filePath) {
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function atomicallyRemoveSidecar(filePath) {
  if (path.basename(filePath).includes(".gc.")) {
    await removeIfPresent(filePath);
    return;
  }
  const garbagePath = `${filePath}.gc.${process.pid}.${randomUUID()}`;
  try {
    await rename(filePath, garbagePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await removeIfPresent(garbagePath);
}

async function publishOwnerFile(filePath, owner, lockPath) {
  const temporaryPath = `${lockPath}.publish.${process.pid}.${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    await handle.close().catch(() => {});
    handle = null;
    await link(temporaryPath, filePath);
    return true;
  } finally {
    await handle?.close().catch(() => {});
    await removeIfPresent(temporaryPath).catch(() => {
      // A fully published hard link remains valid; a later sidecar sweep
      // safely removes a crash- or cleanup-orphaned publication file.
    });
  }
}

async function acquireReaperClaim(markerPath, staleAfterMs, deadline, reaperWitness) {
  const directory = path.dirname(markerPath);
  const claimPrefix = reaperClaimPrefix(markerPath);

  while (!deadlineExpired(deadline)) {
    const claimNames = (await readdir(directory))
      .filter((name) => name.startsWith(claimPrefix));
    if (claimNames.length > 1) {
      let removed = false;
      for (const claimName of claimNames) {
        const claimPath = path.join(directory, claimName);
        if (await removableClaim(markerPath, claimPath, staleAfterMs, deadline)) {
          await cleanupPipeWitness(claimIdentity(markerPath, claimPath));
          await atomicallyRemoveSidecar(claimPath);
          removed = true;
        }
      }
      if (removed) continue;
      return null;
    }
    if (claimNames.length === 1) {
      const existingClaim = path.join(directory, claimNames[0]);
      if (!await removableClaim(markerPath, existingClaim, staleAfterMs, deadline)) return null;
      await cleanupPipeWitness(claimIdentity(markerPath, existingClaim));
      const claimPath = reaperClaimPath(markerPath, reaperWitness);
      try {
        await rename(existingClaim, claimPath);
        return claimPath;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }

    const marker = await inspectLock(markerPath, deadline);
    if (!marker.missing) {
      const age = await fileAge(markerPath, deadline);
      if (!removableLock(marker, age, staleAfterMs)) return null;
      const claimPath = reaperClaimPath(markerPath, reaperWitness);
      try {
        await rename(markerPath, claimPath);
        return claimPath;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
    }

    const reaperNonce = randomUUID();
    try {
      await publishOwnerFile(markerPath, {
        pid: process.pid,
        nonce: reaperNonce,
        created_at: new Date().toISOString(),
        role: "stale-lock-reaper",
        witness_kind: reaperWitness.kind,
        ...(reaperWitness.port ? { witness_port: reaperWitness.port } : {}),
        witness_token: reaperWitness.token,
      }, lockPathFromMarker(markerPath));
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    const competingClaims = (await readdir(directory))
      .filter((name) => name.startsWith(claimPrefix));
    if (competingClaims.length) {
      await unlink(markerPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      return null;
    }
    const claimPath = reaperClaimPath(markerPath, reaperWitness);
    try {
      await rename(markerPath, claimPath);
      return claimPath;
    } catch (error) {
      await unlink(markerPath).catch(() => {});
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

async function reapLockGeneration(lockPath, observed, staleAfterMs, deadline, reaperWitness) {
  if (!observed.generation) return false;
  const markerPath = ownerMarkerPath(lockPath, observed.generation);
  const claimPath = await acquireReaperClaim(markerPath, staleAfterMs, deadline, reaperWitness);
  if (!claimPath) return false;
  try {
    if (deadlineExpired(deadline)) return false;
    const current = await inspectLock(lockPath, deadline);
    if (current.missing) return true;
    const age = await fileAge(lockPath, deadline);
    if (current.invalid && await hasLivePublisherMarker(lockPath, deadline)) return false;
    if (current.generation !== observed.generation || !removableLock(current, age, staleAfterMs)) {
      return false;
    }
    if (deadlineExpired(deadline)) return false;
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await cleanupPipeWitness(current);
    return true;
  } finally {
    await unlink(claimPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function sweepOrphanedLockSidecars(lockPath, staleAfterMs, deadline = Number.POSITIVE_INFINITY) {
  const directory = path.dirname(lockPath);
  if (deadlineExpired(deadline)) return false;
  const current = await inspectLock(lockPath, deadline);
  if (current.transient) return false;
  const currentGeneration = current.generation?.slice(0, 48) ?? null;
  const publicationPrefix = `${path.basename(lockPath)}.publish.`;
  const names = (await readdir(directory))
    .filter((name) => name.startsWith(publicationPrefix) || sidecarGeneration(lockPath, name));

  for (const name of names) {
    if (deadlineExpired(deadline)) return false;
    const sidecarPath = path.join(directory, name);
    if (name.startsWith(publicationPrefix)) {
      if (name.includes(".gc.")) {
        await atomicallyRemoveSidecar(sidecarPath);
        continue;
      }
      const snapshot = await inspectLock(sidecarPath, deadline);
      const age = await fileAge(sidecarPath, deadline);
      if (snapshot.nonce === current.nonce || removableLock(snapshot, age, staleAfterMs)) {
        if (snapshot.nonce !== current.nonce) await cleanupPipeWitness(snapshot);
        await atomicallyRemoveSidecar(sidecarPath);
      }
      continue;
    }
    const generation = sidecarGeneration(lockPath, name);
    if (generation === currentGeneration) continue;
    const markerPath = ownerMarkerPath(lockPath, generation);
    if (name.includes(".gc.")) {
      await atomicallyRemoveSidecar(sidecarPath);
      continue;
    }
    const age = await fileAge(sidecarPath, deadline);
    if (age === null) continue;
    let removable = false;
    if (name.includes(".reap.")) {
      removable = await removableClaim(markerPath, sidecarPath, staleAfterMs, deadline);
    } else {
      const snapshot = await inspectLock(sidecarPath, deadline);
      removable = removableLock(snapshot, age, staleAfterMs);
      if (removable) await cleanupPipeWitness(snapshot);
    }
    if (removable) {
      if (name.includes(".reap.")) {
        await cleanupPipeWitness(claimIdentity(markerPath, sidecarPath));
      }
      await atomicallyRemoveSidecar(sidecarPath);
    }
  }
  return true;
}

async function sweepOrphanedStateTemps(statePath, deadline = Number.POSITIVE_INFINITY) {
  const directory = path.dirname(statePath);
  const prefix = `${path.basename(statePath)}.`;
  const temporaryPattern = /^[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp(?:\.gc\.[1-9]\d*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/;
  const names = (await readdir(directory)).filter((name) => (
    name.startsWith(prefix)
    && temporaryPattern.test(name.slice(prefix.length))
  ));
  for (const name of names) {
    if (deadlineExpired(deadline)) return false;
    await atomicallyRemoveSidecar(path.join(directory, name));
  }
  return true;
}

async function releaseOwnedLock(lockOwned, lockPath, nonce) {
  if (!lockOwned) return;
  const current = await inspectLock(lockPath);
  if (current.nonce === nonce) {
    await removeIfPresent(lockPath);
  }
}

export function proposalFingerprint(intent) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(intent)))
    .digest("hex")
    .slice(0, 20);
}

export function proposalIntentSignature(proposal, signingKey) {
  if (!signingKey) return null;
  const signedIntent = canonicalize({
    id: proposal.id,
    fingerprint: proposal.fingerprint,
    application: proposal.application,
  });
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(signedIntent))
    .digest("base64url");
}

export function verifyProposalIntent(proposal, signingKey) {
  const expected = proposalIntentSignature(proposal, signingKey);
  const actual = typeof proposal.intent_signature === "string" ? proposal.intent_signature : "";
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function emptyState() {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    created_at: now,
    updated_at: now,
    latest_run_id: null,
    runs: [],
    proposals: {},
    latest_snapshot: null,
    last_pipeline_failure: null,
  };
}

function migrateState(parsed, statePath) {
  if (![1, STATE_VERSION].includes(parsed.version) || typeof parsed.proposals !== "object" || !Array.isArray(parsed.runs)) {
    throw new Error(`Unsupported review state format in ${statePath}`);
  }
  return {
    ...emptyState(),
    ...parsed,
    version: STATE_VERSION,
    last_pipeline_failure: parsed.last_pipeline_failure ?? null,
  };
}

export async function readState(statePath) {
  try {
    return migrateState(JSON.parse(await readFile(statePath, "utf8")), statePath);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  state.version = STATE_VERSION;
  state.updated_at = new Date().toISOString();
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryHandle;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await rename(temporaryPath, statePath);

    // Flush the renamed file on every platform. POSIX additionally requires
    // syncing the parent directory so the new directory entry survives a
    // host or power failure before a CRM mutation begins.
    const committedHandle = await open(statePath, "r+");
    try {
      await committedHandle.sync();
    } finally {
      await committedHandle.close();
    }
    if (process.platform !== "win32") {
      const directoryHandle = await open(path.dirname(statePath), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await temporaryHandle?.close().catch(() => {});
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function withStateLock(statePath, callback, {
  timeoutMs = 20_000,
  staleAfterMs = 10 * 60_000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Review-state lock timeoutMs must be a non-negative finite number");
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError("Review-state lock staleAfterMs must be a non-negative finite number");
  }
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  const witness = await createLockWitness();
  const deadline = performance.now() + timeoutMs;
  const nonce = randomUUID();
  const owner = {
    pid: process.pid,
    nonce,
    created_at: new Date().toISOString(),
    witness_kind: witness.kind,
    ...(witness.port ? { witness_port: witness.port } : {}),
    witness_token: witness.token,
  };
  const markerPath = ownerMarkerPath(lockPath, nonceGeneration(nonce));
  let lockOwned = false;
  try {
    let attempted = false;
    let contended = false;
    while (!lockOwned) {
      if (attempted && deadlineExpired(deadline)) throw lockTimeoutError();
      attempted = true;
      let markerCreated = false;
      try {
        await publishOwnerFile(markerPath, owner, lockPath);
        markerCreated = true;
      } catch (error) {
        if (markerCreated) {
          await removeIfPresent(markerPath);
        }
        if (error?.code === "EEXIST") {
          throw new Error("Could not create a unique review-state lock owner marker");
        }
        throw error;
      }

      let acquisitionError;
      try {
        lockOwned = await publishOwnerFile(lockPath, owner, lockPath);
      } catch (error) {
        acquisitionError = error;
      }

      if (lockOwned) {
        let publishedMarker;
        try {
          publishedMarker = await inspectLock(
            markerPath,
            contended ? deadline : Number.POSITIVE_INFINITY,
          );
        } catch (error) {
          await releaseOwnedLock(lockOwned, lockPath, nonce);
          lockOwned = false;
          await removeIfPresent(markerPath);
          throw error;
        }
        if (publishedMarker.nonce === nonce) {
          if (contended && deadlineExpired(deadline)) throw lockTimeoutError();
          break;
        }
        await releaseOwnedLock(lockOwned, lockPath, nonce);
        lockOwned = false;
        await removeIfPresent(markerPath);
        if (deadlineExpired(deadline)) throw lockTimeoutError();
        continue;
      }

      await removeIfPresent(markerPath);
      if (acquisitionError?.code !== "EEXIST") throw acquisitionError;
      contended = true;
      if (deadlineExpired(deadline)) throw lockTimeoutError();

      const observed = await inspectLock(lockPath, deadline);
      if (observed.missing) {
        if (deadlineExpired(deadline)) throw lockTimeoutError();
        continue;
      }
      const age = await fileAge(lockPath, deadline);
      const livePublisher = observed.invalid && await hasLivePublisherMarker(lockPath, deadline);
      if (!livePublisher && removableLock(observed, age, staleAfterMs)) {
        if (await reapLockGeneration(lockPath, observed, staleAfterMs, deadline, witness)) {
          if (deadlineExpired(deadline)) throw lockTimeoutError();
          continue;
        }
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw lockTimeoutError();
      await sleep(Math.min(remainingMs, 75 + Math.floor(Math.random() * 75)));
      if (deadlineExpired(deadline)) throw lockTimeoutError();
    }

    await sweepOrphanedLockSidecars(
      lockPath,
      staleAfterMs,
      contended ? deadline : Number.POSITIVE_INFINITY,
    );
    await sweepOrphanedStateTemps(
      statePath,
      contended ? deadline : Number.POSITIVE_INFINITY,
    );
    if (contended && deadlineExpired(deadline)) throw lockTimeoutError();
    const publishedLock = await inspectLock(
      lockPath,
      contended ? deadline : Number.POSITIVE_INFINITY,
    );
    if (publishedLock.nonce !== nonce) {
      throw new Error("Review-state lock ownership changed before the protected operation could start");
    }
    return await callback();
  } finally {
    try {
      await releaseOwnedLock(lockOwned, lockPath, nonce);
      await removeIfPresent(markerPath);
    } finally {
      await closeLockWitness(witness);
    }
  }
}

export function recoverInterruptedApplications(state, recoveredAt = new Date().toISOString()) {
  let recovered = 0;
  for (const proposal of Object.values(state.proposals)) {
    if (proposal.status !== "applying") continue;
    proposal.status = "failed";
    proposal.application_result = {
      error: "The previous approval was interrupted. Refresh CRM evidence, then retry; the operation is idempotent.",
      failed_at: recoveredAt,
      outcome: "unknown",
    };
    recovered += 1;
  }
  return recovered;
}

function minimizedSourceSnapshot(source) {
  const locations = source.locations.map((sourceLocation) => {
    const location = { ...sourceLocation };
    delete location.administrator;
    return location;
  });
  return {
    scraped_at: source.scraped_at,
    website_base: source.website_base,
    directory_pages: source.directory_pages,
    directory_claimed_count: source.directory_claimed_count,
    homepage_claimed_count: source.homepage_claimed_count,
    count_discrepancy: source.count_discrepancy,
    locations,
  };
}

export function mergePipelineRun(state, { source, accounts, proposals, startedAt, completedAt, signingKey = null }) {
  const runId = `run_${createHash("sha256").update(`${startedAt}:${source.scraped_at}`).digest("hex").slice(0, 12)}`;
  const activeIds = new Set(proposals.map((proposal) => proposal.id));

  for (const proposal of proposals) {
    const existing = state.proposals[proposal.id];
    const reactivated = existing?.status === "superseded";
    const reactivatedApproval = reactivated && existing?.decision?.value === "approve";
    const interrupted = existing?.status === "applying";
    const status = reactivatedApproval ? "failed" : reactivated ? "pending" : interrupted ? "failed" : existing?.status ?? "pending";
    state.proposals[proposal.id] = {
      ...proposal,
      intent_signature: proposalIntentSignature(proposal, signingKey) ?? existing?.intent_signature ?? null,
      status,
      created_at: existing?.created_at ?? completedAt,
      first_seen_run_id: existing?.first_seen_run_id ?? runId,
      last_seen_at: completedAt,
      last_seen_run_id: runId,
      decision: reactivated && !reactivatedApproval ? null : existing?.decision ?? null,
      application_result: reactivated && !reactivatedApproval
        ? null
        : interrupted
          ? {
              error: "The previous approval was interrupted. Review current CRM evidence and retry.",
              failed_at: completedAt,
              outcome: "unknown",
            }
          : existing?.application_result ?? null,
    };
    delete state.proposals[proposal.id].superseded_at;
    delete state.proposals[proposal.id].superseded_by_run_id;
  }

  for (const existing of Object.values(state.proposals)) {
    if (["pending", "failed", "applying"].includes(existing.status) && !activeIds.has(existing.id)) {
      const interrupted = existing.status === "applying";
      existing.status = "superseded";
      existing.superseded_at = completedAt;
      existing.superseded_by_run_id = runId;
      if (interrupted) {
        existing.application_result = {
          error: "The previous approval was interrupted before its CRM outcome could be confirmed.",
          failed_at: completedAt,
          outcome: "unknown",
        };
      }
    }
  }

  const statusCounts = Object.values(state.proposals).reduce((counts, proposal) => {
    counts[proposal.status] = (counts[proposal.status] ?? 0) + 1;
    return counts;
  }, {});
  const kindCounts = proposals.reduce((counts, proposal) => {
    counts[proposal.kind] = (counts[proposal.kind] ?? 0) + 1;
    return counts;
  }, {});
  const run = {
    id: runId,
    status: "completed",
    started_at: startedAt,
    completed_at: completedAt,
    website_location_count: source.locations.length,
    crm_account_count: accounts.length,
    proposed_count: proposals.length,
    pending_count: proposals.filter((proposal) => state.proposals[proposal.id].status === "pending").length,
    status_counts: statusCounts,
    kind_counts: kindCounts,
    website_count_discrepancy: source.count_discrepancy,
  };
  state.runs.push(run);
  state.runs = state.runs.slice(-30);
  state.latest_run_id = runId;
  state.latest_snapshot = { source: minimizedSourceSnapshot(source), account_count: accounts.length };
  state.last_pipeline_failure = null;
  return run;
}

export function recordPipelineFailure(state, { startedAt, completedAt, error }) {
  const failure = {
    id: `failed_${createHash("sha256").update(`${startedAt}:${completedAt}:${error}`).digest("hex").slice(0, 12)}`,
    status: "failed",
    started_at: startedAt,
    completed_at: completedAt,
    error: String(error).slice(0, 1000),
  };
  state.runs.push(failure);
  state.runs = state.runs.slice(-30);
  state.last_pipeline_failure = failure;
  return failure;
}
