import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Receipt, RouteStep } from "../shared/receipt";

const stepLabels: Record<RouteStep["result"], string> = {
  answered: "Answered",
  limit: "Hit provider limit",
  "tool-grammar": "Exceeded tool-call grammar limit",
  failed: "Provider error",
  canceled: "Canceled",
  unavailable: "Backend controls unavailable",
  permissions: "Could not preserve permissions",
  billing: "Excluded by billing policy",
  declined: "Billing approval declined",
  cooldown: "Waiting for reported reset",
  sticky: "Kept the active backend",
};

export function RoutingReceipt({ item, theme }: PluginTimelineItemProps<Receipt>) {
  const [open, setOpen] = useState(false);
  const { chain, state, answer, steps, omitted, usage } = item.data;
  const totals = [
    usage?.inputTokens !== undefined && `${usage.inputTokens.toLocaleString()} input tokens`,
    usage?.cachedInputTokens !== undefined && `${usage.cachedInputTokens.toLocaleString()} cached input tokens`,
    usage?.outputTokens !== undefined && `${usage.outputTokens.toLocaleString()} output tokens`,
    usage?.totalCostUsd !== undefined && `${usage.totalCostUsd.toLocaleString(undefined, {
      style: "currency", currency: "USD", maximumFractionDigits: 8,
    })} reported cost`,
  ].filter(Boolean).join(" · ");
  const foreground = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const detail = state === "completed" ? answer ?? "Completed" : state === "failed" ? "Turn failed" : "Turn canceled";
  return <View style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10 }}>
      <Icon name={open ? "ChevronDown" : "ChevronRight"} color={muted} size={15} />
      <Text style={{ color: foreground, flexShrink: 1 }}>Routing receipt · {detail}</Text>
    </Pressable>
    {open && <View style={{ gap: 8, paddingHorizontal: 14, paddingBottom: 12 }}>
      <Text style={{ color: muted }}>Chain · {chain}</Text>
      {steps.map(({ label, result, resetAt }, index) => <View key={index}>
        <Text style={{ color: foreground }}>{label}</Text>
        <Text style={{ color: muted }}>{stepLabels[result]}{resetAt ? ` · Reported reset ${new Date(resetAt).toLocaleString()}` : ""}</Text>
      </View>)}
      {omitted > 0 && <Text style={{ color: muted }}>{omitted} additional routing decisions</Text>}
      {answer && <Text style={{ color: muted }}>{totals || "The answering backend did not report token or cost totals."}</Text>}
    </View>}
  </View>;
}
