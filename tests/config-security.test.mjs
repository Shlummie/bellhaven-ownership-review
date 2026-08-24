import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getRuntimeConfig, loadLocalEnv } from "../lib/config.mjs";

const ENV_KEYS = [
  "ALLOW_INSECURE_LOOPBACK",
  "BELLHAVEN_CONFIG_PATH",
  "BELLHAVEN_RUNTIME_DIR",
  "BELLHAVEN_WEBSITE_BASE",
  "CRM_ALLOWED_HOSTS",
  "CRM_API_BASE",
  "CRM_API_TOKEN",
  "REVIEW_STATE_PATH",
];

function withEnvironment(values, callback) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("CRM configuration rejects plaintext, credentials, and non-allowlisted hosts", () => {
  const base = {
    CRM_API_TOKEN: "fixture-token",
    CRM_ALLOWED_HOSTS: "crm.test",
    BELLHAVEN_WEBSITE_BASE: "https://website.test",
  };
  assert.throws(
    () => withEnvironment({ ...base, CRM_API_BASE: "http://crm.test/api/v1" }, getRuntimeConfig),
    /must use HTTPS/,
  );
  assert.throws(
    () => withEnvironment({ ...base, CRM_API_BASE: "https://user:pass@crm.test/api/v1" }, getRuntimeConfig),
    /cannot contain credentials/,
  );
  assert.throws(
    () => withEnvironment({ ...base, CRM_API_BASE: "https://attacker.test/api/v1" }, getRuntimeConfig),
    /not in CRM_ALLOWED_HOSTS/,
  );
  assert.throws(
    () => withEnvironment({ ...base, CRM_ALLOWED_HOSTS: " ,  ", CRM_API_BASE: "https://attacker.test/api/v1" }, getRuntimeConfig),
    /must contain at least one hostname/,
  );
});

test("every local web entry point binds explicitly to IPv4 loopback", async () => {
  const [supervisor, viteConfig, packageJson] = await Promise.all([
    readFile(new URL("../scripts/dev.mjs", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(supervisor, /const webHost = "127\.0\.0\.1";/);
  assert.match(supervisor, /"--hostname", webHost/);
  assert.match(viteConfig, /host: "127\.0\.0\.1"/);
  assert.match(packageJson.scripts["dev:web"], /--hostname 127\.0\.0\.1$/);
  assert.match(packageJson.scripts["start:web"], /--hostname 127\.0\.0\.1$/);
});

test("checkout-local secrets are rejected instead of silently loaded", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bellhaven-config-test-"));
  const runtimeDir = path.join(temporaryRoot, "runtime");
  try {
    await writeFile(path.join(temporaryRoot, ".env.local"), "CRM_API_TOKEN=legacy-fixture\n", "utf8");
    await assert.rejects(
      withEnvironment({ BELLHAVEN_RUNTIME_DIR: runtimeDir }, () => loadLocalEnv(temporaryRoot)),
      /checkout-local secrets are not loaded/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
