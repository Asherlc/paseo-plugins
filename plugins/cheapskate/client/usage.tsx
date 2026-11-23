import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import type { z } from "zod";
import { usageSummary } from "../shared/usage";

type Theme = PluginSurfaceProps["theme"];
type Row = z.output<typeof usageSummary.output>["rows"][number];
type State = { loading: boolean; rows: Row[]; error?: string };

const tokens = (value: number | null) => value === null ? "—" : value.toLocaleString();

export function Usage({ theme, close }: { theme: Theme; close(): void }) {
  const summary = useRpc(usageSummary);
  const [state, setState] = useState<State>({ loading: true, rows: [] });
  const [attempt, setAttempt] = useState(0);
  const refresh = () => setAttempt((current) => current + 1);

  useEffect(() => {
    let active = true;
    setState({ loading: true, rows: [] });
    summary({}).then(
      (result) => { if (active) setState({ loading: false, rows: result.rows }); },
      (failure: unknown) => {
        if (active) setState({ loading: false, rows: [],
          error: failure instanceof Error ? failure.message : "Unable to read usage." });
      },
    );
    return () => { active = false; };
  }, [summary, attempt]);

  return (
    <Modal title="Usage" open onOpenChange={(open) => { if (!open) close(); }}>
      <Modal.Content>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Totals from completed backend turns on this host since usage tracking began.
        </Text>
        {!state.error && <SettingsAction label="Usage totals" actionLabel={state.loading ? "Refreshing…" : "Refresh"}
          disabled={state.loading} onPress={refresh} />}
        {state.loading ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>Loading usage…</Text>
        ) : state.error ? (
          <SettingsAction label="Usage totals" error={state.error} actionLabel="Retry" onPress={refresh} />
        ) : state.rows.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>No usage recorded yet.</Text>
        ) : <>
          <SettingsCard>
            {state.rows.map((row) => <SettingsRow
              key={`${row.providerId}/${row.modelId}`}
              label={`${row.providerId}/${row.modelId}`}
              hint={`Input ${tokens(row.inputTokens)} · Cached ${tokens(row.cachedInputTokens)} · Output ${tokens(row.outputTokens)} · ${row.completedTurns.toLocaleString()} completed · ${row.incompleteTurns.toLocaleString()} missing input/output`}
            />)}
          </SettingsCard>
          <Text style={{ color: theme.colors.foregroundMuted }}>— means no token count was reported for that field.</Text>
        </>}
      </Modal.Content>
    </Modal>
  );
}
