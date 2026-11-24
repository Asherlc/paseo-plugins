import { type PluginSurfaceProps, usePaseo, useSettings } from "@getpaseo/plugin/client";
import {
  FlatList, Modal, SettingsAction, SettingsCard, SettingsRow,
  SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, TextInput,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { defaultModel, listPresets, parseChain, preferences, providerId, pruneMappings, type BackendCost, type Preset } from "../shared/settings";
import { formatChain, moveRow, readRows, searchModels, type CatalogModel, type ChainRow } from "./chain-picker";
import { ChainCheck } from "./chain-check";
import { Usage } from "./usage";

type ReadySettings = Extract<ReturnType<typeof useSettings<typeof preferences.schema>>, { status: "ready" }>;
type Theme = PluginSurfaceProps["theme"];
type Catalog = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["snapshot"]>>["entries"];

export function RoutingSettings({ host, theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const [selectedId, setSelectedId] = useState(defaultModel.id);
  const [usageOpen, setUsageOpen] = useState(false);
  return <>
    <View style={{ padding: 16, paddingBottom: 0 }}>
      <SettingsAction label="All-time token usage" actionLabel="View usage" onPress={() => setUsageOpen(true)} />
    </View>
    {usageOpen && <Usage key={host.id} theme={theme} close={() => setUsageOpen(false)} />}
    {settings.status === "ready" ? (
      <RoutingForm key={`${host.id}:${settings.revision}`} theme={theme} settings={settings}
        selectedId={selectedId} setSelectedId={setSelectedId} />
    ) : settings.status === "loading" ? (
      <Text style={{ color: theme.colors.foregroundMuted }}>Loading routing settings…</Text>
    ) : (
      <View style={{ gap: 12, padding: 16 }}>
        <Text style={{ color: theme.colors.foreground }}>{settings.error}</Text>
        <SettingsAction label="Routing settings" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" && (
          <SettingsAction label="Clear saved settings" actionLabel="Reset" onPress={() => void settings.reset()} />
        )}
      </View>
    )}
  </>;
}

