import { proposalFingerprint } from "./state.mjs";
import {
  nameSimilarity,
  normalizeName,
  normalizeSimple,
  normalizeStreet,
  normalizeZip,
  sameAddress,
} from "./normalization.mjs";

export const REVIEW_NOTE_PREFIX = "[Bellhaven ownership review]";

const CARE_TYPE_MAP = new Map([
  ["assisted living", "Assisted Living"],
  ["independent living", "Independent Living"],
  ["memory support", "Memory Care"],
  ["memory care", "Memory Care"],
  ["short term rehabilitation and nursing", "Skilled Nursing"],
  ["skilled nursing", "Skilled Nursing"],
]);

const GENERIC_NAME_TOKENS = new Set([
  "and", "at", "bellhaven", "care", "center", "community", "health", "living",
  "nursing", "of", "rehabilitation", "senior", "the",
]);

const PROTECTED_ACCOUNT_FIELDS = [
  "name", "parent_id", "status", "lifetime_revenue", "outstanding_ar",
  "billing_street", "billing_city", "billing_state", "billing_zip", "care_type",
  "phone", "duplicate_of_account", "note",
];
const VALID_ACCOUNT_STATUSES = new Set(["Active", "Inactive", "Needs Review"]);

function financialValue(account, field) {
  const value = Number(account[field]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`CRM account ${account.account_id} has invalid ${field}`);
  }
  return value;
}

function sharedDistinctiveTokens(left, right, ignoredTokens = new Set()) {
  const leftTokens = new Set(normalizeName(left).split(" ").filter((token) => token && !GENERIC_NAME_TOKENS.has(token)));
  const rightTokens = new Set(normalizeName(right).split(" ").filter((token) => token && !GENERIC_NAME_TOKENS.has(token)));
  return [...leftTokens].filter((token) => rightTokens.has(token) && !ignoredTokens.has(token)).length;
}

function careMapping(location) {
  const mapped = location.care_offerings
    .map((offering) => CARE_TYPE_MAP.get(normalizeName(offering)))
    .filter(Boolean);
  const unique = [...new Set(mapped)];
  return {
    website_offerings: [...location.care_offerings],
    mapped_types: unique,
    crm_value: unique.length === 1 ? unique[0] : null,
    mode: unique.length > 1 ? "multiple_offerings_preserved_in_evidence" : unique.length === 1 ? "single_crm_value" : "unmapped",
  };
}

function careNote(location) {
  if (!location.care_offerings.length) return "";
  const offerings = location.care_offerings.join("; ").slice(0, 2_500);
  return ` Website care offerings: ${offerings}.`;
}

function findBellhavenParent(accounts) {
  const exact = accounts.filter((account) =>
    normalizeName(account.name) === normalizeName("Bellhaven Senior Living (Parent Account)")
    && !account.parent_id
  );
  if (exact.length !== 1) {
    throw new Error(`Expected one Bellhaven parent account; found ${exact.length}`);
  }
  return exact[0];
}

function validateInputs(source, accounts) {
  if (!source || !Array.isArray(source.locations) || !Array.isArray(accounts)) {
    throw new Error("Matcher requires source locations and CRM accounts arrays");
  }
  const sourceIds = new Set();
  const sourceUrls = new Set();
  const sourceSlugs = new Set();
  for (const [index, location] of source.locations.entries()) {
    for (const field of ["slug", "name", "street", "city", "state", "zip", "source_url"]) {
      if (typeof location[field] !== "string" || !location[field].trim()) {
        throw new Error(`Source location ${index + 1} is missing ${field}`);
      }
    }
    if (!Array.isArray(location.care_offerings)) {
      throw new Error(`Source location ${location.name} has invalid care_offerings`);
    }
    if (location.care_offerings.some((offering) => typeof offering !== "string" || !offering.trim())) {
      throw new Error(`Source location ${location.name} has invalid care offering values`);
    }
    const identity = `${normalizeName(location.name)}|${normalizeStreet(location.street)}|${normalizeZip(location.zip)}`;
    if (sourceIds.has(identity)) throw new Error(`Duplicate source location identity: ${location.name}`);
    if (sourceUrls.has(location.source_url)) throw new Error(`Duplicate source URL: ${location.source_url}`);
    if (sourceSlugs.has(location.slug)) throw new Error(`Duplicate source slug: ${location.slug}`);
    sourceIds.add(identity);
    sourceUrls.add(location.source_url);
    sourceSlugs.add(location.slug);
  }
  const accountIds = new Set();
  for (const [index, account] of accounts.entries()) {
    if (!account || typeof account !== "object" || typeof account.account_id !== "string" || !account.account_id) {
      throw new Error(`CRM account ${index + 1} is missing account_id`);
    }
    if (typeof account.name !== "string" || !account.name.trim()) {
      throw new Error(`CRM account ${account.account_id} is missing name`);
    }
    if (accountIds.has(account.account_id)) throw new Error(`Duplicate CRM account id: ${account.account_id}`);
    accountIds.add(account.account_id);
  }
}

