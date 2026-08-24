import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_CRM_BASE = "https://analyst-assessment-production.up.railway.app/api/v1";

export function runtimeDirectory() {
  if (process.env.BELLHAVEN_RUNTIME_DIR?.trim()) {
    return path.resolve(process.env.BELLHAVEN_RUNTIME_DIR.trim());
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "BellhavenOwnershipReview");
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "bellhaven-ownership-review");
}

export function defaultLocalEnvPath() {
  return path.join(runtimeDirectory(), ".env.local");
}

function parseSecureUrl(value, label, { allowedHosts = null } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(loopback && process.env.ALLOW_INSECURE_LOOPBACK === "1")) {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} cannot contain credentials, a query string, or a fragment`);
  }
  if (allowedHosts && !allowedHosts.has(parsed.hostname)) {
    throw new Error(`${label} host ${parsed.hostname} is not in CRM_ALLOWED_HOSTS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export async function loadLocalEnv(root = process.cwd()) {
  const candidates = [
    process.env.BELLHAVEN_CONFIG_PATH?.trim(),
    defaultLocalEnvPath(),
  ].filter(Boolean);
  let contents = null;
  for (const envPath of [...new Set(candidates)]) {
    try {
      contents = await readFile(envPath, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (contents === null) {
    const legacyPath = path.join(root, ".env.local");
    try {
      await readFile(legacyPath, "utf8");
      throw new Error(`Move ${legacyPath} to ${defaultLocalEnvPath()}; checkout-local secrets are not loaded`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

export function getRuntimeConfig() {
  const token = process.env.CRM_API_TOKEN?.trim();
  if (!token) {
    throw new Error("CRM_API_TOKEN is required. Copy .env.example to .env.local and add the assessment token.");
  }
  const configuredAllowedHosts = process.env.CRM_ALLOWED_HOSTS;
  const allowedHosts = new Set(
    (configuredAllowedHosts === undefined ? new URL(DEFAULT_CRM_BASE).hostname : configuredAllowedHosts)
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  );
  if (!allowedHosts.size) {
    throw new Error("CRM_ALLOWED_HOSTS must contain at least one hostname");
  }
  const crmBase = parseSecureUrl(process.env.CRM_API_BASE?.trim() || DEFAULT_CRM_BASE, "CRM_API_BASE", { allowedHosts });
  const websiteBase = parseSecureUrl(
    process.env.BELLHAVEN_WEBSITE_BASE?.trim() || new URL("/", DEFAULT_CRM_BASE).origin,
    "BELLHAVEN_WEBSITE_BASE",
  );
  return {
    token,
    crmBase,
    websiteBase,
    statePath: path.resolve(process.env.REVIEW_STATE_PATH?.trim() || path.join(runtimeDirectory(), "review-state.json")),
    intentSigningKey: createHash("sha256").update(`bellhaven-review-intent:${token}`).digest(),
  };
}
