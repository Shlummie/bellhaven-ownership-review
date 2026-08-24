#!/usr/bin/env node
import assert from "node:assert/strict";
import { CrmClient } from "../lib/crm.mjs";
import { getRuntimeConfig, loadLocalEnv } from "../lib/config.mjs";
import { buildProposals } from "../lib/matcher.mjs";
import { sameAddress } from "../lib/normalization.mjs";
import { scrapeCommunities } from "../lib/scraper.mjs";
import { readState } from "../lib/state.mjs";

await loadLocalEnv();
const config = getRuntimeConfig();
const crm = new CrmClient({ baseUrl: config.crmBase, token: config.token });
const [source, accounts, state] = await Promise.all([
  scrapeCommunities({ baseUrl: config.websiteBase }),
  crm.listAccounts(),
  readState(config.statePath),
]);
const { parent, proposals } = buildProposals(source, accounts);
assert.equal(proposals.length, 0, `Expected a clean rerun; found ${proposals.length} proposals`);

const byId = new Map(accounts.map((account) => [account.account_id, account]));
const approved = Object.values(state.proposals).filter((proposal) => proposal.status === "approved");
const protectedLinks = [];

for (const proposal of approved) {
  const intent = proposal.application;
  if (intent.type === "patch") {
    const current = byId.get(intent.account_id);
    assert.ok(current, `Missing patched account ${intent.account_id}`);
    for (const [field, value] of Object.entries(intent.patch)) {
      assert.equal(String(current[field] ?? ""), String(value ?? ""), `${intent.account_id}.${field} does not match its approved value`);
    }
    continue;
  }

  if (intent.type === "create") {
    const created = accounts.find((account) =>
      account.parent_id === intent.parent_id
      && account.name === intent.desired.name
      && sameAddress(account, intent.desired)
      && account.status === "Active"
    );
    assert.ok(created, `Missing approved current account for ${intent.desired.name}`);
    continue;
  }

  if (intent.type === "chow_create" || intent.type === "link_chow") {
    const old = byId.get(intent.old_account_id);
    assert.ok(old, `Missing protected account ${intent.old_account_id}`);
    const current = intent.type === "chow_create"
      ? byId.get(old.chow_current_account)
      : byId.get(intent.current_account_id);
    assert.ok(current, `Missing current CHOW account for ${proposal.title}`);
    assert.equal(old.chow_current_account, current.account_id, `${old.account_id} has the wrong CHOW link`);
    if (intent.type === "chow_create") {
      for (const [field, value] of Object.entries(intent.desired)) {
        assert.equal(String(current[field] ?? ""), String(value ?? ""), `${current.account_id}.${field} does not match its approved CHOW value`);
      }
    }
    for (const field of ["name", "parent_id", "status", "lifetime_revenue", "outstanding_ar", "billing_street", "billing_city", "billing_state", "billing_zip"]) {
      assert.equal(String(old[field] ?? ""), String(proposal.account[field] ?? ""), `${old.account_id}.${field} changed despite the CHOW safeguard`);
    }
    protectedLinks.push({ old_account_id: old.account_id, current_account_id: current.account_id });
  }
}

for (const location of source.locations) {
  const matches = accounts.filter((account) =>
    account.parent_id === parent.account_id
    && account.status === "Active"
    && sameAddress(location, account)
  );
  assert.equal(matches.length, 1, `${location.name} should have exactly one active Bellhaven account; found ${matches.length}`);
}

const unmatchedActiveChildren = accounts.filter((account) =>
  account.parent_id === parent.account_id
  && account.status === "Active"
  && !source.locations.some((location) => sameAddress(location, account))
);
assert.ok(unmatchedActiveChildren.every((account) => account.chow_current_account), "Every unmatched active Bellhaven child must have a CHOW successor link");

const result = {
  verified_at: new Date().toISOString(),
  website_locations: source.locations.length,
  crm_accounts: accounts.length,
  active_current_bellhaven_accounts: source.locations.length,
  unresolved_proposals: proposals.length,
  approved_decisions_verified: approved.length,
  protected_chow_links: protectedLinks,
  unmatched_active_children_with_successor: unmatchedActiveChildren.map((account) => account.account_id),
  website_count_discrepancy: {
    homepage: source.homepage_claimed_count,
    directory: source.directory_claimed_count,
  },
};
console.log(JSON.stringify(result, null, 2));
