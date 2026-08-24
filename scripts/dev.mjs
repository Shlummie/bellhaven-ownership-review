#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { loadLocalEnv } from "../lib/config.mjs";

await loadLocalEnv();

const production = process.argv.includes("--production");
const apiPort = Number(process.env.REVIEW_API_PORT || 3100);
const webPort = Number(process.env.REVIEW_WEB_PORT || 3000);
const webHost = "127.0.0.1";
for (const [name, value] of [["REVIEW_API_PORT", apiPort], ["REVIEW_WEB_PORT", webPort]]) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
}
const sessionToken = randomBytes(32).toString("base64url");
const apiBase = process.env.REVIEW_UI_API_BASE || `http://127.0.0.1:${apiPort}`;
const apiUrl = new URL(apiBase);
if (apiUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(apiUrl.hostname)) {
  throw new Error("REVIEW_UI_API_BASE must be a loopback HTTP URL");
}
const allowedOrigins = process.env.REVIEW_ALLOWED_ORIGINS
  || `http://localhost:${webPort},http://127.0.0.1:${webPort}`;

const webEnv = { ...process.env };
for (const key of [
  "CRM_API_TOKEN",
  "CRM_API_BASE",
  "CRM_ALLOWED_HOSTS",
  "BELLHAVEN_CONFIG_PATH",
  "BELLHAVEN_RUNTIME_DIR",
  "REVIEW_STATE_PATH",
  "REVIEW_SESSION_TOKEN",
  "REVIEW_UI_SESSION_TOKEN",
  "REVIEW_UI_API_BASE",
]) {
  delete webEnv[key];
}
Object.assign(webEnv, {
  REVIEW_UI_API_BASE: apiBase,
  REVIEW_UI_SESSION_TOKEN: sessionToken,
  REVIEW_WEB_PORT: String(webPort),
  PORT: String(webPort),
});
const apiEnv = {
  ...process.env,
  REVIEW_API_PORT: String(apiPort),
  REVIEW_ALLOWED_ORIGINS: allowedOrigins,
  REVIEW_SESSION_TOKEN: sessionToken,
};

function spawnChild(name, command, args, env, { ipc = false } = {}) {
  const child = spawn(command, args, {
    stdio: ipc ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "inherit", "inherit"],
    env,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.serviceName = name;
  return child;
}

const vinextCli = path.resolve("node_modules", "vinext", "dist", "cli.js");
const webChild = spawnChild(
  "web",
  process.execPath,
  [vinextCli, production ? "start" : "dev", "--hostname", webHost],
  webEnv,
);
const apiChild = spawnChild("review API", process.execPath, ["scripts/review-server.mjs"], apiEnv, { ipc: true });
const children = [webChild, apiChild];
let shuttingDown = false;

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function terminateChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    child.kill("SIGKILL");
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The child may have exited between the status check and signal.
    }
    await waitForExit(child, 5_000);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The process group may already be gone after the graceful timeout.
      }
    }
  }
  await waitForExit(child, 5_000);
}

async function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (process.platform === "win32" && process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
  console.log("Stopping local review services…");
  await Promise.all(children.map(terminateChild));
  process.exit(exitCode);
}

function stopWindowsChildrenOnExit() {
  if (process.platform !== "win32") return;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
  }
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(`The ${child.serviceName} service could not start: ${error.message}`);
    void stop(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? ` after ${signal}` : ` with code ${code ?? "unknown"}`;
    console.error(`The ${child.serviceName} service exited unexpectedly${reason}.`);
    void stop(1);
  });
}

apiChild.on("message", (message) => {
  if (message && typeof message === "object" && message.type === "shutdown-request") {
    void stop(0);
  }
});

let apiWasHealthy = false;
let healthFailures = 0;
const healthMonitor = setInterval(async () => {
  if (shuttingDown) return;
  try {
    const response = await fetch(new URL("/api/health", apiUrl), {
      signal: AbortSignal.timeout(1_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    await response.body?.cancel().catch(() => {});
    apiWasHealthy = true;
    healthFailures = 0;
  } catch {
    if (!apiWasHealthy) return;
    healthFailures += 1;
    if (healthFailures >= 3) {
      console.error("The review API stopped responding; shutting down the owned service tree.");
      void stop(1);
    }
  }
}, 1_000);
healthMonitor.unref();

if (process.platform === "win32" && process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    if (Buffer.from(chunk).includes(3)) void stop(0);
  });
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("SIGBREAK", () => void stop(0));
process.on("SIGHUP", () => void stop(0));
process.on("exit", stopWindowsChildrenOnExit);
