import assert from "node:assert/strict";
import test from "node:test";
import { applicationFailureOutcome, applyProposal, validateProposalApplication } from "../lib/apply.mjs";

function fakeCrm(initialAccounts, { ignorePatches = false, verificationFailuresAfterPatch = 0 } = {}) {
  const accounts = new Map(initialAccounts.map((account) => [account.account_id, structuredClone(account)]));
  let creations = 0;
  let patches = 0;
  let verificationFailuresRemaining = 0;
  const idempotencyKeys = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const accountId = url.pathname.match(/\/accounts\/([^/]+)$/)?.[1];
    if (method === "GET" && accountId) {
      if (verificationFailuresRemaining > 0) {
        verificationFailuresRemaining -= 1;
        return Response.json({ error: "fixture verification unavailable" }, { status: 409 });
      }
      const found = accounts.get(accountId);
      return found ? Response.json(found) : Response.json({ error: "missing" }, { status: 404 });
    }
    if (method === "GET" && url.pathname.endsWith("/accounts")) {
      let rows = [...accounts.values()];
      const zip = url.searchParams.get("zip");
      const city = url.searchParams.get("city");
      if (zip) rows = rows.filter((account) => String(account.billing_zip).startsWith(zip));
      if (city) rows = rows.filter((account) => account.billing_city === city);
      return Response.json({ data: rows, total: rows.length, page: 1, page_size: 100 });
    }
    if (method === "POST" && url.pathname.endsWith("/accounts")) {
      creations += 1;
      idempotencyKeys.push(init.headers?.["idempotency-key"] ?? null);
      const body = JSON.parse(init.body);
      const created = { ...body, account_id: `created-${creations}`, lifetime_revenue: 0, outstanding_ar: 0, chow_current_account: "", duplicate_of_account: "" };
      accounts.set(created.account_id, created);
      return Response.json(created, { status: 201 });
    }
    if (method === "PATCH" && accountId) {
      patches += 1;
      const updated = { ...accounts.get(accountId), ...JSON.parse(init.body) };
      if (!ignorePatches) accounts.set(accountId, updated);
      verificationFailuresRemaining = verificationFailuresAfterPatch;
      return Response.json(updated);
    }
    return Response.json({ error: "unexpected request" }, { status: 500 });
  };
  return {
    accounts,
    fetchImpl,
    idempotencyKeys,
    get creations() { return creations; },
    get patches() { return patches; },
  };
}

const config = { crmBase: "https://crm.test/api/v1", token: "fixture-token" };

test("CHOW approval is idempotent and changes only the old account link", async () => {
  const old = {
    account_id: "old-1", name: "Old Facility", parent_id: "old-parent", billing_street: "10 Main St",
    billing_city: "Akron", billing_state: "OH", billing_zip: "44313", status: "Active",
    lifetime_revenue: 51000, outstanding_ar: 3800, chow_current_account: "", duplicate_of_account: "",
  };
  const fake = fakeCrm([old]);
  const proposal = { id: "prop_chow_fixture", application: {
    type: "chow_create", old_account_id: old.account_id, parent_id: "bellhaven-parent",
    desired: { name: "Bellhaven of Akron", parent_id: "bellhaven-parent", billing_street: "10 Main St", billing_city: "Akron", billing_state: "OH", billing_zip: "44313", status: "Active" },
    expected_old: {
      name: old.name,
      parent_id: old.parent_id,
      status: old.status,
      lifetime_revenue: old.lifetime_revenue,
      outstanding_ar: old.outstanding_ar,
      billing_street: old.billing_street,
      billing_city: old.billing_city,
      billing_state: old.billing_state,
      billing_zip: old.billing_zip,
    },
  } };

  const first = await applyProposal(proposal, config, { fetchImpl: fake.fetchImpl });
  const second = await applyProposal(proposal, config, { fetchImpl: fake.fetchImpl });
  assert.equal(fake.creations, 1);
  assert.equal(first.mode, "chow_linked");
  assert.equal(second.mode, "already_applied");
  assert.equal(fake.accounts.get(old.account_id).parent_id, old.parent_id);
  assert.equal(fake.accounts.get(old.account_id).name, old.name);
  assert.equal(fake.accounts.get(old.account_id).chow_current_account, "created-1");
  assert.deepEqual(fake.idempotencyKeys, [proposal.id]);
});

test("approval-time guard blocks a newly unsafe parent change", async () => {
  const old = {
    account_id: "old-2", name: "Facility", parent_id: "old-parent", billing_street: "20 Main St",
    billing_city: "Lima", billing_state: "OH", billing_zip: "45801", status: "Active",
    lifetime_revenue: 47000, outstanding_ar: 900, chow_current_account: "", duplicate_of_account: "",
  };
  const fake = fakeCrm([old]);
  const proposal = { id: "prop_newly_unsafe", application: {
    type: "patch",
    account_id: old.account_id,
    patch: { parent_id: "bellhaven-parent" },
    expected: { parent_id: "old-parent", lifetime_revenue: old.lifetime_revenue, outstanding_ar: 0, status: old.status },
  } };
  await assert.rejects(
    applyProposal(proposal, config, { fetchImpl: fake.fetchImpl }),
    /Billing safeguard stopped a parent update/,
  );
  assert.equal(fake.accounts.get(old.account_id).parent_id, "old-parent");
});

