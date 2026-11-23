import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const usageSummary = defineRpc({
  name: "usage.summary",
  input: z.object({}),
  output: z.object({
    rows: z.array(z.object({
      providerId: z.string(),
      modelId: z.string(),
      inputTokens: z.number().nullable(),
      cachedInputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      completedTurns: z.number().int().nonnegative(),
      incompleteTurns: z.number().int().nonnegative(),
    })),
  }),
});
