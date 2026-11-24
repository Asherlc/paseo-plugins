import type { PaseoApi } from "./backend";
import type {
  ProviderConfigState,
  ProviderMode,
  ProviderOptionControl,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import { findMapping, type ModeMappings } from "../shared/settings.ts";

export type Options = NonNullable<ProviderConfigState["providerOptions"]>;
type ModeCatalog = { id: string; family: string; modes: readonly ProviderMode[] };
export type BackendControls = ModeCatalog & {
  selection: string;
  modelId: string;
  label: string;
  selectable: boolean;
  defaultMode?: string;
  thinking: readonly ProviderThinkingOption[];
  defaultThinking?: string;
  controls: readonly ProviderOptionControl[];
  options: Options;
};

const thinkingRanks: Record<string, number> = {
  none: 0, off: 0, minimal: 1, low: 2, medium: 3, standard: 3,
  high: 4, extended: 4, xhigh: 5, max: 6, ultra: 7,
};

export function closestThinking(
  desired: string | undefined,
  choices: readonly ProviderThinkingOption[],
): string | undefined {
  if (!desired || desired === "auto") return undefined;
  if (choices.some(({ id }) => id === desired)) return desired;
  const rank = thinkingRanks[desired];
  if (!Object.hasOwn(thinkingRanks, desired)) return undefined;
  const candidates = choices.filter(({ id }) => Object.hasOwn(thinkingRanks, id));
  candidates.sort((a, b) =>
    Math.abs(thinkingRanks[a.id] - rank) - Math.abs(thinkingRanks[b.id] - rank)
    || thinkingRanks[a.id] - thinkingRanks[b.id]);
  return candidates[0]?.id;
}

// Use only known native permission modes for cross-provider mappings. The same ID
// can have unrelated semantics in two providers, and custom modes are opaque.
const permissionRanks: Record<string, Record<string, number>> = {
  claude: { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 },
  codex: { auto: 2, "auto-review": 3, "full-access": 4 },
  opencode: { plan: 0, build: 2 },
};

export function closestMode(
  desired: string | undefined,
  source: ModeCatalog,
  destination: ModeCatalog,
): string | undefined | null {
  if (source.id === destination.id) {
    if (desired && !destination.modes.some(({ id }) => id === desired)) return null;
    return desired;
  }
  // Provider and mode IDs are arbitrary strings: constructor/name/length are
  // valid and must resolve only through own properties, never the prototype.
  const sourceRanks = Object.hasOwn(permissionRanks, source.family) ? permissionRanks[source.family] : undefined;
  const rank = desired && sourceRanks && Object.hasOwn(sourceRanks, desired)
    ? sourceRanks[desired] : undefined;
  if (typeof rank !== "number" || !Number.isFinite(rank)) return null;
  if (source.family === destination.family && destination.modes.some(({ id }) => id === desired)) return desired;
  // The Codex workspace sandbox has no writable equivalent in these other providers.
  const ceiling = source.family === "codex" && destination.family !== "codex" && rank < 4 ? 0 : rank;
  const ranks = Object.hasOwn(permissionRanks, destination.family) ? permissionRanks[destination.family] : undefined;
  if (!ranks) return null;
  return destination.modes
    .filter(({ id }) => Object.hasOwn(ranks, id) && ranks[id] <= ceiling)
    .sort((a, b) => ranks[b.id] - ranks[a.id])[0]?.id ?? null;
}

const performanceOptions = new Set(["fast", "fast_mode", "service_tier"]);
const permissionOptions = new Set(["auto_accept", "permission"]);

export function fallbackOptions(
  source: ModeCatalog,
  destination: ModeCatalog,
  options: Options,
  mode?: string,
): Options | null {
  if (source.id === destination.id) return options;
  const entries = Object.entries(options).filter(([key, value]) =>
    value != null && !performanceOptions.has(key));
  if (source.family === destination.family && source.family === "opencode") {
    if (entries.some(([key]) => !permissionOptions.has(key))) return null;
    return { ...Object.fromEntries(entries), auto_accept: options.auto_accept === true };
  }
  if (entries.some(([key]) => key !== "auto_accept")) return null;
  if (destination.family === "opencode") {
    // A cross-provider read-only mapping cannot rely on workspace permission defaults.
    return { auto_accept: false, permission: mode === "plan" ? "deny" : "ask" };
  }
  if (source.family === destination.family && entries.length) return null;
  return {};
}

export function routePermissions(
  desired: string | undefined, source: ModeCatalog, destination: ModeCatalog, options: Options,
) {
  const mode = closestMode(desired, source, destination);
  if (mode === null) return null;
  const mapped = fallbackOptions(source, destination, options, mode);
  return mapped === null ? null : { mode, options: mapped };
}

// Explicit mappings are a fallback for turns the automatic router cannot map.
// They require the BackendControls path, where selection and options are present,
// so the destination keeps its own options instead of inheriting the source's.
export function resolveBackendPermissions(
  source: BackendControls, destination: BackendControls, desired: string | undefined,
  options: Options, mappings?: ModeMappings,
) {
  const automatic = routePermissions(desired, source, destination, options);
  if (automatic) return automatic;
  if (!mappings) return null;
  // The empty mode is an internal sentinel for a source that lists no modes. A
  // source with modes must name one of them; undefined is not a mode-less source.
  const sourceMode = source.modes.length
    ? desired && source.modes.some(({ id }) => id === desired) ? desired : undefined
    : "";
  if (sourceMode === undefined) return null;
  const explicit = findMapping(mappings, source.selection, sourceMode, destination.selection);
  if (!explicit) return null;
  const { destinationMode } = explicit;
  // Empty means the destination's provider default, which exists only while the
  // destination lists no modes. If modes appeared since the mapping was saved,
  // the mode is stale and the backend must be skipped.
  if (!destinationMode) return destination.modes.length ? null : { mode: undefined, options: destination.options };
  if (!destination.modes.some(({ id }) => id === destinationMode)) return null;
  return { mode: destinationMode, options: destination.options };
}

export async function readControls(
  paseo: PaseoApi, selection: string, cwd?: string, options?: Options,
): Promise<BackendControls> {
  const slash = selection.indexOf("/");
  const id = selection.slice(0, slash);
  const modelId = selection.slice(slash + 1);
  const [{ models, error: modelError }, { modes, error: modeError }, controls, snapshot, { config }] = await Promise.all([
    paseo.providers.listModels(id, { cwd }),
    paseo.providers.listModes(id, { cwd }),
    paseo.providers.listControls({ provider: selection, cwd: cwd ?? process.cwd(), providerOptions: options }),
    paseo.providers.snapshot({ cwd }),
    paseo.config.get(),
  ]);
  if (modelError || modeError || controls.error) {
    throw new Error(modelError || modeError || controls.error || "Unable to read backend controls.");
  }
  const model = models?.find((candidate) => candidate.id === modelId || candidate.aliases?.includes(modelId));
  if (!model) throw new Error(`Paseo did not list the configured model ${selection}.`);
  const provider = snapshot.entries.find(({ provider }) => provider === id);
  const family = typeof config.providers?.[id]?.extends === "string" ? config.providers[id].extends : id;
  const values: Options = { ...controls.options as Options, ...options };
  const thinking = (model.thinkingOptions ?? []).map(({ id, label, description, isDefault }) =>
    ({ id, label, description, isDefault }));
  return {
    id, family, selection, modelId: model.id, label: `${provider?.label ?? id} · ${model.label}`,
    selectable: model.isSelectable !== false, modes: modes ?? [],
    defaultMode: provider?.defaultModeId
      ?? (family === "opencode" && modes?.some(({ id }) => id === "build") ? "build" : undefined),
    thinking, defaultThinking: model.defaultThinkingOptionId,
    controls: controls.controls ?? [],
    options: values,
  };
}
