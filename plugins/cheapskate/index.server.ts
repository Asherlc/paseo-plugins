import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { archiveBackend, createProvider, ownerEnvKey } from "./server/provider";
import { defaultModel, listPresets, parseChain, preferences, primarySelection, providerId } from "./shared/settings";
import { prepareDraft } from "./shared/controls";
import { checkChain } from "./shared/chain-check";
import { inspectChain } from "./server/chain-check";
import { readControls } from "./server/controls";
import { createCheckpoint } from "./server/checkpoint";
import { createUsageStore } from "./server/usage";
import { usageSummary } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const usage = createUsageStore();
  let paseo: PluginHandlerContext["paseo"] | undefined;
  const unhookCreate = server.addHook("agent.create.before", async ({ request }, context) => {
    if (request.config.provider === providerId) paseo = context.paseo;
  });
  const unhook = server.addHook("agent.open.before", async ({ request }, context) => {
    if (request.provider !== providerId) return;
    paseo = context.paseo;
    return { ...request, env: { ...request.env, [ownerEnvKey]: request.agentId } };
  });

  async function getPresets() {
    const state = await settings.read();
    if (state.status === "invalid") throw new Error(state.error);
    return listPresets(state.values);
  }

  server.registerProvider(createProvider({ getPresets, getPaseo: () => paseo, usage }));
  const unsubscribe = settings.subscribe(async () => {
    await paseo?.providers.refresh({ providers: [providerId] }).catch(() => {});
  });
  server.handle(checkChain, ({ chain }, context) => inspectChain(context.paseo, parseChain(chain)));
  server.handle(usageSummary, () => usage.summary());
  server.handle(prepareDraft, async ({ model = defaultModel.id }, context) => {
    paseo = context.paseo;
    const preset = (await getPresets()).find(({ id }) => id === model);
    const primary = preset ? primarySelection(preset) : undefined;
    await paseo.providers.refresh({ providers: [providerId] });
    if (!primary) return { controls: [], options: {}, modes: [] };
    const native = await readControls(paseo, primary);
    return {
      controls: native.controls.map((control) => control.type === "select"
        ? { ...control, choices: [...control.choices] } : control),
      options: native.options,
      modes: native.modes.map(({ id, label, description }) => ({ id, label, description })),
    };
  });

  const unhookArchive = server.addHook("agent.archive.after", async ({ agent }, context) => {
    if (agent.provider !== providerId) return;
    const checkpoint = createCheckpoint(agent.id);
    const state = await checkpoint.read();
    if (!state.worker) return;
    await archiveBackend(context.paseo, state.worker.id);
    await checkpoint.write({ ...state, worker: undefined });
  });
  return () => {
    unhookCreate();
    unhook();
    unhookArchive();
    unsubscribe();
    usage.close();
  };
}
