import type { PaseoApi } from "./backend";
import { readControls, routePermissions, type BackendControls } from "./controls.ts";

export async function inspectChain(paseo: PaseoApi, chain: string[], source = chain[0]) {
  const { entries } = await paseo.providers.snapshot();
  const checks: { selection: string; label: string; backend?: BackendControls; error?: string }[] = [];
  for (const selection of chain) {
    try {
      const providerId = selection.slice(0, selection.indexOf("/"));
      const provider = entries.find(({ provider }) => provider === providerId);
      if (provider?.enabled === false) throw new Error("This provider is disabled on this host.");
      const backend: BackendControls = await readControls(paseo, selection);
      checks.push(backend.selectable
        ? { selection, label: backend.label, backend }
        : { selection, label: backend.label, error: "Paseo does not list this model as selectable." });
    } catch (error) {
      checks.push({ selection, label: selection, error: error instanceof Error ? error.message : "Unable to read backend controls." });
    }
  }

  const sourceBackend = checks.find((check) => check.selection === source)?.backend;
  const modes = sourceBackend ? [...sourceBackend.modes] : [];
  if (sourceBackend && !modes.length) modes.push({ id: "", label: "Provider default" });
  return {
    modes,
    defaultMode: modes.find(({ id }) => id === sourceBackend?.defaultMode)?.id ?? modes[0]?.id ?? "",
    rows: checks.map(({ selection, label, backend, error }) => ({
      selection, label, error,
      available: backend
        ? backend.modes.length ? [...backend.modes] : [{ id: "", label: "Provider default" }]
        : [],
      mappings: sourceBackend && backend ? Object.fromEntries(modes.map(({ id }) => {
        const result = routePermissions(id || undefined, sourceBackend, backend, sourceBackend.options);
        const mappedMode = backend.modes.find((mode) => mode.id === result?.mode)?.label;
        return [id, result ? mappedMode ?? result.mode ?? "Provider default" : null];
      })) : {},
    })),
  };
}
