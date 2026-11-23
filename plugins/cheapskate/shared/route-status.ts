import { z } from "zod";

export const activeRouteKey = "cheapskate.activeRoute";
export const primaryRequestKey = "cheapskate.tryPrimary";
export const handledPrimaryKey = "cheapskate.handledPrimary";
export const quotaResetsKey = "cheapskate.quotaResets";
export const quotaReset = z.object({ resetAt: z.number().finite(), label: z.string() });
export const quotaResets = z.record(z.string(), quotaReset);

export const activeRoute = z.object({
  selection: z.string(),
  label: z.string(),
  change: z.object({
    reason: z.enum(["limit", "tool-grammar", "unavailable", "permissions", "requested", "removed", "recovered", "chain", "billing"]),
    from: z.string(),
  }).optional(),
});

export type RouteChange = NonNullable<z.infer<typeof activeRoute>["change"]>;
