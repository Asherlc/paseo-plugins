import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { checkChain } from "../shared/chain-check";
import { findMapping, parseChain, type ModeMappings } from "../shared/settings";

// "automatic" means no saved mapping. Native mode IDs, including the empty
// provider-default ID, are prefixed so they never collide with it.
const automaticValue = "automatic";
const modeValue = (id: string) => `mode:${id}`;

export function ChainCheck({ chain, theme, saving, mappings, onMappingsChange }: {
  chain: string | null; theme: PluginSurfaceProps["theme"]; saving: boolean;
  mappings: ModeMappings; onMappingsChange(mappings: ModeMappings): void;
}) {
  const check = useRpc(checkChain);
  const [result, setResult] = useState<z.output<typeof checkChain.output>>();
  const [source, setSource] = useState("");
  const [mode, setMode] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const selections = useMemo(() => parseChain(chain ?? ""), [chain]);

  useEffect(() => {
    setSource((current) => selections.includes(current) ? current : selections[0] ?? "");
  }, [selections]);

  async function run(nextSource = source) {
    if (!chain || checking) return;
    setChecking(true);
    setError(undefined);
    setResult(undefined);
    try {
      const next = await check({ chain, source: nextSource || undefined });
      setSource(nextSource || selections[0] || "");
      setMode(next.defaultMode);
      setResult(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to check the chain.");
    } finally {
      setChecking(false);
    }
  }

  function changeMapping(destination: string, value: string) {
    const next = mappings.filter((mapping) => mapping.source !== source
      || mapping.sourceMode !== mode || mapping.destination !== destination);
    if (value !== automaticValue) {
      next.push({ source, sourceMode: mode, destination, destinationMode: value.slice(modeValue("").length) });
    }
    onMappingsChange(next);
  }

  const sourceOptions = selections.map((selection) => ({
    value: selection,
    label: result?.rows.find((row) => row.selection === selection)?.label ?? selection,
  }));

  return <>
    <SettingsAction label="Catalog and permissions" actionLabel={checking ? "Checking…" : "Check chain"}
      hint="Checks the current rows against Paseo’s catalog and provider defaults, without sending a model request."
      error={error} disabled={!chain || checking || saving} onPress={() => void run()} />
    {result && <SettingsCard>
      <SettingsSelect label="Source backend" value={source} options={sourceOptions}
        disabled={checking || saving} onValueChange={(value) => { setSource(value); void run(value); }} />
      {result.modes.length > 0 && <SettingsSelect label="Source permission mode" value={mode}
        options={result.modes.map(({ id, label }) => ({ value: id, label }))}
        disabled={checking || saving} onValueChange={setMode} />}
      {result.rows.map((row, index) => {
        const automatic = Object.hasOwn(row.mappings, mode) ? row.mappings[mode] : undefined;
        const automaticWins = automatic !== null && automatic !== undefined;
        const saved = findMapping(mappings, source, mode, row.selection);
        const savedMode = saved?.destinationMode;
        // A mode-less destination exposes only the synthetic Provider default.
        const modeLessDestination = row.available.length === 1 && row.available[0]?.id === "";
        const stale = savedMode !== undefined
          && (savedMode === "" ? !modeLessDestination : !row.available.some(({ id }) => id === savedMode));
        const isSource = row.selection === source;
        const showControl = !row.error && !isSource && result.modes.length > 0;
        const editable = showControl && !checking && !saving;
        const hint = row.error ? undefined : isSource ? "This is the source backend"
          : automaticWins ? `Available · ${automatic}${saved ? " · saved mode not used" : ""}`
          : stale ? `Unavailable · ${savedMode || "Provider default"}`
          : savedMode !== undefined ? `Explicit · ${row.available.find(({ id }) => id === savedMode)?.label ?? savedMode}`
          : automatic === null ? "Skipped with this permission mode"
          : "Listed · permission match unknown";
        return showControl
          ? <SettingsSelect key={index} label={row.label} error={row.error || undefined}
              hint={["Explicit mode", hint].filter(Boolean).join(" · ")}
              value={saved ? modeValue(savedMode ?? "") : automaticValue}
              options={[{ value: automaticValue, label: "Automatic" },
                ...(stale ? [{ value: modeValue(savedMode ?? ""), label: `Unavailable · ${savedMode || "Provider default"}` }] : []),
                ...row.available.map(({ id, label }) => ({ value: modeValue(id), label }))]}
              disabled={!editable} onValueChange={(value) => changeMapping(row.selection, value)} />
          : <SettingsRow key={index} label={row.label} error={row.error || undefined} hint={hint} />;
      })}
      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          A mapped destination uses its own provider defaults. Choose a mode with restrictions appropriate for that backend, then click Save to keep your changes.
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>Quota and account access are checked when a backend runs a turn.</Text>
      </View>
    </SettingsCard>}
  </>;
}
