import { Command } from 'commander';
import { resolve } from 'node:path';
import { openDb, resolveDbPath, type Db } from '@skillcheck/core';
import { GitHubClient } from './githubClient';
import { harvestRepo } from './harvestRepo';
import { harvestMarketplace } from './marketplace';
import { discoverRegistries } from './registries';
import { codeSearchAll } from './codeSearch';
import { createHarvestRun, finishRun, recordTask, cohortStats } from './store';

const CODE_SEARCH_QUERY = 'filename:SKILL.md "name:"';

function today(): string {
  // Harvest legitimately stamps "now" (screening/publishing stay wall-clock-free, not this).
  return new Date().toISOString().slice(0, 10);
}

interface HarvestOptions {
  db?: string;
  mirror?: string;
  snapshot?: string;
  sources?: string;
  topRegistries?: number;
}

function updateRunParams(db: Db, runId: string, patch: Record<string, unknown>): void {
  const row = db.prepare('SELECT params_json FROM runs WHERE id=?').get(runId) as { params_json: string | null };
  const params = row?.params_json ? (JSON.parse(row.params_json) as Record<string, unknown>) : {};
  db.prepare('UPDATE runs SET params_json=? WHERE id=?').run(JSON.stringify({ ...params, ...patch }), runId);
}

async function run(opts: HarvestOptions): Promise<void> {
  const db = openDb(resolveDbPath(opts.db));
  const mirrorRoot = opts.mirror ? resolve(opts.mirror) : resolve(process.cwd(), 'data', 'mirror');
  const snapshot = opts.snapshot ?? today();
  const client = new GitHubClient();
  const sources = new Set((opts.sources ?? 'anthropic,marketplace,registries,codesearch').split(',').map((s) => s.trim()));
  const topRegistries = opts.topRegistries ?? 3;

  const runId = createHarvestRun(db, snapshot, {
    sources: [...sources],
    authenticated: client.authenticated,
    topRegistries,
  });
  const log = (m: string) => process.stderr.write(m + '\n');
  log(`Harvest run ${runId} (snapshot ${snapshot}, ${client.authenticated ? 'authenticated' : 'UNAUTHENTICATED'})`);

  try {
    if (sources.has('anthropic')) {
      const r = await harvestRepo(db, client, 'anthropics/skills', 'anthropics_skills', null, runId, mirrorRoot);
      recordTask(db, runId, 'tree_scan:anthropics/skills', 'tree_scan', 'done', { skillCount: r.skillCount });
      log(`  anthropics/skills: ${r.skillCount} skills`);
    }

    if (sources.has('marketplace')) {
      const r = await harvestMarketplace(db, client, runId, mirrorRoot);
      recordTask(db, runId, 'marketplace', 'marketplace', r.found ? 'done' : 'failed', {
        marketplaceRepo: r.marketplaceRepo,
        pluginRepos: r.pluginRepos.length,
      });
      updateRunParams(db, runId, { marketplace: { found: r.found, repo: r.marketplaceRepo, plugins: r.pluginRepos } });
      log(
        r.found
          ? `  marketplace (${r.marketplaceRepo}): ${r.pluginRepos.length} plugin repos, ${r.skillCount} skills`
          : `  marketplace: NOT FOUND at any pinned candidate — update MARKETPLACE_CANDIDATES`,
      );
    }

    if (sources.has('registries')) {
      if (!client.authenticated) {
        log('  registries: SKIPPED (requires auth — set GITHUB_TOKEN)');
      } else {
        const sel = await discoverRegistries(client, topRegistries);
        updateRunParams(db, runId, { registrySelection: sel });
        let count = 0;
        for (const repo of sel.selected) {
          const r = await harvestRepo(db, client, repo, 'community_registry', repo, runId, mirrorRoot);
          count += r.skillCount;
        }
        recordTask(db, runId, 'registry_parse', 'registry_parse', 'done', { selected: sel.selected, count });
        log(`  registries: ${sel.selected.join(', ')} → ${count} skills`);
      }
    }

    if (sources.has('codesearch')) {
      if (!client.authenticated) {
        log('  code search: SKIPPED (requires auth — set GITHUB_TOKEN)');
      } else {
        const cs = await codeSearchAll(client, CODE_SEARCH_QUERY);
        const repos = Array.from(new Set(cs.items.map((i) => i.repo))).sort();
        let count = 0;
        for (const repo of repos) {
          const r = await harvestRepo(db, client, repo, 'code_search', null, runId, mirrorRoot);
          count += r.skillCount;
        }
        recordTask(db, runId, 'code_search', 'code_search_slice', 'done', {
          slices: cs.slices,
          truncated: cs.truncated,
          repos: repos.length,
          count,
        });
        updateRunParams(db, runId, { codeSearch: { truncated: cs.truncated, slices: cs.slices.length, repos: repos.length } });
        log(`  code search: ${repos.length} repos → ${count} skills${cs.truncated ? ' (TRUNCATED — N is a lower bound)' : ''}`);
      }
    }

    finishRun(db, runId, 'complete');
    const stats = cohortStats(db);
    log('\nCohort:');
    log(`  total ${stats.total} | by source ${JSON.stringify(stats.bySource)}`);
    log(`  multi-source ${stats.multiSource} | forks ${stats.forks} | invalid-frontmatter ${stats.invalidFrontmatter}`);
  } catch (e) {
    finishRun(db, runId, 'failed');
    throw e;
  }
}

const program = new Command();
program
  .name('harvest')
  .description('Enumerate the Claude Code skill cohort (M1: The Scan).')
  .option('--db <path>', 'SQLite database path')
  .option('--mirror <dir>', 'mirror root directory')
  .option('--snapshot <date>', 'snapshot date YYYY-MM-DD (default: today)')
  .option('--sources <list>', 'comma list: anthropic,marketplace,registries,codesearch')
  .option('--top-registries <n>', 'number of community registries to include', (v) => parseInt(v, 10))
  .action((opts: HarvestOptions) => run(opts));

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`${(e as Error).stack ?? e}\n`);
  process.exitCode = 1;
});