test("approval fails when the CRM acknowledges but does not persist a patch", async () => {
  const current = {
    account_id: "account-post-write", name: "Old Name", parent_id: "bellhaven-parent",
    billing_street: "30 Main St", billing_city: "Akron", billing_state: "OH", billing_zip: "44313",
    status: "Active", lifetime_revenue: 0, outstanding_ar: 0,
  };
  const fake = fakeCrm([current], { ignorePatches: true });
  const proposal = { id: "prop_post_write", application: {
    type: "patch",
    account_id: current.account_id,
    patch: { name: "Bellhaven of Akron" },
    expected: {
      name: current.name,
      parent_id: current.parent_id,
      status: current.status,
      lifetime_revenue: current.lifetime_revenue,
      outstanding_ar: current.outstanding_ar,
    },
  } };

  await assert.rejects(
    applyProposal(proposal, config, { fetchImpl: fake.fetchImpl }),
    (error) => {
      assert.match(error.message, /did not persist.*name/i);
      assert.equal(applicationFailureOutcome(error), "unknown");
      return true;
    },
  );
  assert.equal(fake.patches, 1);
  assert.equal(fake.accounts.get(current.account_id).name, current.name);
});

test("an unknown patch outcome reconciles idempotently without a second write", async () => {
  const current = {
    account_id: "account-unknown-retry", name: "Old Name", parent_id: "bellhaven-parent",
    billing_street: "35 Main St", billing_city: "Akron", billing_state: "OH", billing_zip: "44313",
    status: "Active", lifetime_revenue: 0, outstanding_ar: 0,
  };
  const fake = fakeCrm([current], { verificationFailuresAfterPatch: 1 });
  const proposal = { id: "prop_unknown_retry", application: {
    type: "patch",
    account_id: current.account_id,
    patch: { name: "Bellhaven of Akron" },
    expected: {
      name: current.name,
      parent_id: current.parent_id,
      status: current.status,
      lifetime_revenue: current.lifetime_revenue,
      outstanding_ar: current.outstanding_ar,
    },
  } };

  await assert.rejects(
    applyProposal(proposal, config, { fetchImpl: fake.fetchImpl }),
    (error) => {
      assert.equal(applicationFailureOutcome(error), "unknown");
      return true;
    },
  );
  const reconciled = await applyProposal(proposal, config, { fetchImpl: fake.fetchImpl });
  assert.equal(reconciled.mode, "already_applied");
  assert.equal(fake.patches, 1);
});

test("approval rejects a stale non-parent field before writing", async () => {
  const current = {
    account_id: "account-stale", name: "Concurrent Correction", parent_id: "bellhaven-parent",
    billing_street: "40 Main St", billing_city: "Lima", billing_state: "OH", billing_zip: "45801",
    status: "Active", lifetime_revenue: 0, outstanding_ar: 0,
  };
  const fake = fakeCrm([current]);
  const proposal = { id: "prop_stale", application: {
    type: "patch",
    account_id: current.account_id,
    patch: { billing_city: "Findlay" },
    expected: {
      name: "Name At Scan",
      billing_city: "Lima",
      parent_id: current.parent_id,
      lifetime_revenue: current.lifetime_revenue,
      outstanding_ar: current.outstanding_ar,
      status: current.status,
    },
  } };

  await assert.rejects(
    applyProposal(proposal, config, { fetchImpl: fake.fetchImpl }),
    (error) => {
      assert.match(error.message, /Stale proposal: account-stale\.name changed/);
      assert.equal(applicationFailureOutcome(error), "no_write");
      return true;
    },
  );
  assert.equal(fake.patches, 0);
});

test("create approval refuses to reuse an unrelated same-address account", async () => {
  const collision = {
    account_id: "therapy-office", name: "Unrelated Therapy Office", parent_id: "bellhaven-parent",
    billing_street: "50 Main St", billing_city: "Toledo", billing_state: "OH", billing_zip: "43604",
    status: "Active", lifetime_revenue: 0, outstanding_ar: 0,
  };
  const fake = fakeCrm([collision]);
  const proposal = { id: "prop_create_collision", application: {
    type: "create",
    parent_id: "bellhaven-parent",
    desired: {
      name: "Bellhaven of Toledo", parent_id: "bellhaven-parent", billing_street: "50 Main St",
      billing_city: "Toledo", billing_state: "OH", billing_zip: "43604", status: "Active",
    },
  } };

  await assert.rejects(
    applyProposal(proposal, config, { fetchImpl: fake.fetchImpl }),
    /different active account/,
  );
  assert.equal(fake.creations, 0);
});

test("create approval sends the deterministic proposal id as its idempotency key", async () => {
  const fake = fakeCrm([]);
  const proposal = { id: "prop_create_idempotent", application: {
    type: "create",
    parent_id: "bellhaven-parent",
    desired: {
      name: "Bellhaven of Dayton", parent_id: "bellhaven-parent", billing_street: "60 Main St",
      billing_city: "Dayton", billing_state: "OH", billing_zip: "45402", status: "Active",
    },
  } };

  const result = await applyProposal(proposal, config, { fetchImpl: fake.fetchImpl });
  assert.equal(result.mode, "created");
  assert.deepEqual(fake.idempotencyKeys, [proposal.id]);
});

test("proposal validation rejects unsupported write fields", () => {
  assert.throws(() => validateProposalApplication({ id: "prop_tampered_field", application: {
    type: "patch",
    account_id: "account-tampered",
    patch: { lifetime_revenue: 0 },
    expected: { lifetime_revenue: 100 },
  } }), /unsupported field.*lifetime_revenue/i);
});

test("proposal validation rejects object-valued patch fields", () => {
  assert.throws(() => validateProposalApplication({ id: "prop_tampered_object", application: {
    type: "patch",
    account_id: "account-tampered",
    patch: { note: { injected: true } },
    expected: { note: "" },
  } }), /patch\.note.*string/i);
});
