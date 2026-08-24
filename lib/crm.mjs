import { fetchWithPolicy, readTextLimited } from "./http.mjs";
import { normalizeName, normalizeSimple, normalizeStreet, normalizeZip } from "./normalization.mjs";

async function parseResponse(response) {
  const text = await readTextLimited(response);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function validateAccount(account, context) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    throw new Error(`${context} returned a non-object account`);
  }
  if (typeof account.account_id !== "string" || !account.account_id.trim()) {
    throw new Error(`${context} returned an account without account_id`);
  }
  if (typeof account.name !== "string") {
    throw new Error(`${context} returned account ${account.account_id} without a string name`);
  }
  return account;
}

export class CrmClient {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = "GET", body, query, headers = {} } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetchWithPolicy(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, {
      attempts: method === "GET" ? 3 : 1,
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(`CRM ${method} ${url.pathname} failed (${response.status}): ${String(detail).slice(0, 1000)}`);
    }
    return payload;
  }

  async listAccounts(filters = {}) {
    const pageSize = 100;
    const accounts = new Map();
    let page = 1;
    let declaredTotal = null;
    while (page <= 1_000) {
      const payload = await this.request("/accounts", {
        query: { ...filters, page, page_size: pageSize },
      });
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
        throw new Error(`CRM accounts page ${page} returned an invalid payload`);
      }
      const pageTotal = Number(payload.total);
      if (!Number.isInteger(pageTotal) || pageTotal < 0) {
        throw new Error(`CRM accounts page ${page} returned an invalid total`);
      }
      if (declaredTotal === null) declaredTotal = pageTotal;
      if (pageTotal !== declaredTotal) {
        throw new Error(`CRM account total changed during pagination (${declaredTotal} to ${pageTotal})`);
      }
      for (const row of payload.data) {
        const account = validateAccount(row, `CRM accounts page ${page}`);
        if (accounts.has(account.account_id)) {
          throw new Error(`CRM pagination returned duplicate account ${account.account_id}`);
        }
        accounts.set(account.account_id, account);
      }
      if (accounts.size === declaredTotal) break;
      if (!payload.data.length) {
        throw new Error(`CRM pagination ended at ${accounts.size} of ${declaredTotal} declared accounts`);
      }
      if (accounts.size > declaredTotal) {
        throw new Error(`CRM pagination returned more accounts than declared (${accounts.size} of ${declaredTotal})`);
      }
      page += 1;
    }
    if (page > 1_000 || accounts.size !== declaredTotal) {
      throw new Error(`CRM pagination was incomplete (${accounts.size} of ${declaredTotal ?? "unknown"} accounts)`);
    }
    return [...accounts.values()];
  }

  async getAccount(accountId) {
    return validateAccount(
      await this.request(`/accounts/${encodeURIComponent(accountId)}`),
      `CRM account ${accountId}`,
    );
  }

  async createAccount(fields, { idempotencyKey } = {}) {
    return validateAccount(await this.request("/accounts", {
      method: "POST",
      body: fields,
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    }), "CRM create");
  }

  async updateAccount(accountId, fields) {
    return validateAccount(
      await this.request(`/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: fields }),
      `CRM update ${accountId}`,
    );
  }

  async findCurrentAccount(desired, parentId) {
    const candidates = await this.listAccounts({
      zip: normalizeZip(desired.billing_zip),
      city: desired.billing_city,
    });
    const sameAddress = candidates.filter((account) =>
      account.parent_id === parentId
      && normalizeStreet(account.billing_street) === normalizeStreet(desired.billing_street)
      && normalizeSimple(account.billing_city) === normalizeSimple(desired.billing_city)
      && normalizeSimple(account.billing_state) === normalizeSimple(desired.billing_state)
      && normalizeZip(account.billing_zip) === normalizeZip(desired.billing_zip)
      && account.status === "Active"
    );
    const exactIdentity = sameAddress.filter((account) =>
      normalizeName(account.name) === normalizeName(desired.name)
    );
    if (exactIdentity.length > 1) {
      throw new Error(`Create safeguard found multiple current accounts for ${desired.name}`);
    }
    if (exactIdentity.length === 1) return exactIdentity[0];
    if (sameAddress.length) {
      throw new Error(`Create safeguard found a different active account at ${desired.billing_street}; rerun and review the collision`);
    }
    return null;
  }
}
