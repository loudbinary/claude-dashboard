import type { Store, Watch } from "./db";
import { resolveUrl } from "./providers";
import type { Provider } from "./providers/types";
import { TERMINAL } from "./providers/types";

/** Polls every active watch once. Returns the watches whose state or detail changed. */
export async function pollOnce(store: Store, providers: Provider[]): Promise<Watch[]> {
  const changed: Watch[] = [];
  for (const w of store.listWatches(true)) {
    const hit = resolveUrl(providers, w.url);
    if (!hit) continue;
    try {
      const s = await hit.provider.runStatus(hit.ref);
      if (s.state === w.state && s.detail === w.detail && s.title === w.title) continue;
      const next = store.updateWatch(w.id, { ...s, active: TERMINAL.includes(s.state) ? 0 : 1 });
      if (next) changed.push(next);
    } catch (err) {
      // Keep the last known state and keep polling; show the error in the detail line.
      const detail = `Last check failed: ${(err as Error).message}`;
      if (detail !== w.detail) {
        const next = store.updateWatch(w.id, { detail });
        if (next) changed.push(next);
      }
    }
  }
  return changed;
}

export function startWatcher(store: Store, providers: Provider[], seconds: number, onChange: (w: Watch) => void) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { (await pollOnce(store, providers)).forEach(onChange); } finally { busy = false; }
  };
  const timer = setInterval(tick, Math.max(5, seconds) * 1000);
  return { tick, stop: () => clearInterval(timer) };
}
