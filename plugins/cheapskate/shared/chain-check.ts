import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { chainSettings } from "./settings";

export const checkChain = defineRpc({
  name: "routing.check-chain",
  // source is optional so callers that only pass a chain keep the original entry point.
  input: chainSettings.pick({ chain: true }).extend({ source: z.string().optional() }),
  output: z.object({
    defaultMode: z.string(),
    modes: z.array(z.object({ id: z.string(), label: z.string() })),
    rows: z.array(z.object({
      selection: z.string(),
      label: z.string(),
      error: z.string().optional(),
      available: z.array(z.object({ id: z.string(), label: z.string() })),
      mappings: z.record(z.string(), z.string().nullable()),
    })),
  }),
});
