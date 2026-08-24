import assert from "node:assert/strict";
import test from "node:test";
import { buildProposals } from "../lib/matcher.mjs";
import { emptyState, mergePipelineRun } from "../lib/state.mjs";

const parent = {
  account_id: "parent-bellhaven",
  name: "Bellhaven Senior Living (Parent Account)",
  parent_id: "",
  status: "Active",
};

function location(overrides = {}) {
  return {
    slug: "bellhaven-test",
    name: "Bellhaven of Testville",
    street: "100 Main Street",
    city: "Testville",
    state: "OH",
    zip: "45000",
    care_offerings: ["Short-Term Rehabilitation & Nursing"],
    phone: "(555) 111-2222",
    source_url: "https://example.test/communities/bellhaven-test",
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    account_id: "facility-old",
    name: "Bellhaven of Testville",
    parent_id: "parent-other",
    parent_name: "Other Operator (Parent Account)",
    billing_street: "100 Main St",
    billing_city: "Testville",
    billing_state: "OH",
    billing_zip: "45000",
    care_type: "Skilled Nursing",
    status: "Active",
    lifetime_revenue: 0,
    outstanding_ar: 0,
    chow_current_account: "",
    duplicate_of_account: "",
    note: "",
    ...overrides,
  };
}

function source(locations) {
  return { scraped_at: "2026-08-24T00:00:00.000Z", locations, count_discrepancy: false };
}

test("uses CHOW creation instead of re-parenting when revenue and AR are both present", () => {
  const old = account({ lifetime_revenue: 50000, outstanding_ar: 3200 });
  const result = buildProposals(source([location()]), [parent, old]);
  const proposal = result.proposals.find((item) => item.kind === "chow");
  assert.ok(proposal);
  assert.equal(proposal.application.type, "chow_create");
  assert.equal(proposal.application.old_account_id, old.account_id);
  assert.equal(proposal.application.desired.parent_id, parent.account_id);
  assert.equal(proposal.application.desired.care_type, "Skilled Nursing");
  assert.equal(proposal.application.desired.parent_id === old.parent_id, false);
});

test("directly re-parents the existing account when outstanding AR is zero", () => {
  const old = account({ lifetime_revenue: 50000, outstanding_ar: 0 });
  const result = buildProposals(source([location()]), [parent, old]);
  const proposal = result.proposals.find((item) => item.kind === "update");
  assert.ok(proposal);
  assert.equal(proposal.application.patch.parent_id, parent.account_id);
  assert.equal(result.proposals.some((item) => item.kind === "chow"), false);
});

test("matches a distinctive rebrand in the same city and ZIP despite a stale street", () => {
  const stale = account({
    name: "Union Square Senior Living",
    billing_street: "240 Market St",
    billing_city: "New Albany",
    billing_zip: "43054",
  });
  const current = location({
    name: "Bellhaven at Union Square",
    street: "118 Union Square Dr",
    city: "New Albany",
    zip: "43054",
  });
  const result = buildProposals(source([current]), [parent, stale]);
  const proposal = result.proposals.find((item) => item.account?.account_id === stale.account_id);
  assert.equal(proposal.kind, "update");
  assert.equal(proposal.match.confidence, 0.92);
  assert.equal(proposal.application.patch.billing_street, current.street);
});

test("links a divested account to its successor without changing the old record", () => {
  const otherParent = account({ account_id: "parent-millstone", name: "Millstone Health Partners (Parent Account)", parent_id: "", parent_name: "" });
  const old = account({
    account_id: "old-sandusky",
    name: "Bellhaven Lakeside",
    parent_id: parent.account_id,
    parent_name: parent.name,
    billing_street: "500 Shoreline Dr",
    billing_city: "Sandusky",
    billing_zip: "44870",
    lifetime_revenue: 130000,
    outstanding_ar: 5200,
  });
  const successor = account({
    account_id: "current-sandusky",
    name: "Millstone Lakeside",
    parent_id: otherParent.account_id,
    parent_name: otherParent.name,
    billing_street: "500 Shoreline Dr",
    billing_city: "Sandusky",
    billing_zip: "44870",
    lifetime_revenue: 0,
    outstanding_ar: 0,
  });
  const result = buildProposals(source([]), [parent, otherParent, old, successor]);
  const proposal = result.proposals.find((item) => item.kind === "link_chow");
  assert.ok(proposal);
  assert.equal(proposal.application.type, "link_chow");
  assert.equal(proposal.application.old_account_id, old.account_id);
  assert.equal(proposal.application.current_account_id, successor.account_id);
  assert.equal(proposal.application.expected_old.parent_id, parent.account_id);
  assert.equal(proposal.application.expected_old.outstanding_ar, old.outstanding_ar);
  assert.equal(proposal.application.expected_current.parent_id, successor.parent_id);
});

