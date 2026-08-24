import { CrmClient } from "./crm.mjs";
import { buildProposals } from "./matcher.mjs";
import { scrapeCommunities } from "./scraper.mjs";
import {
  mergePipelineRun,
  readState,
  recordPipelineFailure,
  withStateLock,
  writeState,
} from "./state.mjs";

export async function runPipeline({ config, fetchImpl = fetch } = {}) {
  const startedAt = new Date().toISOString();
  return withStateLock(config.statePath, async () => {
    try {
      const crm = new CrmClient({ baseUrl: config.crmBase, token: config.token, fetchImpl });
      const [source, accounts] = await Promise.all([
        scrapeCommunities({ baseUrl: config.websiteBase, fetchImpl }),
        crm.listAccounts(),
      ]);
      const { parent, proposals } = buildProposals(source, accounts);
      const completedAt = new Date().toISOString();
      const state = await readState(config.statePath);
      const run = mergePipelineRun(state, {
        source,
        accounts,
        proposals,
        startedAt,
        completedAt,
        signingKey: config.intentSigningKey,
      });
      await writeState(config.statePath, state);
      return { run, parent, proposals, statePath: config.statePath };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const state = await readState(config.statePath);
      recordPipelineFailure(state, {
        startedAt,
        completedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      await writeState(config.statePath, state);
      throw error;
    }
  });
}
