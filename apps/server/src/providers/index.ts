import type { Config } from "../config";
import { tokenFor } from "../config";
import { azureDevOps } from "./azureDevOps";
import { github } from "./github";
import type { Provider, Ref } from "./types";

export function buildProviders(cfg: Config): Provider[] {
  const out: Provider[] = [];
  const { azure_devops: ado, github: gh } = cfg.providers;
  if (ado?.enabled) out.push(azureDevOps(tokenFor(ado), ado.api_version));
  if (gh?.enabled) out.push(github(tokenFor(gh)));
  return out;
}

/** First enabled provider that recognizes the URL. */
export function resolveUrl(providers: Provider[], url: string): { provider: Provider; ref: Ref } | null {
  for (const provider of providers) {
    const ref = provider.parse(url);
    if (ref) return { provider, ref };
  }
  return null;
}