function candidateScore(location, account, parentId) {
  const similarity = nameSimilarity(location.name, account.name);
  const rawAddressMatch = sameAddress(location, account);
  const sameZip = normalizeZip(location.zip) === normalizeZip(account.billing_zip);
  const sameStreet = normalizeStreet(location.street) === normalizeStreet(account.billing_street);
  const sameCity = normalizeSimple(location.city) === normalizeSimple(account.billing_city);
  const sameState = normalizeSimple(location.state) === normalizeSimple(account.billing_state);
  const locationAddressTokens = new Set(
    normalizeName(`${location.street} ${location.city} ${location.state} ${location.zip}`)
      .split(" ")
      .filter(Boolean),
  );
  const accountAddressTokens = new Set(
    normalizeName(`${account.billing_street} ${account.billing_city} ${account.billing_state} ${account.billing_zip}`)
      .split(" ")
      .filter(Boolean),
  );
  const sharedAddressTokens = new Set(
    [...locationAddressTokens].filter((token) => accountAddressTokens.has(token)),
  );
  const distinctiveTokens = sharedDistinctiveTokens(location.name, account.name, sharedAddressTokens);
  const corroboratedAddress = rawAddressMatch
    && sameCity
    && sameState
    && (similarity >= 0.5 || distinctiveTokens >= 1);
  const eligible = corroboratedAddress
    || (sameZip && sameCity && sameState && (similarity >= 0.55 || distinctiveTokens >= 2))
    || (sameCity && sameState && similarity >= 0.92);
  if (!eligible) return null;
  const score = (corroboratedAddress ? 100 : 0)
    + (sameZip ? 24 : 0)
    + (sameCity ? 12 : 0)
    + (sameState ? 5 : 0)
    + similarity * 45
    + distinctiveTokens * 12
    + (account.parent_id === parentId ? 12 : 0)
    + (account.status === "Active" ? 6 : 0)
    - (account.status === "Inactive" ? 12 : 0)
    - (account.duplicate_of_account ? 8 : 0);
  return {
    account,
    score,
    similarity,
    distinctiveTokens,
    exactAddress: corroboratedAddress,
    rawAddressMatch,
    sameStreet,
    sameZip,
    sameCity,
    sameState,
  };
}