function useProviderCatalog() {
  const paseo = usePaseo();
  const [entries, setEntries] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    setError(undefined);
    const unsubscribe = paseo.providers.subscribe((snapshot) => {
      if (!active || snapshot.cwd !== undefined) return;
      receivedUpdate = true;
      setEntries(snapshot.entries);
      setError(undefined);
    });
    void paseo.providers.snapshot().then(
      (snapshot) => { if (active && !receivedUpdate) setEntries(snapshot.entries); },
      (failure: unknown) => {
        if (active && !receivedUpdate) setError(failure instanceof Error ? failure.message : "Provider catalog unavailable.");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [paseo, attempt]);

  return { entries, error, retry: () => setAttempt((current) => current + 1) };
}

type EditableRow = ChainRow & { cost?: BackendCost };
type EditablePreset = Omit<Preset, "chain" | "costs"> & { rows: EditableRow[] };

function RoutingForm({ settings, theme, selectedId, setSelectedId }: {
  settings: ReadySettings; theme: Theme; selectedId: string; setSelectedId(id: string): void;
}) {
  const [presets, setPresets] = useState<EditablePreset[]>(() => listPresets(settings.values).map(({ chain, costs, ...preset }) => ({
    ...preset,
    rows: readRows(chain).map((row) => ({ ...row, cost: costs[`${row.provider}/${row.model}`] })),
  })));
  const preset = presets.find(({ id }) => id === selectedId) ?? presets[0];
  const base = preset.id === defaultModel.id;
  const complete = presets.map(({ rows, mappings, ...route }) => {
    const chain = formatChain(rows);
    // Prune only while serializing a complete chain; an unfinished row keeps its
    // mappings so adding or changing a backend cannot silently discard them.
    const kept = chain === null ? mappings : pruneMappings(mappings, parseChain(chain));
    return {
      ...route,
      chain,
      costs: Object.fromEntries(rows.flatMap(({ provider, model, cost }) => cost ? [[`${provider}/${model}`, cost]] : [])),
      ...(kept?.length ? { mappings: kept } : {}),
    };
  });
  const [{ id: _id, name: _name, ...primary }, ...named] = complete;
  const parsed = preferences.schema.safeParse({ ...primary, presets: named });
  const invalid = complete.find(({ chain }) => chain === null);
  const dirty = !parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(settings.values);
  const saveError = settings.saveError ?? (invalid ? `Choose a provider and model for every entry in ${invalid.name || "the unnamed chain"}.`
    : !parsed.success ? parsed.error.issues[0]?.message : undefined);

  function update(change: Partial<EditablePreset>) {
    setPresets((current) => current.map((route) => route.id === preset.id ? { ...route, ...change } : route));
  }

  function addChain() {
    const id = `chain-${Date.now().toString(36)}`;
    const names = new Set(presets.map(({ name }) => name.toLowerCase()));
    let index = 1;
    while (names.has(`chain ${index}`)) index++;
    setPresets((current) => [...current, { id, name: `Chain ${index}`, rows: [], billing: "ask", autoReturn: false, overload: false }]);
    setSelectedId(id);
  }

  return <View style={{ gap: 16, padding: 16 }}>
    <SettingsSection title="Named chains">
      <SettingsSelect label="Chain" value={preset.id} options={presets.map(({ id, name }) => ({ value: id, label: name || "Unnamed chain" }))}
        disabled={settings.saving} onValueChange={setSelectedId} />
      <SettingsAction label="Add another selectable model" actionLabel="Add chain"
        disabled={settings.saving || named.length >= 12} onPress={addChain} />
      {!base && <SettingsCard>
        <SettingsInput key={preset.id} label="Model name" initialValue={preset.name}
          hint={`CLI model ID · ${preset.id}`} disabled={settings.saving} onChangeText={(name) => update({ name })} />
        <SettingsAction label="Remove this chain" hint="Chats with this model can select another chain."
          actionLabel="Remove chain" disabled={settings.saving} onPress={() => {
            setPresets((current) => current.filter(({ id }) => id !== preset.id));
            setSelectedId(defaultModel.id);
          }} />
      </SettingsCard>}
    </SettingsSection>
    <ChainEditor key={preset.id} preset={preset} theme={theme} saving={settings.saving} update={update} />
    <SettingsAction label="Routing settings" actionLabel={settings.saving ? "Saving…" : "Save"}
      disabled={!dirty || !parsed.success || settings.saving} error={saveError}
      onPress={() => { if (parsed.success) void settings.save(parsed.data, settings.revision); }} />
  </View>;
}

function ChainEditor({ preset, theme, saving, update }: {
  preset: EditablePreset; theme: Theme; saving: boolean; update(change: Partial<EditablePreset>): void;
}) {
  const { rows, overload, autoReturn, billing } = preset;
  const [picking, setPicking] = useState<number>();
  const { entries, error, retry } = useProviderCatalog();
  const ready = (entries ?? []).filter(({ provider, status, enabled }) =>
    provider !== providerId && status === "ready" && enabled);
  const providerOptions = ready
    .map(({ provider, label }) => ({ value: provider, label: label ?? provider }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const discovering = entries === undefined || entries.some(({ status }) => status === "loading");
  const chain = formatChain(rows);
  const selected = rows.find(({ id }) => id === picking);
  const selectedProvider = ready.find(({ provider }) => provider === selected?.provider);

  function patchRow(id: number, change: Partial<EditableRow>) {
    update({ rows: rows.map((row) => row.id === id ? { ...row, ...change } : row) });
  }

  return (
    <>
      <SettingsSection title="Fallback chain">
        <Text style={{ color: theme.colors.foregroundMuted }}>
          Cheapskate tries models from top to bottom. On fallback, the next backend receives recent chat context.
        </Text>
        {error ? (
          <SettingsAction label="Provider catalog" error={error} actionLabel="Retry" onPress={retry} />
        ) : providerOptions.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {discovering ? "Loading providers…" : "No providers are available on this host."}
          </Text>
        ) : null}
        {rows.map((row, index) => {
          const provider = ready.find((entry) => entry.provider === row.provider);
          const providerStatus = entries?.find((entry) => entry.provider === row.provider);
          const knownLabel = providerStatus?.label ?? row.provider;
          const options = [{ value: "", label: "Choose provider" }, ...providerOptions];
          if (row.provider && !provider) {
            const loading = !entries || providerStatus?.status === "loading";
            options.push({ value: row.provider, label: loading ? knownLabel : `${knownLabel} (unavailable)` });
          }
          const models = provider?.models ?? [];
          const model = models.find(({ id, aliases }) => id === row.model || aliases?.includes(row.model));
          const hasModels = models.some(({ isSelectable }) => isSelectable !== false);
          const unavailable = row.model && provider && (!model || model.isSelectable === false);
          return (
            <SettingsCard key={row.id}>
              <SettingsRow label={index === 0 ? "First choice" : `Fallback ${index}`}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                  <RowButton title="Move up" theme={theme} disabled={saving || index === 0}
                    onPress={() => update({ rows: moveRow(rows, row.id, -1) })} />
                  <RowButton title="Move down" theme={theme} disabled={saving || index === rows.length - 1}
                    onPress={() => update({ rows: moveRow(rows, row.id, 1) })} />
                  <RowButton title="Remove" theme={theme} disabled={saving}
                    onPress={() => update({ rows: rows.filter(({ id }) => id !== row.id) })} />
                </View>
              </SettingsRow>
              <SettingsSelect label="Provider" value={row.provider} options={options}
                disabled={saving || providerOptions.length === 0}
                onValueChange={(value) => {
                  if (value !== row.provider) patchRow(row.id, { provider: value, model: "", cost: undefined });
                }} />
              <SettingsAction label="Model" actionLabel={model?.label ?? (row.model || "Choose model")}
                hint={unavailable ? "This saved model is unavailable." : provider && !hasModels ? "No selectable models." : undefined}
                disabled={saving || !hasModels}
                onPress={() => setPicking(row.id)} />
              <SettingsSelect label="Billing" value={row.cost ?? "unknown"}
                options={[{ value: "unknown", label: "Unclassified" }, { value: "free", label: "Free" }, { value: "paid", label: "Paid" }]}
                disabled={saving || !row.provider || !row.model}
                onValueChange={(cost) => patchRow(row.id, { cost: cost === "unknown" ? undefined : cost })} />
            </SettingsCard>
          );
        })}
        <SettingsAction label="Add a provider and model to the chain" actionLabel="Add backend"
          disabled={saving || providerOptions.length === 0}
          onPress={() => {
            const id = Math.max(-1, ...rows.map(({ id }) => id)) + 1;
            update({ rows: [...rows, { id, provider: "", model: "" }] });
          }} />
        <ChainCheck key={chain} chain={chain} theme={theme} saving={saving}
          mappings={preset.mappings ?? []} onMappingsChange={(mappings) => update({ mappings })} />
      </SettingsSection>
      <SettingsSection title="Routing policy">
        <SettingsSelect label="Billing policy" hint="Mark Free only for backends that cannot incur charges on this host."
          value={billing} options={[{ value: "allow", label: "Allow configured backends" },
            { value: "ask", label: "Ask before paid or unclassified" }, { value: "free-only", label: "Free only" }]}
          disabled={saving} onValueChange={(billing) => update({ billing })} />
        <SettingsSwitch label="Return after quota reset" hint="Try the earliest eligible backend on the next message after a reported reset."
          value={autoReturn} onValueChange={(autoReturn) => update({ autoReturn })} disabled={saving} />
        <SettingsSwitch label="Switch on provider overload" value={overload}
          onValueChange={(overload) => update({ overload })} disabled={saving} />
      </SettingsSection>
      {selected && selectedProvider && (
        <ModelPicker
          provider={selectedProvider.label ?? selectedProvider.provider}
          models={selectedProvider.models ?? []}
          theme={theme}
          close={() => setPicking(undefined)}
          select={(model) => {
            if (model !== selected.model) patchRow(selected.id, { model, cost: undefined });
            setPicking(undefined);
          }}
        />
      )}
    </>
  );
}

function RowButton({ title, theme, disabled, onPress }: {
  title: string; theme: Theme; disabled: boolean; onPress(): void;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={{ paddingHorizontal: 8, paddingVertical: 10, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: theme.colors.foreground }}>{title}</Text>
    </Pressable>
  );
}

function ModelPicker({ provider, models, theme, close, select }: {
  provider: string; models: readonly CatalogModel[]; theme: Theme; close(): void; select(model: string): void;
}) {
  const [query, setQuery] = useState("");
  return (
    <Modal title={`${provider} models`} open onOpenChange={(open) => { if (!open) close(); }}>
      <Modal.Content scrollable={false}>
        <TextInput accessibilityLabel="Filter models" placeholder="Filter models" value={query}
          autoCapitalize="none" autoCorrect={false} onChangeText={setQuery}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={{ color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 12 }} />
        <FlatList
          data={searchModels(models, query)}
          keyExtractor={(model) => model.id}
          keyboardShouldPersistTaps="handled"
          style={{ minHeight: 120, maxHeight: 320 }}
          ListEmptyComponent={<Text style={{ color: theme.colors.foregroundMuted }}>No matching models.</Text>}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => select(item.id)}
              style={{ paddingVertical: 10, borderBottomWidth: 1, borderColor: theme.colors.border }}>
              <Text style={{ color: theme.colors.foreground }}>{item.label}</Text>
              {item.id !== item.label && <Text style={{ color: theme.colors.foregroundMuted }}>{item.id}</Text>}
            </Pressable>
          )}
        />
      </Modal.Content>
    </Modal>
  );
}
