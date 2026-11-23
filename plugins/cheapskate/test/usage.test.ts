import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUsageStore } from "../server/usage.ts";

test("usage totals accumulate per provider/model, persist, and distinguish unknown from zero", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cheapskate-usage-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const store = createUsageStore();
  assert.deepEqual(store.summary(), { rows: [] }, "a fresh host has no usage rows");

  const answering = "opencode/opencode/hy4-flash-free";
  const silent = "opencode/opencode/silent";
  store.record({ providerId: "opencode", modelId: answering, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } });
  store.record({ providerId: "opencode", modelId: answering, usage: { inputTokens: 1, outputTokens: 3 } });
  store.record({ providerId: "opencode", modelId: silent, usage: { totalCostUsd: 0.02 } });
  store.record({ providerId: "opencode", modelId: silent });
  store.record({ providerId: "openrouter", modelId: "openrouter/free", usage: { cachedInputTokens: 4, totalCostUsd: 0.01 } });
  store.record({ providerId: "openrouter", modelId: "openrouter/free", usage: { inputTokens: 0, outputTokens: 0 } });

  const expected = {
    rows: [
      {
        providerId: "opencode", modelId: answering,
        inputTokens: 11, cachedInputTokens: 2, outputTokens: 8,
        completedTurns: 2, incompleteTurns: 0,
      },
      {
        providerId: "opencode", modelId: silent,
        inputTokens: null, cachedInputTokens: null, outputTokens: null,
        completedTurns: 2, incompleteTurns: 2,
      },
      {
        providerId: "openrouter", modelId: "openrouter/free",
        inputTokens: 0, cachedInputTokens: 4, outputTokens: 0,
        completedTurns: 2, incompleteTurns: 1,
      },
    ],
  };
  assert.deepEqual(store.summary(), expected);
  assert.deepEqual(store.summary().rows[1], {
    providerId: "opencode", modelId: silent,
    inputTokens: null, cachedInputTokens: null, outputTokens: null,
    completedTurns: 2, incompleteTurns: 2,
  }, "never-reported fields stay null across cost-only and absent reports");
  store.close();

  const reopened = createUsageStore();
  assert.deepEqual(reopened.summary(), expected, "totals survive closing and reopening on the same host");
  reopened.record({ providerId: "opencode", modelId: answering, usage: { inputTokens: 2 } });
  assert.deepEqual(reopened.summary().rows[0], {
    providerId: "opencode", modelId: answering,
    inputTokens: 13, cachedInputTokens: 2, outputTokens: 8,
    completedTurns: 3, incompleteTurns: 1,
  }, "a later partial turn adds to the existing sums and increments missing coverage");
  reopened.close();
});
