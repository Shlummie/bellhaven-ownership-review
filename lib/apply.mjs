import { CrmClient } from "./crm.mjs";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const PATCH_FIELDS = new Set([
  "name", "parent_id", "billing_street", "billing_city", "billing_state", "billing_zip",
  "care_type", "status", "duplicate_of_account", "note",
]);
const DESIRED_FIELDS = new Set([
  "name", "parent_id", "billing_street", "billing_city", "billing_state", "billing_zip",
  "care_type", "status", "phone", "note",
]);
const EXPECTED_FIELDS = new Set([
  ...PATCH_FIELDS,
  "phone", "lifetime_revenue", "outstanding_ar", "chow_current_account",
]);
const VALID_STATUS = new Set(["Active", "Inactive", "Needs Review"]);

class ApplicationFailure extends Error {
  constructor(error, outcome) {
    super(error instanceof Error ? error.message : String(error), {
      ...(error instanceof Error ? { cause: error } : {}),
    });
    this.name = "ApplicationFailure";
    this.outcome = outcome;
  }
}

export function applicationFailureOutcome(error) {
  return error instanceof ApplicationFailure && error.outcome === "unknown" ? "unknown" : "no_write";
}

async function withUnknownWriteOutcome(callback) {
  try {
    return await callback();
  } catch (error) {
    if (applicationFailureOutcome(error) === "unknown") throw error;
    throw new ApplicationFailure(error, "unknown");
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`Invalid proposal: ${label} must be an object`);
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Invalid proposal: ${label} contains unsupported field(s): ${unknown.join(", ")}`);
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`Invalid proposal: ${label} is malformed`);
  }
}

function assertString(value, label, { allowEmpty = false, maxLength = 4_000 } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new Error(`Invalid proposal: ${label} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maxLength} characters`);
  }
}

function validateFieldObject(value, allowed, label, { desired = false } = {}) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, allowed, label);
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "status") {
      if (!VALID_STATUS.has(fieldValue)) throw new Error(`Invalid proposal: unsupported status ${fieldValue}`);
      continue;
    }
    assertString(fieldValue, `${label}.${field}`, {
      allowEmpty: !desired || !["name", "parent_id", "billing_street", "billing_city", "billing_state", "billing_zip"].includes(field),
      maxLength: field === "note" ? 4_000 : 500,
    });
    if (["parent_id", "duplicate_of_account"].includes(field) && fieldValue) {
      assertId(fieldValue, `${label}.${field}`);
    }
  }
}

function assertRequiredKeys(value, keys, label) {
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`Invalid proposal: ${label} is missing required field(s): ${missing.join(", ")}`);
}

function validateExpected(value, label) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, EXPECTED_FIELDS, label);
  if (!Object.keys(value).length) throw new Error(`Invalid proposal: ${label} cannot be empty`);
  for (const [field, fieldValue] of Object.entries(value)) {
    const scalar = fieldValue === null || ["string", "number"].includes(typeof fieldValue);
    if (!scalar || (typeof fieldValue === "number" && !Number.isFinite(fieldValue))) {
      throw new Error(`Invalid proposal: ${label}.${field} must be a scalar value`);
    }
    if (typeof fieldValue === "string" && fieldValue.length > 10_000) {
      throw new Error(`Invalid proposal: ${label}.${field} exceeds 10,000 characters`);
    }
  }
}

export function validateProposalApplication(proposal) {
  if (!proposal || !isPlainObject(proposal.application)) {
    throw new Error("Invalid proposal: application is missing");
  }
  assertId(proposal.id, "proposal.id");
  const application = proposal.application;
  switch (application.type) {
    case "patch":
      assertOnlyKeys(application, new Set(["type", "account_id", "patch", "expected"]), "patch application");
      assertId(application.account_id, "account_id");
      validateFieldObject(application.patch, PATCH_FIELDS, "patch");
      if (!Object.keys(application.patch).length) throw new Error("Invalid proposal: patch cannot be empty");
      validateExpected(application.expected, "expected");
      assertRequiredKeys(application.expected, [...Object.keys(application.patch), "parent_id", "lifetime_revenue", "outstanding_ar", "status"], "expected");
      break;
    case "create":
      assertOnlyKeys(application, new Set(["type", "parent_id", "desired"]), "create application");
      assertId(application.parent_id, "parent_id");
      validateFieldObject(application.desired, DESIRED_FIELDS, "desired", { desired: true });
      assertRequiredKeys(application.desired, ["name", "parent_id", "billing_street", "billing_city", "billing_state", "billing_zip", "status"], "desired");
      if (application.desired.parent_id !== application.parent_id || application.desired.status !== "Active") {
        throw new Error("Invalid proposal: create parent/status does not match the approved operation");
      }
      break;
    case "chow_create":
      assertOnlyKeys(application, new Set(["type", "old_account_id", "parent_id", "desired", "expected_old"]), "CHOW create application");
      assertId(application.old_account_id, "old_account_id");
      assertId(application.parent_id, "parent_id");
      validateFieldObject(application.desired, DESIRED_FIELDS, "desired", { desired: true });
      validateExpected(application.expected_old, "expected_old");
      assertRequiredKeys(application.desired, ["name", "parent_id", "billing_street", "billing_city", "billing_state", "billing_zip", "status"], "desired");
      assertRequiredKeys(application.expected_old, ["name", "parent_id", "status", "lifetime_revenue", "outstanding_ar", "billing_street", "billing_city", "billing_state", "billing_zip"], "expected_old");
      if (application.desired.parent_id !== application.parent_id || application.desired.status !== "Active") {
        throw new Error("Invalid proposal: CHOW current account parent/status is invalid");
      }
      break;
    case "link_chow":
      assertOnlyKeys(application, new Set(["type", "old_account_id", "current_account_id", "expected_old", "expected_current"]), "CHOW link application");
      assertId(application.old_account_id, "old_account_id");
      assertId(application.current_account_id, "current_account_id");
      if (application.old_account_id === application.current_account_id) {
        throw new Error("Invalid proposal: a CHOW account cannot link to itself");
      }
      validateExpected(application.expected_old, "expected_old");
      validateExpected(application.expected_current, "expected_current");
      assertRequiredKeys(application.expected_old, ["name", "parent_id", "status", "lifetime_revenue", "outstanding_ar", "billing_street", "billing_city", "billing_state", "billing_zip"], "expected_old");
      assertRequiredKeys(application.expected_current, ["name", "parent_id", "status", "lifetime_revenue", "outstanding_ar", "billing_street", "billing_city", "billing_state", "billing_zip"], "expected_current");
      break;
    default:
      throw new Error(`Unsupported proposal application type: ${application.type}`);
  }
  return application;
}

function valuesEqual(left, right) {
  if (typeof left === "number" || typeof right === "number") return Number(left) === Number(right);
  return String(left ?? "") === String(right ?? "");
}

function alreadyMatches(account, patch) {
  return Object.entries(patch).every(([key, value]) => valuesEqual(account[key], value));
}

function assertExpected(account, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    if (!valuesEqual(account[field], value)) {
      throw new Error(`Stale proposal: ${label}.${field} changed from ${String(value ?? "none")} to ${String(account[field] ?? "none")}`);
    }
  }
}

function assertDesired(account, desired, label) {
  if (!alreadyMatches(account, desired)) {
    const missing = Object.entries(desired)
      .filter(([field, value]) => !valuesEqual(account[field], value))
      .map(([field]) => field);
    throw new Error(`CRM did not persist the approved ${label} field(s): ${missing.join(", ")}`);
  }
}

async function applyPatch(crm, application) {
  const current = await crm.getAccount(application.account_id);
  if (alreadyMatches(current, application.patch)) {
    return { mode: "already_applied", account_id: current.account_id, account: current };
  }
  if (
    Object.hasOwn(application.patch, "parent_id")
    && Number(current.lifetime_revenue) > 0
    && Number(current.outstanding_ar) > 0
  ) {
    throw new Error("Billing safeguard stopped a parent update: the account currently has revenue history and outstanding AR. Run the pipeline again to generate a CHOW proposal.");
  }
  assertExpected(current, application.expected, current.account_id);
  if (application.patch.duplicate_of_account && Number(current.outstanding_ar) > 0) {
    throw new Error("Outstanding AR safeguard stopped duplicate retirement; preserve and link this account instead.");
  }
  return withUnknownWriteOutcome(async () => {
    await crm.updateAccount(application.account_id, application.patch);
    const verified = await crm.getAccount(application.account_id);
    assertDesired(verified, application.patch, `patch for ${application.account_id}`);
    return { mode: "patched", account_id: application.account_id, account: verified };
  });
}

async function ensureCurrentAccount(crm, application, idempotencyKey) {
  const existing = await crm.findCurrentAccount(application.desired, application.parent_id);
  if (existing) {
    assertDesired(existing, application.desired, "existing current account");
    return { mode: "reused", account: existing };
  }
  return withUnknownWriteOutcome(async () => {
    const created = await crm.createAccount(application.desired, { idempotencyKey });
    const verified = await crm.getAccount(created.account_id);
    assertDesired(verified, application.desired, "created account");
    return { mode: "created", account: verified };
  });
}

async function applyCreate(crm, application, proposalId) {
  const result = await ensureCurrentAccount(crm, application, proposalId);
  return { mode: result.mode, account_id: result.account.account_id, account: result.account };
}

async function applyChowCreate(crm, application, proposalId) {
  const oldAccount = await crm.getAccount(application.old_account_id);
  assertExpected(oldAccount, application.expected_old, oldAccount.account_id);
  if (!(Number(oldAccount.lifetime_revenue) > 0 && Number(oldAccount.outstanding_ar) > 0)) {
    throw new Error("Stale CHOW proposal: the old account no longer meets the revenue plus outstanding-AR safeguard. Run the pipeline again.");
  }

  const currentResult = await ensureCurrentAccount(crm, application, proposalId);
  const currentAccount = currentResult.account;
  if (oldAccount.chow_current_account === currentAccount.account_id) {
    return {
      mode: "already_applied",
      old_account_id: oldAccount.account_id,
      current_account_id: currentAccount.account_id,
      current_account_mode: currentResult.mode,
    };
  }

  return withUnknownWriteOutcome(async () => {
    await crm.updateAccount(oldAccount.account_id, { chow_current_account: currentAccount.account_id });
    const verifiedOld = await crm.getAccount(oldAccount.account_id);
    assertExpected(verifiedOld, application.expected_old, verifiedOld.account_id);
    if (verifiedOld.chow_current_account !== currentAccount.account_id) {
      throw new Error(`CRM did not persist the approved CHOW link on ${oldAccount.account_id}`);
    }
    return {
      mode: "chow_linked",
      old_account_id: oldAccount.account_id,
      current_account_id: currentAccount.account_id,
      current_account_mode: currentResult.mode,
    };
  });
}

async function applyChowLink(crm, application) {
  const [oldAccount, currentAccount] = await Promise.all([
    crm.getAccount(application.old_account_id),
    crm.getAccount(application.current_account_id),
  ]);
  assertExpected(oldAccount, application.expected_old, oldAccount.account_id);
  assertExpected(currentAccount, application.expected_current, currentAccount.account_id);
  if (oldAccount.chow_current_account === currentAccount.account_id) {
    return { mode: "already_applied", old_account_id: oldAccount.account_id, current_account_id: currentAccount.account_id };
  }
  return withUnknownWriteOutcome(async () => {
    await crm.updateAccount(oldAccount.account_id, { chow_current_account: currentAccount.account_id });
    const verified = await crm.getAccount(oldAccount.account_id);
    assertExpected(verified, application.expected_old, verified.account_id);
    if (verified.chow_current_account !== currentAccount.account_id) {
      throw new Error(`CRM did not persist the approved CHOW link on ${oldAccount.account_id}`);
    }
    return { mode: "chow_linked", old_account_id: oldAccount.account_id, current_account_id: currentAccount.account_id };
  });
}

export async function applyProposal(proposal, config, { fetchImpl = fetch } = {}) {
  const application = validateProposalApplication(proposal);
  const crm = new CrmClient({ baseUrl: config.crmBase, token: config.token, fetchImpl });
  switch (application.type) {
    case "patch":
      return applyPatch(crm, application);
    case "create":
      return applyCreate(crm, application, proposal.id);
    case "chow_create":
      return applyChowCreate(crm, application, proposal.id);
    case "link_chow":
      return applyChowLink(crm, application);
    default:
      throw new Error(`Unsupported proposal application type: ${application.type}`);
  }
}
