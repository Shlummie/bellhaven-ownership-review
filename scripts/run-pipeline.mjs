#!/usr/bin/env node
import { loadLocalEnv, getRuntimeConfig } from "../lib/config.mjs";
import { runPipeline } from "../lib/pipeline.mjs";

await loadLocalEnv();
const result = await runPipeline({ config: getRuntimeConfig() });

console.log(JSON.stringify({
  run_id: result.run.id,
  website_locations: result.run.website_location_count,
  crm_accounts: result.run.crm_account_count,
  proposals_found: result.run.proposed_count,
  proposals_pending: result.run.pending_count,
  proposal_kinds: result.run.kind_counts,
  website_count_discrepancy: result.run.website_count_discrepancy,
  state_path: result.statePath,
}, null, 2));