function compareCandidates(left, right, parentId) {
  const identityDifference = (right.similarity - left.similarity) + ((right.distinctiveTokens - left.distinctiveTokens) * 0.08);
  if (Math.abs(identityDifference) >= 0.18) return identityDifference > 0 ? 1 : -1;
  if (left.exactAddress && right.exactAddress) {
    const leftCorrectParent = left.account.parent_id === parentId ? 1 : 0;
    const rightCorrectParent = right.account.parent_id === parentId ? 1 : 0;
    if (leftCorrectParent !== rightCorrectParent) return rightCorrectParent - leftCorrectParent;
    const leftActive = left.account.status === "Active" ? 1 : 0;
    const rightActive = right.account.status === "Active" ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    const leftDuplicate = left.account.duplicate_of_account ? 1 : 0;
    const rightDuplicate = right.account.duplicate_of_account ? 1 : 0;
    if (leftDuplicate !== rightDuplicate) return leftDuplicate - rightDuplicate;
  } else if (left.exactAddress !== right.exactAddress) {
    return Number(right.exactAddress) - Number(left.exactAddress);
  }
  if (right.score !== left.score) return right.score - left.score;
  if (right.similarity !== left.similarity) return right.similarity - left.similarity;
  const leftActive = left.account.status === "Active" ? 1 : 0;
  const rightActive = right.account.status === "Active" ? 1 : 0;
  if (leftActive !== rightActive) return rightActive - leftActive;
  if (left.account.lifetime_revenue !== right.account.lifetime_revenue) {
    return financialValue(right.account, "lifetime_revenue") - financialValue(left.account, "lifetime_revenue");
  }
  return left.account.account_id.localeCompare(right.account.account_id);
}

function desiredAccount(location, parentId) {
  const mapping = careMapping(location);
  return {
    name: location.name,
    parent_id: parentId,
    billing_street: location.street,
    billing_city: location.city,
    billing_state: location.state,
    billing_zip: location.zip,
    ...(mapping.crm_value ? { care_type: mapping.crm_value } : {}),
    status: "Active",
    ...(location.phone ? { phone: location.phone } : {}),
  };
}

function updatePatch(location, account, parentId) {
  const patch = {};
  if (account.name.trim() !== location.name.trim()) patch.name = location.name;
  if (account.parent_id !== parentId) patch.parent_id = parentId;
  if (normalizeStreet(account.billing_street) !== normalizeStreet(location.street)) patch.billing_street = location.street;
  if (normalizeSimple(account.billing_city) !== normalizeSimple(location.city)) patch.billing_city = location.city;
  if (normalizeSimple(account.billing_state) !== normalizeSimple(location.state)) patch.billing_state = location.state;
  if (normalizeZip(account.billing_zip) !== normalizeZip(location.zip)) patch.billing_zip = location.zip;
  const mapping = careMapping(location);
  if (mapping.crm_value && normalizeSimple(account.care_type) !== normalizeSimple(mapping.crm_value)) patch.care_type = mapping.crm_value;
  if (account.status !== "Active") patch.status = "Active";
  return patch;
}

function expectedForPatch(account, patch) {
  const fields = new Set([...Object.keys(patch), "parent_id", "lifetime_revenue", "outstanding_ar", "status"]);
  return Object.fromEntries([...fields].map((field) => [field, account[field] ?? ""]));
}

function protectedSnapshot(account) {
  return Object.fromEntries(PROTECTED_ACCOUNT_FIELDS.map((field) => [field, account[field] ?? ""]));
}

function proposalLocation(location) {
  if (!location) return null;
  const safeLocation = { ...location };
  delete safeLocation.administrator;
  return safeLocation;
}

function proposal({ kind, location = null, account = null, relatedAccount = null, match = null, application, title, summary, risk = "standard" }) {
  const safeLocation = proposalLocation(location);
  const identity = {
    kind,
    source_url: safeLocation?.source_url ?? null,
    account_id: account?.account_id ?? null,
    related_account_id: relatedAccount?.account_id ?? null,
    application,
  };
  const fingerprint = proposalFingerprint(identity);
  return {
    id: `prop_${fingerprint}`,
    fingerprint,
    kind,
    title,
    summary,
    risk,
    location: safeLocation,
    account,
    related_account: relatedAccount,
    match,
    care_mapping: location ? careMapping(location) : null,
    application,
  };
}

