import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "../server/backend.ts";
import { inspectChain } from "../server/chain-check.ts";

const modes: Record<string, { id: string; label: string }[]> = {
  alpha: [{ id: "plan", label: "Plan" }],
  beta: [],
  gamma: [{ id: "plan", label: "Plan" }],
};
const selectable: Record<string, boolean> = { alpha: true, beta: true, gamma: false };

const paseo = {
  providers: {
    snapshot: async () => ({ entries: Object.keys(modes).map((provider) => ({ provider, enabled: true })) }),
    listModels: async (provider: string) => ({
      models: [{ id: "model", label: `${provider} model`, isSelectable: selectable[provider] }],
    }),
    listModes: async (provider: string) => ({ modes: modes[provider] }),
    listControls: async () => ({ options: {} }),
  },
  config: { get: async () => ({ config: {} }) },
} as unknown as PaseoApi;

const chain = ["alpha/model", "beta/model", "gamma/model"];

test("inspectChain defaults to the first row and keeps non-selectable rows as errors", async () => {
  const result = await inspectChain(paseo, chain);
  assert.deepEqual(result.modes, [{ id: "plan", label: "Plan" }]);
  assert.equal(result.defaultMode, "plan");
  assert.deepEqual(result.rows.map(({ selection }) => selection), chain);
  assert.equal(result.rows[2]?.error, "Paseo does not list this model as selectable.");
  assert.deepEqual(result.rows[2]?.available, []);
});

test("inspectChain uses the chosen source, including a mode-less one", async () => {
  const result = await inspectChain(paseo, chain, "beta/model");
  assert.deepEqual(result.modes, [{ id: "", label: "Provider default" }]);
  assert.equal(result.defaultMode, "");
  assert.deepEqual(result.rows[0]?.available, [{ id: "plan", label: "Plan" }]);
});