test("does not reopen a divestiture whose protected successor link is still valid", () => {
  const otherParent = account({
    account_id: "parent-millstone-linked",
    name: "Millstone Health Partners (Parent Account)",
    parent_id: "",
    parent_name: "",
  });
  const successor = account({
    account_id: "current-lakeside-linked",
    name: "Millstone Lakeside",
    parent_id: otherParent.account_id,
    parent_name: otherParent.name,
    billing_street: "500 Shoreline Dr",
    billing_city: "Sandusky",
    billing_zip: "44870",
  });
  const old = account({
    account_id: "historic-lakeside-linked",
    name: "Bellhaven Lakeside",
    parent_id: parent.account_id,
    parent_name: parent.name,
    billing_street: "500 Shoreline Dr",
    billing_city: "Sandusky",
    billing_zip: "44870",
    lifetime_revenue: 130000,
    outstanding_ar: 5200,
    chow_current_account: successor.account_id,
  });

  const result = buildProposals(source([]), [parent, otherParent, old, successor]);
  assert.equal(result.proposals.some((item) => item.account?.account_id === old.account_id), false);
});

test("does not emit a second proposal after a protected CHOW link is complete", () => {
  const old = account({
    account_id: "historic-account",
    lifetime_revenue: 84000,
    outstanding_ar: 12400,
    chow_current_account: "current-account",
  });
  const current = account({
    account_id: "current-account",
    parent_id: parent.account_id,
    parent_name: parent.name,
    lifetime_revenue: 0,
    outstanding_ar: 0,
  });
  const result = buildProposals(source([location()]), [parent, old, current]);
  assert.equal(result.proposals.some((item) => ["chow", "link_chow"].includes(item.kind)), false);
});

test("does not re-propose a duplicate relationship that is already decided in CRM", () => {
  const survivor = account({
    account_id: "survivor",
    parent_id: parent.account_id,
    parent_name: parent.name,
  });
  const duplicate = account({
    account_id: "duplicate",
    status: "Inactive",
    duplicate_of_account: survivor.account_id,
  });
  const result = buildProposals(source([location()]), [parent, survivor, duplicate]);
  assert.equal(result.proposals.some((item) => item.kind === "duplicate"), false);
});

test("preserves a prior decision when the same deterministic proposal appears again", () => {
  const state = emptyState();
  const proposals = buildProposals(source([location()]), [parent, account()]).proposals;
  mergePipelineRun(state, {
    source: source([location()]), accounts: [parent, account()], proposals,
    startedAt: "2026-08-24T00:00:00.000Z", completedAt: "2026-08-24T00:00:01.000Z",
  });
  const proposal = state.proposals[proposals[0].id];
  proposal.status = "rejected";
  proposal.decision = { value: "reject", reviewer_note: "fixture", decided_at: "2026-08-24T00:01:00.000Z" };
  mergePipelineRun(state, {
    source: source([location()]), accounts: [parent, account()], proposals,
    startedAt: "2026-08-25T00:00:00.000Z", completedAt: "2026-08-25T00:00:01.000Z",
  });
  assert.equal(state.proposals[proposals[0].id].status, "rejected");
  assert.equal(state.proposals[proposals[0].id].decision.reviewer_note, "fixture");
  assert.equal(state.runs.at(-1).pending_count, 0);
});