function matchEvidence(candidate) {
  let confidence;
  if (candidate.exactAddress && candidate.similarity >= 0.9) confidence = 1;
  else if (candidate.exactAddress) confidence = 0.94;
  else if (candidate.similarity === 1 && candidate.sameZip && candidate.sameCity) confidence = 0.96;
  else if (candidate.distinctiveTokens >= 2 && candidate.sameZip && candidate.sameCity) confidence = 0.92;
  else if (candidate.similarity >= 0.9 && candidate.sameCity && candidate.sameState) confidence = 0.9;
  else confidence = Number(Math.min(0.89, candidate.score / 180).toFixed(3));
  return {
    method: candidate.exactAddress ? "corroborated_normalized_address" : "fuzzy_name_and_locality",
    confidence,
    name_similarity: candidate.similarity,
    street_match: candidate.sameStreet,
    city_match: candidate.sameCity,
    state_match: candidate.sameState,
    zip_match: candidate.sameZip,
  };
}

function duplicateProposal(location, losing, survivor, match) {
  const note = `${REVIEW_NOTE_PREFIX} Duplicate of ${survivor.account_id}; both records represent ${location.name} at the same corroborated address.`;
  const patch = { status: "Inactive", duplicate_of_account: survivor.account_id, note };
  return proposal({
    kind: "duplicate",
    location,
    account: losing,
    relatedAccount: survivor,
    match,
    title: `Retire duplicate: ${losing.name}`,
    summary: `Mark the losing copy Inactive and link it to ${survivor.name}.`,
    application: {
      type: "patch",
      account_id: losing.account_id,
      patch,
      expected: expectedForPatch(losing, patch),
    },
  });
}

function locationFromAccount(account) {
  return {
    name: account.name,
    street: account.billing_street,
    city: account.billing_city,
    state: account.billing_state,
    zip: account.billing_zip,
  };
}

