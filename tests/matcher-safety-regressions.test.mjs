import assert from "node:assert/strict";
import test from "node:test";
import { buildProposals } from "../lib/matcher.mjs";

const parent = {
  account_id: "parent-bellhaven",
  name: "Bellhaven Senior Living (Parent Account)",
  parent_id: "",
  status: "Active",
};

function account(overrides = {}) {
  return {
    account_id: "facility",
    name: "Bellhaven of Springfield",
    parent_id: "parent-other",
    parent_name: "Other Operator (Parent Account)",
    billing_street: "100 Main St",
    billing_city: "Springfield",
    billing_state: "OH",
    billing_zip: "45501",
    care_type: "Assisted Living",
    status: "Active",
    lifetime_revenue: 0,
    outstanding_ar: 0,
    chow_current_account: "",
    duplicate_of_account: "",
    note: "",
    ...overrides,
  };
}

function location(overrides = {}) {
  return {
    slug: "bellhaven-springfield",
    name: "Bellhaven of Springfield",
    street: "100 Main St",
    city: "Springfield",
    state: "OH",
    zip: "45501",
    care_offerings: ["Assisted Living"],
    phone: "",
    source_url: "https://example.test/communities/bellhaven-springfield",
    ...overrides,
  };
}

function source(locations) {
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

test("an inactive high-revenue duplicate never displaces the active current record", () => {
  const inactive = account({
    account_id: "historic-inactive",
    name: "Historic Bellhaven Springfield",
    parent_id: parent.account_id,
    parent_name: parent.name,
    status: "Inactive",
    lifetime_revenue: 50_000,
  });
  const active = account({
    account_id: "current-active",
    parent_id: parent.account_id,
    parent_name: parent.name,
  });

  const { proposals } = buildProposals(source([location()]), [parent, inactive, active]);
  assert.equal(proposals.some((proposal) =>
    proposal.application.account_id === active.account_id
    && proposal.application.patch?.status === "Inactive"
  ), false);
  const duplicate = proposals.find((proposal) => proposal.kind === "duplicate");
  assert.equal(duplicate?.application.account_id, inactive.account_id);
  assert.equal(duplicate?.application.patch.duplicate_of_account, active.account_id);
});

test("outstanding AR does not make a weak candidate outrank the stronger identity match", () => {
  const strong = account({
    account_id: "strong-match",
    name: "Bellhaven Springfield North",
    parent_id: parent.account_id,
    parent_name: parent.name,
    billing_street: "999 Old St",
  });
  const weak = account({
    account_id: "weak-ar-match",
    name: "Bellhaven Springfield",
    billing_street: "888 Old St",
    lifetime_revenue: 10,
    outstanding_ar: 1,
  });
  const current = location({
    slug: "springfield-north",
    name: "Bellhaven Springfield North",
    street: "10 North St",
    source_url: "https://example.test/communities/springfield-north",
  });

  const { proposals } = buildProposals(source([current]), [parent, strong, weak]);
  const matched = proposals.find((proposal) => proposal.location?.source_url === current.source_url && proposal.account);
  assert.equal(matched?.account.account_id, strong.account_id);
  assert.equal(proposals.some((proposal) => proposal.kind === "chow" && proposal.account?.account_id === weak.account_id), false);
});

test("root parent accounts are never treated as facility write targets", () => {
  const otherRoot = account({
    account_id: "parent-other",
    name: "Other Operator (Parent Account)",
    parent_id: "",
    parent_name: "",
  });

  const { proposals } = buildProposals(source([location()]), [parent, otherRoot]);
  assert.equal(proposals.some((proposal) => proposal.account?.account_id === otherRoot.account_id), false);
  assert.equal(proposals.some((proposal) => proposal.kind === "create"), true);
});

test("an unrelated co-located business is not rewritten as the Bellhaven facility", () => {
  const dentalOffice = account({
    account_id: "springfield-dental",
    name: "Springfield Dental Clinic",
    parent_id: "dental-parent",
    parent_name: "Dental Group",
  });

  const { proposals } = buildProposals(source([location()]), [parent, dentalOffice]);
  assert.equal(proposals.some((proposal) => proposal.account?.account_id === dentalOffice.account_id), false);
  assert.equal(proposals.some((proposal) => proposal.kind === "create"), true);
});

test("an unrelated co-located business is not selected as a divestiture successor", () => {
  const historic = account({
    account_id: "historic-bellhaven",
    parent_id: parent.account_id,
    parent_name: parent.name,
    lifetime_revenue: 50_000,
    outstanding_ar: 1_000,
  });
  const dentalOffice = account({
    account_id: "springfield-dental",
    name: "Springfield Dental Clinic",
    parent_id: "dental-parent",
    parent_name: "Dental Group",
  });

  const { proposals } = buildProposals(source([]), [parent, historic, dentalOffice]);
  assert.equal(proposals.some((proposal) =>
    proposal.kind === "link_chow"
    && proposal.application.current_account_id === dentalOffice.account_id
  ), false);
});

test("one CRM account cannot receive conflicting writes from two source locations", () => {
  const shared = account({ account_id: "shared-candidate", name: "Bellhaven Springfield" });
  const north = location({
    slug: "springfield-north",
    name: "Bellhaven Springfield North",
    street: "10 North St",
    source_url: "https://example.test/communities/springfield-north",
  });
  const south = location({
    slug: "springfield-south",
    name: "Bellhaven Springfield South",
    street: "20 South St",
    source_url: "https://example.test/communities/springfield-south",
  });

  const { proposals } = buildProposals(source([north, south]), [parent, shared]);
  const writesToShared = proposals.filter((proposal) =>
    proposal.application.account_id === shared.account_id
    || proposal.application.old_account_id === shared.account_id
  );
  assert.equal(writesToShared.length, 1);
  assert.equal(proposals.filter((proposal) => proposal.kind === "create").length, 1);
});

test("Needs Review records remain eligible for later corroborated successor discovery", () => {
  const otherParent = account({
    account_id: "new-operator-parent",
    name: "New Operator (Parent Account)",
    parent_id: "",
    parent_name: "",
  });
  const historic = account({
    account_id: "historic-needs-review",
    name: "Bellhaven Springfield Gardens",
    parent_id: parent.account_id,
    parent_name: parent.name,
    status: "Needs Review",
    lifetime_revenue: 50_000,
    outstanding_ar: 1_000,
  });
  const successor = account({
    account_id: "new-operator-current",
    name: "New Operator Springfield Gardens",
    parent_id: otherParent.account_id,
    parent_name: otherParent.name,
  });

  const { proposals } = buildProposals(source([]), [parent, otherParent, historic, successor]);
  const link = proposals.find((proposal) => proposal.kind === "link_chow");
  assert.equal(link?.application.old_account_id, historic.account_id);
  assert.equal(link?.application.current_account_id, successor.account_id);
});

test("multiple strong same-city matches with no address winner fail closed", () => {
  const first = account({
    account_id: "ambiguous-one",
    parent_id: parent.account_id,
    parent_name: parent.name,
    billing_street: "10 First St",
  });
  const second = account({
    account_id: "ambiguous-two",
    parent_id: parent.account_id,
    parent_name: parent.name,
    billing_street: "20 Second St",
  });

  assert.throws(
    () => buildProposals(source([location()]), [parent, first, second]),
    /Ambiguous CRM identity/,
  );
});

test("invalid billing values abort matching before a parent-changing proposal", () => {
  const unsafe = account({ lifetime_revenue: "unknown" });
  assert.throws(
    () => buildProposals(source([location()]), [parent, unsafe]),
    /invalid lifetime_revenue/,
  );
});

test("duplicate source URLs abort rather than aliasing assignment results", () => {
  const first = location();
  const second = location({
    slug: "bellhaven-dayton",
    name: "Bellhaven of Dayton",
    street: "200 Second St",
    city: "Dayton",
    zip: "45402",
  });
  assert.throws(
    () => buildProposals(source([first, second]), [parent]),
    /Duplicate source URL/,
  );
});
