import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigChanges,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderModel,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { billingDecision, defaultModel, parseChain, primarySelection, providerId, type Preset } from "../shared/settings.ts";
import { activeRoute, activeRouteKey, handledPrimaryKey, primaryRequestKey, quotaResetsKey, type RouteChange } from "../shared/route-status.ts";
import { receiptKind, receiptSchema, type Receipt, type RouteStep } from "../shared/receipt.ts";
import { parseMessage, runBackend, type PaseoApi } from "./backend.ts";
import { createCheckpoint, type Checkpoint } from "./checkpoint.ts";
import { closestThinking, readControls, routePermissions, type BackendControls, type Options } from "./controls.ts";
import { canFallback, handoffPrompt, providerResetAt, startingBackend } from "./routing.ts";

export const ownerEnvKey = "CHEAPSKATE_OWNER_AGENT_ID";
const baseModel = { id: defaultModel.id, label: defaultModel.name, isDefault: true };

function nativeModel(model: ProviderModel, backend?: BackendControls): ProviderModel {
  if (!backend) return model;
  return {
    ...model, thinkingOptions: [...backend.thinking], defaultThinkingOptionId: backend.defaultThinking,
  };
}

function presetModel({ id, name }: Pick<Preset, "id" | "name">): ProviderModel {
  return id === defaultModel.id ? baseModel : { id, label: name };
}

async function catalog(presets: Preset[], paseo?: PaseoApi, cwd?: string): Promise<ProviderCatalog> {
  const primaries = new Map<string, Promise<BackendControls | undefined>>();
  const backends = await Promise.all(presets.map(async (preset) => {
    const primary = primarySelection(preset);
    if (!paseo || !primary) return undefined;
    let backend = primaries.get(primary);
    if (!backend) {
      backend = readControls(paseo, primary, cwd).catch(() => undefined);
      primaries.set(primary, backend);
    }
    return backend;
  }));
  const primary = backends[0];
  const modes = new Map(primary?.modes.map((mode) => [mode.id, mode]));
  for (const backend of backends.slice(1)) {
    for (const mode of backend?.modes ?? []) if (!modes.has(mode.id)) modes.set(mode.id, mode);
  }
  return {
    models: presets.length ? presets.map((preset, index) => nativeModel(presetModel(preset), backends[index])) : [baseModel],
    modes: [...modes.values()], thinkingOptions: primary?.thinking,
    defaultModel: defaultModel.id,
    defaultMode: primary?.defaultMode,
    defaultThinkingOption: primary?.defaultThinking,
  };
}

type Selection = { mode?: string; thinking?: string; options: Options };

const supported = ["prompt.message", "prompt.image", "permission", "permission.tool_policy", "session.configure", "session.persistence"];
const historyLimit = 300;

type Dependencies = {
  getPresets(): Promise<Preset[]>;
  getPaseo(): PaseoApi | undefined;
};

async function profileConfig(config: ProviderSessionConfig, dependencies: Dependencies) {
  const model = config.model ?? defaultModel.id;
  const presets = await dependencies.getPresets();
  const preset = presets.find(({ id }) => id === model);
  const selection = preset && primarySelection(preset);
  const paseo = dependencies.getPaseo();
  const options = { ...config.providerOptions } as Options;
  const backend = paseo && selection
    ? await readControls(paseo, selection, config.cwd, options).catch(() => undefined)
    : undefined;
  return {
    model,
    models: presets.map(presetModel),
    mode: config.mode ?? backend?.defaultMode,
    thinkingOption: config.thinkingOption ?? backend?.defaultThinking,
    modes: backend?.modes ?? [],
    thinkingOptions: backend?.thinking ?? [],
    // Paseo can ask for profile controls before any hook or RPC has supplied the SDK.
    controls: backend?.controls ?? (selection?.startsWith("opencode/")
      ? [{ type: "toggle" as const, key: "auto_accept", label: "Auto-accept", defaultValue: false }]
      : []),
    providerOptions: { ...backend?.options, ...options },
  };
}