export function buildProposals(source, accounts) {
  validateInputs(source, accounts);
  const parent = findBellhavenParent(accounts);
  const referencedParentIds = new Set(accounts.map((account) => account.parent_id).filter(Boolean));
  const facilities = accounts.filter((account) =>
    account.account_id !== parent.account_id
    && Boolean(account.parent_id)
    && !referencedParentIds.has(account.account_id)
    && !normalizeName(account.name).includes("parent account")
  );
  for (const account of facilities) {
    if (!VALID_ACCOUNT_STATUSES.has(account.status)) {
      throw new Error(`CRM account ${account.account_id} has invalid status ${String(account.status)}`);
    }
    financialValue(account, "lifetime_revenue");
    financialValue(account, "outstanding_ar");
  }
  const proposals = [];
  const coveredAccountIds = new Set();

  const prepared = source.locations.map((location) => ({
    location,
    candidates: facilities
      .map((account) => candidateScore(location, account, parent.account_id))
      .filter(Boolean)
      .sort((left, right) => compareCandidates(left, right, parent.account_id)),
  }));
  const assignmentOrder = [...prepared].sort((left, right) => {
    const leftBest = left.candidates[0];
    const rightBest = right.candidates[0];
    if (!leftBest && !rightBest) return left.location.name.localeCompare(right.location.name);
    if (!leftBest) return 1;
    if (!rightBest) return -1;
    return compareCandidates(leftBest, rightBest, parent.account_id)
      || left.location.name.localeCompare(right.location.name);
  });
  const assignedAccounts = new Map();
  const winners = new Map();
  for (const item of assignmentOrder) {
    const strongNonAddressMatches = item.candidates.filter((candidate) =>
      !candidate.exactAddress
      && candidate.sameCity
      && candidate.sameState
      && candidate.similarity >= 0.9
    );
    if (strongNonAddressMatches.length > 1) {
      throw new Error(`Ambiguous CRM identity for ${item.location.name}: multiple strong non-address matches`);
    }
    const winner = item.candidates.find((candidate) => !assignedAccounts.has(candidate.account.account_id)) ?? null;
    winners.set(item.location.source_url, winner);
    if (winner) assignedAccounts.set(winner.account.account_id, item.location.source_url);
  }

  for (const { location, candidates } of prepared) {
    const winner = winners.get(location.source_url) ?? null;
    if (!winner) {
      const desired = {
        ...desiredAccount(location, parent.account_id),
        note: `${REVIEW_NOTE_PREFIX} Created from the current Bellhaven community directory (${location.source_url}).${careNote(location)}`,
      };
      proposals.push(proposal({
        kind: "create",
        location,
        title: `Create account: ${location.name}`,
        summary: candidates.length
          ? "Credible candidates were already assigned to a stronger website identity; create a distinct current account."
          : "No credible CRM account matched this website location.",
        application: { type: "create", parent_id: parent.account_id, desired },
      }));
      continue;
    }

    const account = winner.account;
    const evidence = matchEvidence(winner);
    const exactAddressCandidates = candidates.filter((candidate) =>
      candidate.exactAddress
      && (!assignedAccounts.has(candidate.account.account_id)
        || assignedAccounts.get(candidate.account.account_id) === location.source_url)
    );
    for (const candidate of exactAddressCandidates) coveredAccountIds.add(candidate.account.account_id);
    coveredAccountIds.add(account.account_id);

    const wrongParent = account.parent_id !== parent.account_id;
    const requiresChow = wrongParent
      && financialValue(account, "lifetime_revenue") > 0
      && financialValue(account, "outstanding_ar") > 0;

    if (requiresChow) {
      const desired = {
        ...desiredAccount(location, parent.account_id),
        note: `${REVIEW_NOTE_PREFIX} Current Bellhaven account created under the CHOW billing safeguard; prior account ${account.account_id} remains preserved.${careNote(location)}`,
      };
      proposals.push(proposal({
        kind: "chow",
        location,
        account,
        match: evidence,
        risk: "billing_safeguard",
        title: `Preserve billing history: ${location.name}`,
        summary: "Create the current Bellhaven account and link the old record without changing its parent.",
        application: {
          type: "chow_create",
          old_account_id: account.account_id,
          parent_id: parent.account_id,
          desired,
          expected_old: protectedSnapshot(account),
        },
      }));
    } else {
      const patch = updatePatch(location, account, parent.account_id);
      if (Object.keys(patch).length) {
        const multipleCare = careMapping(location).mode === "multiple_offerings_preserved_in_evidence";
        proposals.push(proposal({
          kind: "update",
          location,
          account,
          match: evidence,
          title: `Correct account: ${location.name}`,
          summary: (wrongParent
            ? "Re-parent the existing account and align its current facility fields."
            : "Align the matched CRM account with the current website record.")
            + (multipleCare ? " Multiple website care offerings remain visible as evidence; the singular CRM care_type is not guessed." : ""),
          application: {
            type: "patch",
            account_id: account.account_id,
            patch,
            expected: expectedForPatch(account, patch),
          },
        }));
      }
    }

    for (const candidate of exactAddressCandidates) {
      const losing = candidate.account;
      if (losing.account_id === account.account_id) continue;
      if (losing.status === "Inactive" && losing.duplicate_of_account === account.account_id) continue;
      if (requiresChow) continue;

      if (losing.parent_id !== parent.account_id && financialValue(losing, "outstanding_ar") > 0) {
        if (account.parent_id === parent.account_id && losing.chow_current_account !== account.account_id) {
          proposals.push(proposal({
            kind: "link_chow",
            location,
            account: losing,
            relatedAccount: account,
            match: matchEvidence(candidate),
            risk: "billing_safeguard",
            title: `Link historic billing account: ${losing.name}`,
            summary: "Preserve the prior-owner account and point it to the existing current Bellhaven record.",
            application: {
              type: "link_chow",
              old_account_id: losing.account_id,
              current_account_id: account.account_id,
              expected_old: protectedSnapshot(losing),
              expected_current: protectedSnapshot(account),
            },
          }));
        }
        continue;
      }

      if (financialValue(losing, "outstanding_ar") > 0) continue;
      proposals.push(duplicateProposal(location, losing, account, matchEvidence(candidate)));
    }
  }

  for (const account of facilities) {
    if (account.parent_id !== parent.account_id || coveredAccountIds.has(account.account_id)) continue;
    if (!["Active", "Needs Review"].includes(account.status)) continue;

    if (account.chow_current_account) {
      const linkedCurrent = facilities.find((candidate) => candidate.account_id === account.chow_current_account);
      if (
        linkedCurrent
        && linkedCurrent.status === "Active"
        && linkedCurrent.parent_id
        && linkedCurrent.parent_id !== parent.account_id
      ) {
        continue;
      }
    }

    const successorCandidates = facilities
      .filter((candidate) =>
        candidate.account_id !== account.account_id
        && candidate.parent_id
        && candidate.parent_id !== parent.account_id
        && candidate.status === "Active"
      )
      .map((candidate) => candidateScore(locationFromAccount(account), candidate, parent.account_id))
      .filter((candidate) => candidate?.exactAddress)
      .sort((left, right) => compareCandidates(left, right, parent.account_id));
    const successor = successorCandidates.length === 1 ? successorCandidates[0].account : null;

    if (successor) {
      const evidence = matchEvidence(successorCandidates[0]);
      if (financialValue(account, "lifetime_revenue") > 0 && financialValue(account, "outstanding_ar") > 0) {
        if (account.chow_current_account !== successor.account_id) {
          proposals.push(proposal({
            kind: "link_chow",
            account,
            relatedAccount: successor,
            match: evidence,
            risk: "billing_safeguard",
            title: `Preserve divested billing account: ${account.name}`,
            summary: `A corroborated same-facility account now exists as ${successor.name}; keep the Bellhaven billing record unchanged and link it to the current account.`,
            application: {
              type: "link_chow",
              old_account_id: account.account_id,
              current_account_id: successor.account_id,
              expected_old: protectedSnapshot(account),
              expected_current: protectedSnapshot(successor),
            },
          }));
        }
      } else if (financialValue(account, "outstanding_ar") === 0) {
        const note = `${REVIEW_NOTE_PREFIX} Duplicate historic ownership record for ${successor.account_id} at the same corroborated address.`;
        const patch = { status: "Inactive", duplicate_of_account: successor.account_id, note };
        proposals.push(proposal({
          kind: "duplicate",
          account,
          relatedAccount: successor,
          match: evidence,
          title: `Retire historic copy: ${account.name}`,
          summary: `A corroborated current account at the same address exists under ${successor.parent_name || "a different parent"}.`,
          application: {
            type: "patch",
            account_id: account.account_id,
            patch,
            expected: expectedForPatch(account, patch),
          },
        }));
      }
      continue;
    }

    const ambiguous = successorCandidates.length > 1;
    const note = ambiguous
      ? `${REVIEW_NOTE_PREFIX} Multiple possible same-address successors were found; ownership requires manual confirmation.`
      : `${REVIEW_NOTE_PREFIX} Not listed in the current Bellhaven community directory; ownership requires confirmation before reassignment.`;
    if (account.status === "Needs Review" && account.note === note) continue;
    const patch = {
      ...(account.status !== "Needs Review" ? { status: "Needs Review" } : {}),
      note,
    };
    proposals.push(proposal({
      kind: "former_affiliation",
      account,
      risk: "review_only",
      title: `Investigate former listing: ${account.name}`,
      summary: ambiguous
        ? "Several possible successor records share the address, so no automatic relationship is safe."
        : "This Bellhaven child account no longer appears anywhere in the current community directory.",
      application: {
        type: "patch",
        account_id: account.account_id,
        patch,
        expected: expectedForPatch(account, patch),
      },
    }));
  }

  const unique = new Map();
  for (const item of proposals) unique.set(item.id, item);
  const accountApplications = new Map();
  for (const item of unique.values()) {
    const target = item.application.account_id ?? item.application.old_account_id;
    if (!target) continue;
    const existing = accountApplications.get(target);
    if (existing && existing !== item.id) {
      throw new Error(`Conflicting proposals target CRM account ${target}`);
    }
    accountApplications.set(target, item.id);
  }
  return {
    parent,
    proposals: [...unique.values()].sort((left, right) => {
      const riskOrder = { billing_safeguard: 0, standard: 1, review_only: 2 };
      return (riskOrder[left.risk] ?? 9) - (riskOrder[right.risk] ?? 9)
        || left.title.localeCompare(right.title);
    }),
  };
}
