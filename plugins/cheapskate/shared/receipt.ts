import { z } from "zod";

export const receiptKind = "routing-receipt";
export const receiptSchema = z.object({
  chain: z.string(),
  state: z.enum(["completed", "failed", "canceled"]),
  answer: z.string().optional(),
  steps: z.array(z.object({
    label: z.string(),
    result: z.enum(["answered", "limit", "tool-grammar", "failed", "canceled", "unavailable", "permissions", "billing", "declined", "cooldown", "sticky"]),
    resetAt: z.number().optional(),
  })),
  omitted: z.number(),
  usage: z.object({
    inputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalCostUsd: z.number().optional(),
  }).optional(),
});

export type Receipt = z.infer<typeof receiptSchema>;
export type RouteStep = Receipt["steps"][number];