function toError(error: unknown): ProviderError {
  return { message: error instanceof Error ? error.message : String(error) };
}

export function createProvider(dependencies: Dependencies): ProviderRegistration {
  return {
    id: providerId,
    label: "Cheapskate",
    icon: "icon.svg",
    description: "Follow an ordered chain of models using your existing Paseo providers.",
    async getCatalogCacheKey(options) {
      const presets = await dependencies.getPresets().catch(() => []);
      return JSON.stringify({
        presets: presets.map((preset) => [preset.id, preset.name, primarySelection(preset)]),
        ready: Boolean(dependencies.getPaseo()),
        cwd: options.scope === "workspace" ? options.cwd : undefined,
      });
    },
    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) throw new Error("Unsupported Paseo provider protocol.");
      const capabilities = negotiateProviderCapabilities(request.capabilities, supported);
      const sessions = new Map<string, Session>();
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => listeners.forEach((listener) => listener(event));

      return {
        version: PROVIDER_PROTOCOL_VERSION,
        capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          await Promise.all([...sessions.values()].map((session) => session.interrupt()));
          sessions.clear();
          listeners.clear();
        },
        async send(input) {
          try {
            switch (input.type) {
              case "catalog": {
                const paseo = dependencies.getPaseo();
                const presets = await dependencies.getPresets().catch(() => []);
                emit({ type: "catalog", requestId: input.requestId, catalog: await catalog(presets, paseo, input.cwd) });
                return;
              }
              case "session.open": {
                const owner = input.config.env[ownerEnvKey];
                if (!owner && (input.persistence || input.history !== "skip")) {
                  throw new Error("Paseo did not supply the owner of this Cheapskate session.");
                }
                if (input.persistence && (input.persistence.version !== 1 || input.persistence.data !== owner)) {
                  throw new Error("Cheapskate session history belongs to another agent.");
                }
                const session = owner ? new Session(input.sessionId, owner, input.config, dependencies, emit) : undefined;
                const preview = session ? undefined : await profileConfig(input.config, dependencies);
                if (session) {
                  await session.restore();
                  sessions.set(input.sessionId, session);
                }
                emit({
                  type: "session.opened", requestId: input.requestId, sessionId: input.sessionId,
                  capabilities, cwd: input.config.cwd, restoration: "core",
                  persistence: owner && input.config.persist ? { version: 1, data: owner } : undefined,
                });
                if (preview) emit({ type: "session.config", sessionId: input.sessionId, config: preview });
                session?.publishConfig();
                if (input.history === "replay") session?.replay();
                emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
                return;
              }
              case "session.prompt":
                getSession(input).prompt(input.prompt);
                return;
              case "session.permission":
                await getSession(input).permission(input);
                return;
              case "session.configure":
                await getSession(input).configure(input.changes);
                break;
              case "session.interrupt":
                await getSession(input).interrupt();
                break;
              case "session.close":
                await sessions.get(input.sessionId)?.interrupt();
                sessions.delete(input.sessionId);
                emit({ type: "session.closed", sessionId: input.sessionId });
                break;
              default:
                throw new Error("Cheapskate does not support this provider operation.");
            }
            emit({ type: "request.completed", requestId: input.requestId });
          } catch (error) {
            if (input.type === "session.prompt") {
              emit({
                type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: toError(error) },
              });
            } else if (input.type === "session.permission") {
              emit({
                type: "session.notice", sessionId: input.sessionId,
                notice: { id: "permission-error", severity: "error", title: toError(error).message },
              });
            } else {
              emit({ type: "request.failed", requestId: input.requestId, error: toError(error) });
            }
          }
        },
      };

      function getSession({ sessionId }: { sessionId: string }) {
        const session = sessions.get(sessionId);
        if (!session) throw new Error("Cheapskate session is closed.");
        return session;
      }
    },
  };
}

type Turn = {
  id: string;
  stop: AbortController;
  done: Promise<void>;
  attemptId?: string;
  billing?: { id: string; resolve(allowed: boolean): void };
  receipt: Omit<Receipt, "state">;
  previousLimits?: unknown;
  chain?: string[];
};

