import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const providerId = "cheapskate";
export const defaultModel = { id: providerId, name: "Cheapskate" };

export function parseChain(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const billing = z.enum(["allow", "ask", "free-only"]);
const cost = z.enum(["free", "paid"]);

// Saved explicit permission mappings. A flat, structured list keeps lookups exact:
// native mode IDs are arbitrary strings and can collide with inherited object keys
// such as constructor, so no dynamic-key record is used. An empty sourceMode is a
// mode-less source, and an empty destinationMode is a mode-less destination.
// Entries are deliberately not cross-checked against the current chain so
// reordering or removing rows cannot make previously saved settings invalid.
export const modeMapping = z.object({
  source: z.string(),
  sourceMode: z.string(),
  destination: z.string(),
  destinationMode: z.string(),
});
export type ModeMapping = z.output<typeof modeMapping>;
export type ModeMappings = ModeMapping[];
// Optional so legacy saved settings and typed fixtures stay valid unchanged.
export const modeMappings = z.array(modeMapping).optional();

export function findMapping(
  mappings: ModeMappings | undefined,
  source: string, sourceMode: string, destination: string,
): ModeMapping | undefined {
  return mappings?.find((mapping) => mapping.source === source
    && mapping.sourceMode === sourceMode && mapping.destination === destination);
}

// Mappings are scoped to the selections in their chain, so removed or replaced
// rows must not leave stale records behind on save or chain edits.
export function pruneMappings(mappings: ModeMappings | undefined, chain: string[]): ModeMappings {
  const selections = new Set(chain);
  return (mappings ?? []).filter(({ source, destination }) =>
    selections.has(source) && selections.has(destination));
}

export const chainSettings = z.object({
    chain: z.string().max(4096).default("").superRefine((text, context) => {
      const chain = parseChain(text);
      // Match Paseo's provider ID syntax (including dots and underscores used by
      // plugin providers) while leaving the model ID syntax unchanged.
      const invalid = chain.find(
        (entry) => !/^[a-z][a-z0-9._-]*\/\S+$/.test(entry) || entry.startsWith(providerId + "/"),
      );
      if (invalid) {
        context.addIssue({ code: "custom", message: "Choose a provider and model for every entry. Cheapskate cannot route to itself." });
      } else if (new Set(chain).size !== chain.length) {
        context.addIssue({ code: "custom", message: "Each provider/model can appear only once." });
      }
    }),
    overload: z.boolean().default(false),
    autoReturn: z.boolean().default(false),
    billing: billing.default("allow"),
    costs: z.record(z.string(), cost).default({}),
    mappings: modeMappings,
});

const namedPreset = chainSettings.extend({
  id: z.string().regex(/^chain-[a-z0-9-]{1,48}$/),
  name: z.string().trim().min(1, "Enter a name for each chain.").max(48),
}).refine(({ chain }) => parseChain(chain).length > 0, { message: "Add a backend to each named chain." });

export const preferences = defineSettings({
  id: "routing",
  scope: "host",
  version: 1,
  schema: chainSettings.extend({ presets: z.array(namedPreset).max(12).default([]) }).superRefine(({ presets }, context) => {
    const names = [defaultModel.name, ...presets.map(({ name }) => name)].map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", message: "Give each chain a different name." });
    }
    if (new Set(presets.map(({ id }) => id)).size !== presets.length) {
      context.addIssue({ code: "custom", message: "Each chain must have a unique model ID." });
    }
  }),
});

export type ChainSettings = z.output<typeof chainSettings>;
export type Preset = ChainSettings & { id: string; name: string };
export type BillingPolicy = z.infer<typeof billing>;
export type BackendCost = z.infer<typeof cost>;

export function listPresets({ presets, ...primary }: z.output<typeof preferences.schema>): Preset[] {
  return [{ ...primary, ...defaultModel }, ...presets];
}

export function findPreset(settings: z.output<typeof preferences.schema>, id = defaultModel.id) {
  return listPresets(settings).find((preset) => preset.id === id);
}

export function billingDecision(policy: BillingPolicy, cost?: BackendCost) {
  if (policy === "allow" || cost === "free") return "run";
  return policy === "ask" ? "ask" : "skip";
}

export function primarySelection(preset: ChainSettings) {
  return parseChain(preset.chain).find((backend) => billingDecision(preset.billing, preset.costs[backend]) !== "skip");
}
