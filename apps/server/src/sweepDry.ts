// One real scan, read-only: prints the PR links found and the review decision for each.
// It launches no sessions and writes no state. Usage: bun src/sweepDry.ts [--hours 24]
import { loadConfig } from "./config";
import { buildProviders } from "./providers";
import { claudeScanner, extractPrUrls, needsReview, skipReason } from "./teamsSweep";

const cfg = loadConfig();
const hoursArg = process.argv.indexOf("--hours");
const hours = hoursArg > 0 ? Number(process.argv[hoursArg + 1]) : 24;
const providers = buildProviders(cfg);
const ado = providers.find((p) => p.key === "azure_devops");
const since = new Date(Date.now() - hours * 3600_000).toISOString();

if (!cfg.teams_sweep.sources.length) { console.error("teams_sweep.sources is empty (set it in config.local.yaml)"); process.exit(1); }
console.log(`Scanning ${cfg.teams_sweep.sources.length} sources for messages since ${since} (model ${cfg.teams_sweep.model}) ...`);
const msgs = await claudeScanner(cfg)(cfg.teams_sweep.sources.map((s) => ({ ...s, since })));
console.log(`${msgs.length} messages`);

const seen = new Set<string>();
for (const m of msgs) {
  for (const pr of extractPrUrls(m.bodyPreview, providers)) {
    if (seen.has(pr.key)) continue;
    seen.add(pr.key);
    let verdict = "(no Azure DevOps provider)";
    if (ado?.prStatus) {
      try {
        const st = await ado.prStatus(ado.parse(pr.url)!);
        verdict = `${needsReview(st, cfg.teams_sweep.me) ? "NEEDS REVIEW" : `skip (${skipReason(st, cfg.teams_sweep.me)})`}  [${st.status}${st.isDraft ? ", draft" : ""}] ${st.title}`;
      } catch (err) { verdict = `status failed: ${(err as Error).message}`; }
    }
    console.log(`- ${pr.url}\n    from ${m.from} in "${m.source}" at ${m.createdDateTime}\n    ${verdict}`);
  }
}
if (!seen.size) console.log("No PR links found.");