function step(turn: Turn, label: string, result: RouteStep["result"], resetAt?: number) {
  if (turn.receipt.steps.length >= 40) {
    turn.receipt.omitted++;
  } else {
    turn.receipt.steps.push({ label: label.slice(0, 240), result, resetAt });
  }
}

class Session {
  private id: string;
  private owner: string;
  private config: ProviderSessionConfig;
  private dependencies: Dependencies;
  private emit: (event: ProviderEvent) => void;
  private checkpoint;
  private state: Checkpoint = { items: [] };
  private turn?: Turn;
  private backend?: BackendControls;
  private selected: Selection;
  private modelId: string;
  private models: ProviderModel[] = [baseModel];
  private configuring = false;

  constructor(
    id: string,
    owner: string,
    config: ProviderSessionConfig,
    dependencies: Dependencies,
    emit: (event: ProviderEvent) => void,
  ) {
    this.id = id;
    this.owner = owner;
    this.config = config;
    this.dependencies = dependencies;
    this.emit = emit;
    this.checkpoint = createCheckpoint(owner);
    this.modelId = config.model ?? defaultModel.id;
    this.selected = {
      mode: config.mode,
      thinking: config.thinkingOption,
      options: { ...config.providerOptions } as Options,
    };
  }

  async restore() {
    this.state = await this.checkpoint.read();
    const paseo = this.dependencies.getPaseo();
    const presets = await this.dependencies.getPresets().catch(() => []);
    this.models = presets.length ? presets.map(presetModel) : [baseModel];
    const preset = presets.find(({ id }) => id === this.modelId);
    const selection = this.state.lastSelection ?? this.state.worker?.selection ?? (preset && primarySelection(preset));
    if (paseo && selection) {
      this.backend = await readControls(paseo, selection, this.config.cwd, this.selected.options).catch(() => undefined);
      if (this.backend) {
        const { modes, thinking } = this.backend;
        if (this.selected.mode === "default" && !modes.some(({ id }) => id === "default")) this.selected.mode = undefined;
        if (this.selected.thinking === "auto" && !thinking.some(({ id }) => id === "auto")) this.selected.thinking = undefined;
      }
    }
  }

  publishConfig() {
    const models = this.models.some(({ id }) => id === this.modelId)
      ? this.models : [...this.models, { id: this.modelId, label: this.modelId }];
    this.emit({
      type: "session.config", sessionId: this.id,
      config: {
        model: this.modelId,
        models: models.map((model) => model.id === this.modelId ? nativeModel(model, this.backend) : model),
        modes: this.backend?.modes ?? [], thinkingOptions: this.backend?.thinking ?? [],
        mode: this.selected.mode ?? this.backend?.defaultMode,
        thinkingOption: this.selected.thinking ?? this.backend?.defaultThinking,
        controls: this.backend?.controls ?? [],
        providerOptions: { ...this.backend?.options, ...this.selected.options },
      },
    });
  }

  async configure(changes: ProviderConfigChanges) {
    if (this.turn || this.configuring) throw new Error("Wait for the active Cheapskate operation to finish.");
    const paseo = this.requirePaseo();
    const backend = this.backend;
    if (!backend) throw new Error("Configure an available backend first.");
    this.configuring = true;
    try {
      const modelId = changes.model ?? this.modelId;
      if (modelId !== this.modelId) {
        const presets = await this.dependencies.getPresets();
        if (!presets.some(({ id, chain }) => id === modelId && parseChain(chain).length)) {
          throw new Error("Choose a Cheapskate chain with at least one backend.");
        }
        this.models = presets.map(presetModel);
      }
      const mode = changes.mode === undefined ? this.selected.mode : changes.mode ?? backend.defaultMode;
      const thinking = changes.thinkingOption === undefined
        ? this.selected.thinking
        : changes.thinkingOption ?? backend.defaultThinking;
      if (changes.mode && !backend.modes.some(({ id }) => id === mode)) {
        throw new Error(`The current backend does not offer permission mode ${mode}.`);
      }
      if (changes.thinkingOption && !backend.thinking.some(({ id }) => id === thinking)) {
        throw new Error(`The current backend does not offer thinking level ${thinking}.`);
      }
      const options = { ...this.selected.options };
      for (const [key, value] of Object.entries(changes.providerOptions ?? changes.settings ?? {})) {
        if (value === null) delete options[key];
        else options[key] = value;
      }
      const next = await readControls(paseo, backend.selection, this.config.cwd, options);
      this.modelId = modelId;
      this.selected = { mode, thinking, options };
      this.backend = next;
      this.publishConfig();
    } finally {
      this.configuring = false;
    }
  }

  private requirePaseo() {
    const paseo = this.dependencies.getPaseo();
    if (!paseo) throw new Error("Cheapskate could not connect to its Paseo host.");
    return paseo;
  }

  replay() {
    for (const item of this.state.items) this.emit({ type: "timeline.item", sessionId: this.id, item });
  }

  private async save() {
    await this.checkpoint.write(this.state);
  }

  private record(item: ProviderTimelineItem) {
    const index = this.state.items.findIndex((previous) => previous.id === item.id);
    if (index < 0) this.state.items.push(item);
    else this.state.items[index] = item;
    if (this.state.items.length > historyLimit) this.state.items.shift();
    this.emit({ type: "timeline.item", sessionId: this.id, item });
  }

  prompt(prompt: ProviderPrompt) {
    if (this.turn || this.configuring) throw new Error("Cheapskate is still handling the previous operation.");
    if (prompt.input.type !== "message" || prompt.delivery === "steer") {
      throw new Error("Cheapskate supports regular messages.");
    }
    const message = parseMessage(prompt.input.content);
    const turnId = randomUUID();
    const stop = new AbortController();
    this.record({ type: "user_message", id: `user:${turnId}`, text: message.text, clientMessageId: prompt.clientMessageId });
    this.emit({
      type: "session.prompt_result", sessionId: this.id, clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({ type: "session.turn", sessionId: this.id, turnId, state: "started" });

    const turn: Turn = {
      id: turnId, stop, done: Promise.resolve(),
      receipt: { chain: this.models.find(({ id }) => id === this.modelId)?.label ?? this.modelId, steps: [], omitted: 0 },
    };
    this.turn = turn;
    turn.done = this.run(turn, message).then(
      (state) => this.finish(turn, state),
      (error) => this.finish(turn, "failed", toError(error)),
    );
  }

  private async finish(turn: Turn, state: "completed" | "canceled" | "failed", error?: ProviderError) {
    if (error) this.record({ type: "error", id: `error:${turn.id}`, message: error.message });
    try {
      await this.save();
    } catch (saveError) {
      state = "failed";
      error = toError(saveError);
      this.record({ type: "error", id: `checkpoint:${turn.id}`, message: error.message });
    } finally {
      await this.publishReceipt(turn, state).catch(() => {});
      this.turn = undefined;
      this.emit({ type: "session.turn", sessionId: this.id, turnId: turn.id, state, error });
    }
  }

  async interrupt() {
    this.turn?.stop.abort();
    await this.turn?.done;
  }

  async permission(input: Extract<ProviderInput, { type: "session.permission" }>) {
    const turn = this.turn;
    if (turn?.billing?.id === input.permissionId) {
      turn.billing.resolve(input.response.behavior === "allow" && input.response.selectedActionId === "run-once");
      return;
    }
    const worker = this.state.worker;
    const prefix = `${turn?.id}:${turn?.attemptId}:`;
    if (!turn?.attemptId || turn.stop.signal.aborted || !worker || !input.permissionId.startsWith(prefix)) return;
    const agent = this.requirePaseo().agents.ref(worker.id);
    await agent.respondToPermission({ requestId: input.permissionId.slice(prefix.length), response: input.response });
  }

  private async requestBilling(turn: Turn, label: string, knownPaid: boolean) {
    const { signal } = turn.stop;
    if (signal.aborted) return false;
    const id = `${turn.id}:billing:${randomUUID()}`;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const abort = () => resolve(false);
    turn.billing = { id, resolve };
    signal.addEventListener("abort", abort, { once: true });
    try {
      this.emit({ type: "session.permission", sessionId: this.id, request: {
        id, kind: "other", name: "cheapskate.billing", title: `Use ${label} for this message?`,
        description: knownPaid ? "This backend is marked paid. Approve it for this message only."
          : "Billing is unclassified. This backend may incur charges. Approve it for this message only.",
        actions: [
          { id: "run-once", label: "Use once", behavior: "allow", variant: "primary" },
          { id: "skip", label: "Skip backend", behavior: "deny", variant: "secondary" },
        ],
      } });
      return await promise;
    } finally {
      signal.removeEventListener("abort", abort);
      turn.billing = undefined;
      this.emit({ type: "session.permission_resolved", sessionId: this.id, permissionId: id });
    }
  }

  private async publishReceipt(turn: Turn, state: Receipt["state"]) {
    const owner = this.dependencies.getPaseo()?.agents.ref(this.owner);
    if (!owner) return;
    const resets = (turn.chain ?? []).flatMap((selection) => {
      const reset = this.state.limits?.[selection];
      return reset ? [[selection, reset] as const] : [];
    });
    const limits = Object.fromEntries(resets.slice(0, 40));
    if (turn.previousLimits !== undefined && (Object.keys(limits).length || turn.previousLimits)
      && !isDeepStrictEqual(limits, turn.previousLimits)) {
      await owner.setMetadata({ [quotaResetsKey]: limits }).catch(() => {});
    }
    const receipt = receiptSchema.safeParse({ ...turn.receipt, state });
    if (!receipt.success) return;
    // The host stamps the installed plugin ID and keeps the row in canonical history.
    const data = JSON.parse(JSON.stringify(receipt.data));
    await owner.timeline.append({ type: "plugin", id: turn.id, kind: receiptKind, version: 1, data }).catch(() => {});
  }

  private async archiveWorker(paseo: PaseoApi) {
    if (!this.state.worker) return;
    await archiveBackend(paseo, this.state.worker.id);
    this.state.worker = undefined;
    await this.save();
  }

  private async run(turn: Turn, message: ReturnType<typeof parseMessage>): Promise<"completed" | "canceled"> {
    const signal = turn.stop.signal;
    const presets = await this.dependencies.getPresets();
    const preset = presets.find(({ id }) => id === this.modelId);
    if (!preset) throw new Error("This Cheapskate chain was removed. Choose an available chain in the model picker.");
    this.models = presets.map(presetModel);
    const chain = parseChain(preset.chain);
    turn.chain = chain;
    const { overload } = preset;
    turn.receipt.chain = preset.name;
    if (signal.aborted) return "canceled";
    if (!chain.length) throw new Error("Add a fallback chain in Settings → Plugins → Cheapskate.");
    const eligible = chain.filter((selection) => billingDecision(preset.billing, preset.costs[selection]) !== "skip");
    const primary = eligible[0];
    if (!primary) {
      for (const selection of chain) step(turn, selection, "billing");
      throw new Error("This chain has no backends marked free. Update its billing settings to continue.");
    }

    const paseo = this.requirePaseo();
    const ownerAgent = paseo.agents.ref(this.owner);
    const owner = await ownerAgent.refresh();
    if (!owner?.agent.workspaceId) throw new Error("Cheapskate needs an active Paseo workspace.");
    const workspace = paseo.workspaces.ref(owner.agent.workspaceId);
    const oldWorker = this.state.worker;
    const metadata = owner.agent.metadata ?? {};
    turn.previousLimits = metadata[quotaResetsKey] ?? null;
    const limits = this.state.limits ??= {};
    const configured = new Set(presets.flatMap(({ chain }) => parseChain(chain)));
    for (const selection of Object.keys(limits)) {
      if (!configured.has(selection) && limits[selection].resetAt <= Date.now()) delete limits[selection];
    }
    let publishedRoute = activeRoute.safeParse(metadata[activeRouteKey]).data;
    const primaryRequest = metadata[primaryRequestKey];
    const tryPrimary = typeof primaryRequest === "number" && primaryRequest !== metadata[handledPrimaryKey];
    const changedChain = (this.state.presetId ?? defaultModel.id) !== preset.id;
    const active = oldWorker?.selection;
    const canStay = !changedChain && active && billingDecision(preset.billing, preset.costs[active]) !== "skip";
    const initialSelection = startingBackend(eligible, canStay ? active : undefined, limits, preset.autoReturn, tryPrimary, Date.now());
    const first = chain.indexOf(initialSelection);
    const sourceSelection = this.state.lastSelection ?? oldWorker?.selection ?? primary;
    let source = this.backend;
    if (!source) {
      const { cwd } = this.config;
      const readSource = () => readControls(paseo, sourceSelection, cwd, this.selected.options);
      try {
        source = await readSource();
      } catch (error) {
        if (signal.aborted) return "canceled";
        if (!(error instanceof Error) || !/^OpenCode location .+ did not activate within \d+ms$/.test(error.message)) {
          throw error;
        }
        // Paseo can retain a failed cold-start snapshot after the location can be opened.
        try {
          await paseo.providers.refresh({ cwd, providers: [sourceSelection.split("/", 1)[0]] });
        } catch {
          if (signal.aborted) return "canceled";
          throw error;
        }
        if (signal.aborted) return "canceled";
        try {
          source = await readSource();
        } catch (retryError) {
          if (signal.aborted) return "canceled";
          throw retryError;
        }
      }
    }
    const intent = {
      mode: this.selected.mode ?? source.defaultMode,
      thinking: this.selected.thinking ?? source.defaultThinking,
      options: { ...source.options, ...this.selected.options },
    };
    if (signal.aborted) return "canceled";
    if (intent.mode && source.modes.length && !source.modes.some(({ id }) => id === intent.mode)) {
      throw new Error(`Choose a permission mode offered by ${source.label}.`);
    }
    if (tryPrimary) await ownerAgent.setMetadata({ [handledPrimaryKey]: primaryRequest }).catch(() => {});
    let change: RouteChange | undefined;
    if (oldWorker && initialSelection !== oldWorker.selection) {
      const reason = tryPrimary ? "requested" : changedChain ? "chain" : !chain.includes(oldWorker.selection) ? "removed"
        : canStay ? "recovered" : "billing";
      change = { reason, from: this.backend?.label ?? oldWorker.selection };
    }
    if (oldWorker?.inFlight) await this.archiveWorker(paseo);

    let exhaustion: string | undefined;
    for (const [index, selection] of chain.entries()) {
      if (signal.aborted) return "canceled";
      const cost = preset.costs[selection];
      const decision = billingDecision(preset.billing, cost);
      if (decision === "skip") {
        step(turn, selection, "billing");
        change ??= { reason: "billing", from: selection };
        continue;
      }
      const limit = limits[selection];
      if (limit && limit.resetAt > Date.now()) {
        step(turn, limit.label, "cooldown", limit.resetAt);
        continue;
      }
      if (index < first) {
        step(turn, selection, "sticky");
        continue;
      }

      let backend: BackendControls;
      try {
        backend = selection === source.selection ? source : await readControls(paseo, selection, this.config.cwd);
      } catch (error) {
        step(turn, selection, "unavailable");
        if (!change || change.reason === "requested" || change.reason === "removed") {
          change = { reason: "unavailable", from: selection };
        }
        this.record({
          type: "notification", id: `backend-skip:${turn.id}:${index}`, level: "warning",
          message: `Skipped ${selection} because Paseo could not read its controls: ${toError(error).message}`,
        });
        continue;
      }
      const permissions = selection === source.selection
        ? { mode: intent.mode, options: intent.options }
        : routePermissions(intent.mode, source, backend, intent.options);
      if (!permissions) {
        step(turn, backend.label, "permissions");
        if (!change || change.reason === "requested" || change.reason === "removed") {
          change = { reason: "permissions", from: backend.label };
        }
        this.record({
          type: "notification", id: `permission-skip:${turn.id}:${index}`, level: "warning",
          message: `Skipped ${selection} because it cannot preserve this permission mode or policy.`,
        });
        continue;
      }
      if (decision === "ask" && !await this.requestBilling(turn, backend.label, cost === "paid")) {
        step(turn, backend.label, signal.aborted ? "canceled" : "declined");
        change ??= { reason: "billing", from: backend.label };
        continue;
      }
      const { mode, options } = permissions;
      const thinking = closestThinking(intent.thinking, backend.thinking) ?? backend.defaultThinking;
      const requested: Selection = {
        ...(mode ? { mode } : {}),
        ...(thinking ? { thinking } : {}),
        options,
      };
      if (this.state.worker && (this.state.worker.selection !== selection
        || !isDeepStrictEqual(this.state.worker.config, requested))) {
        await this.archiveWorker(paseo);
      }
      if (signal.aborted) return "canceled";
      const existing = this.state.worker;
      const worker = existing ?? { id: randomUUID(), selection, inFlight: false, config: requested };
      const attemptId = randomUUID();
      turn.attemptId = attemptId;
      this.state.worker = worker;
      this.state.presetId = preset.id;
      delete limits[selection];
      worker.inFlight = true;
      await this.save();
      if (signal.aborted) {
        worker.inFlight = false;
        this.state.worker = existing;
        return "canceled";
      }

      let failure: ProviderError;
      try {
        // The daemon and its plugins supply the new backend's own identity and thread storage.
        const {
          [ownerEnvKey]: _owner,
          PASEO_AGENT_ID: _agent,
          PASEO_AGENT_CWD: _cwd,
          PASEO_WORKSPACE_ID: _workspace,
          PASEO_THREAD_STORAGE: _thread,
          BB_THREAD_STORAGE: _genuiThread,
          ...env
        } = this.config.env;
        const { paseo: _orchestration, ...mcpServers } = this.config.mcpServers;
        const agent = existing ? paseo.agents.ref(worker.id) : await workspace.agents.create({
          agentId: worker.id,
          title: `Cheapskate · ${selection}`,
          background: true,
          env,
          labels: { "cheapskate.owner": this.owner },
          config: {
            provider: selection,
            modeId: mode,
            thinkingOptionId: thinking,
            options,
            systemPrompt: this.config.systemPrompt,
            mcpServers,
            toolPolicy: this.config.toolPolicy,
          },
        });
        if (agent.id !== worker.id) throw new Error("Paseo did not honor the requested backend agent ID.");

        const actualMode = agent.runtimeInfo?.modeId ?? undefined;
        if (mode && actualMode && mode !== actualMode) {
          throw new Error(`The backend opened in mode ${actualMode} instead of ${mode}.`);
        }
        if (!mode && actualMode) {
          requested.mode = actualMode;
          if (selection === source.selection) intent.mode = actualMode;
        }
        this.backend = { ...backend, controls: agent.controls ?? backend.controls };
        this.state.lastSelection = selection;
        this.selected = requested;
        this.publishConfig();
        const routeChange = change ?? (publishedRoute?.selection === selection ? publishedRoute.change : undefined);
        const currentRoute = { selection, label: backend.label, ...(routeChange && { change: routeChange }) };
        if (!isDeepStrictEqual(currentRoute, publishedRoute)) {
          await ownerAgent.setMetadata({ [activeRouteKey]: currentRoute })
            .then(() => { publishedRoute = currentRoute; })
            .catch(() => {});
        }
        if (!existing) {
          const settings = [mode && `mode ${mode}`, thinking && `thinking ${thinking}`].filter(Boolean).join(", ");
          this.record({
            type: "notification", id: `route:${turn.id}:${attemptId}`, level: "info",
            message: `Cheapskate is using ${backend.label}${settings ? ` (${settings})` : ""}.`,
          });
        }
        const prompt = existing ? message : {
          ...message,
          text: handoffPrompt(this.state.items.filter((item) => item.id !== `user:${turn.id}`), message.text),
        };
        const outcome = await runBackend({
          agent, sessionId: this.id, turnId: turn.id, attemptId, message: prompt, signal,
          emit: (event) => event.type === "timeline.item" ? this.record(event.item) : this.emit(event),
        });
        if (outcome.state === "completed" && !signal.aborted) {
          const updated = await agent.refresh().catch(() => null);
          if (updated) {
            const liveMode = agent.runtimeInfo?.modeId;
            const liveThinking = agent.runtimeInfo?.thinkingOptionId;
            if (liveMode) requested.mode = liveMode;
            if (liveThinking) requested.thinking = liveThinking;
            requested.options = { ...requested.options, ...agent.options as Options };
            this.backend = { ...backend, controls: agent.controls ?? backend.controls };
            this.selected = requested;
            this.publishConfig();
          }
          if (!signal.aborted) {
            worker.inFlight = false;
            const latestUsage = updated ? agent.lastUsage ?? undefined : undefined;
            // Paseo keeps the last snapshot even when the provider is silent on a later turn.
            // Only attribute snapshot usage when a fresh worker or a changed snapshot identifies it.
            const snapshotUsage = !existing || (worker.lastUsage !== undefined && !isDeepStrictEqual(worker.lastUsage, latestUsage ?? null))
              ? latestUsage : undefined;
            if (updated) worker.lastUsage = latestUsage ?? null;
            if (!outcome.usage && snapshotUsage) {
              this.emit({ type: "session.usage", sessionId: this.id, turnId: turn.id, usage: snapshotUsage });
            }
            step(turn, backend.label, "answered");
            turn.receipt.answer = backend.label.slice(0, 240);
            turn.receipt.usage = outcome.usage ?? snapshotUsage;
            return "completed";
          }
        }
        failure = outcome.state === "failed" ? outcome.error : { message: "Backend canceled the turn.", code: "canceled" };
      } catch (error) {
        failure = toError(error);
      }

      await this.archiveWorker(paseo);
      if (signal.aborted || failure.code === "canceled") {
        step(turn, backend.label, "canceled");
        return "canceled";
      }
      if (/failed to compile structural_tag grammar:[^\r\n]*initial lexer configuration \(grammar\) too big/i.test(failure.message)) {
        const summary = `${backend.label} exceeded its tool-call grammar limit.`;
        step(turn, backend.label, "tool-grammar");
        change = { reason: "tool-grammar", from: backend.label };
        exhaustion = `No compatible backend remains. ${summary}`;
        if (index + 1 < chain.length) {
          this.record({
            type: "notification", id: `fallback:${turn.id}:${attemptId}`, level: "warning",
            message: `${summary} Looking for the next compatible backend.`,
          });
        }
        continue;
      }
      if (!canFallback(failure, overload)) {
        step(turn, backend.label, "failed");
        throw new Error(`${selection}: ${failure.message}`);
      }
      const resetAt = providerResetAt(failure, Date.now());
      if (resetAt !== undefined) limits[selection] = { resetAt, label: backend.label.slice(0, 240) };
      step(turn, backend.label, "limit", resetAt);
      change = { reason: "limit", from: backend.label };
      exhaustion = `No compatible backend remains after the provider limit: ${failure.message}`;
      if (index + 1 < chain.length) {
        this.record({
          type: "notification", id: `fallback:${turn.id}:${attemptId}`, level: "warning",
          message: `${backend.label} hit a provider limit. Looking for the next compatible backend.`,
        });
      }
    }
    if (signal.aborted) return "canceled";
    throw new Error(exhaustion ?? "No configured backend can run this message. Open the routing receipt for details.");
  }
}

export async function archiveBackend(paseo: PaseoApi, id: string) {
  const agent = paseo.agents.ref(id);
  const existing = await agent.refresh();
  if (existing && !agent.archivedAt) await agent.archive();
}
