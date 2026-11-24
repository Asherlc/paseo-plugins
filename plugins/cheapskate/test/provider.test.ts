import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDER_PROTOCOL_VERSION, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { PaseoApi } from "../server/backend.ts";
import { createProvider, ownerEnvKey } from "../server/provider.ts";
import { createUsageStore } from "../server/usage.ts";
import type { Receipt } from "../shared/receipt.ts";
import { chainSettings } from "../shared/settings.ts";

test("a profile lookup can discover OpenCode Auto-accept before an agent exists", async () => {
  const provider = createProvider({
    getPaseo: () => undefined,
    getPresets: async () => [{
      id: "cheapskate",
      name: "Cheapskate",
      chain: "opencode/opencode/hy4-flash-free",
      billing: "free-only",
      costs: { "opencode/opencode/hy4-flash-free": "free" },
      overload: false,
      autoReturn: false,
    }],
  });
  const connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  try {
    await connection.send({
      type: "session.open",
      requestId: "open",
      sessionId: "profile-lookup",
      history: "skip",
      config: {
        cwd: process.cwd(), env: {}, mcpServers: {}, model: "cheapskate", mode: "build",
        persist: true, settings: {}, providerOptions: { auto_accept: true },
      },
    });

    const opened = events.find((event) => event.type === "session.opened");
    assert.ok(opened, JSON.stringify(events));
    assert.equal(opened.persistence, undefined);
    const config = events.find((event) => event.type === "session.config")?.config;
    assert.ok(config?.controls?.some((control) => control.type === "toggle" && control.key === "auto_accept"));
    assert.equal(config?.providerOptions?.auto_accept, true);

    await connection.send({ type: "session.close", requestId: "close", sessionId: "profile-lookup" });
    assert.ok(events.some((event) => event.type === "session.closed"));
  } finally {
    await connection.close();
  }
});

test("an explicit mode mapping is used on an actual fallback turn", { timeout: 5000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cheapskate-mapping-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const sourceSelection = "custom.provider/source-model";
  const destSelection = "other_provider/dest-model";
  const models: Record<string, { id: string; label: string; modes: string[] }> = {
    "custom.provider": { id: "source-model", label: "Source", modes: ["x"] },
    other_provider: { id: "dest-model", label: "Dest", modes: ["y"] },
  };
  const owner = {
    agent: { workspaceId: "workspace", metadata: {} },
    refresh: async () => owner,
    setMetadata: async () => {},
    timeline: { append: async () => {} },
  };
  const launches: { provider: string; modeId: string; options: unknown; toolPolicy: unknown }[] = [];
  const toolPolicy = { preapproved: [{ kind: "mcp" as const, server: "test", tool: "read" }] };
  type BackendEvent = { event: { type: "turn_started" | "turn_completed" | "turn_failed"; turnId: string; error?: string } };
  const paseo = {
    agents: { ref: (id: string) => id === "owner-mapping" ? owner : { refresh: async () => null } },
    config: { get: async () => ({ config: {} }) },
    providers: {
      listModels: async (provider: string) => ({
        models: [{ id: models[provider].id, label: models[provider].label }],
      }),
      listModes: async (provider: string) => ({ modes: models[provider].modes.map((id) => ({ id, label: id })) }),
      listControls: async ({ provider }: { provider: string }) => ({ options: provider === destSelection ? { permission: "ask" } : {} }),
      snapshot: async () => ({ entries: [] }),
    },
    workspaces: { ref: () => ({
      agents: { create: async ({ agentId, config }: { agentId: string; config: {
        provider: string; modeId: string; options: unknown; toolPolicy: unknown;
      } }) => {
        launches.push({ provider: config.provider, modeId: config.modeId, options: config.options, toolPolicy: config.toolPolicy });
        let listener: (value: BackendEvent) => void;
        return {
          id: agentId,
          refresh: async () => null,
          timeline: { subscribe: (callback: typeof listener) => {
            listener = callback;
            return Object.assign(() => {}, { ready: Promise.resolve() });
          } },
          send: async () => {
            listener({ event: { type: "turn_started", turnId: agentId } });
            const failed: BackendEvent["event"] = { type: "turn_failed", turnId: agentId, error: "Rate limit exceeded" };
            const completed: BackendEvent["event"] = { type: "turn_completed", turnId: agentId };
            listener({ event: config.provider === sourceSelection ? failed : completed });
          },
        };
      } },
    }) },
  } as unknown as PaseoApi;
  const provider = createProvider({
    getPaseo: () => paseo,
    getPresets: async () => [{
      id: "cheapskate", name: "Cheapskate",
      ...chainSettings.parse({
        chain: `${sourceSelection}\n${destSelection}`,
        mappings: [{ source: sourceSelection, sourceMode: "x", destination: destSelection, destinationMode: "y" }],
      }),
    }],
  });
  const connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [] });
  const finished = Promise.withResolvers<Extract<ProviderEvent, { type: "session.turn" }>>();
  connection.onEvent((event) => {
    if (event.type === "session.turn" && event.state !== "started") finished.resolve(event);
  });
  try {
    await connection.send({
      type: "session.open", requestId: "open", sessionId: "session", history: "skip",
      config: {
        cwd: home, env: { [ownerEnvKey]: "owner-mapping" }, mcpServers: {}, model: "cheapskate",
        mode: "x", persist: true, settings: {}, providerOptions: {}, toolPolicy,
      },
    });
    await connection.send({
      type: "session.prompt", sessionId: "session",
      prompt: {
        clientMessageId: "message", delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Hello" }] },
      },
    });
    assert.equal((await finished.promise).state, "completed");
    assert.deepEqual(launches, [
      { provider: sourceSelection, modeId: "x", options: {}, toolPolicy },
      { provider: destSelection, modeId: "y", options: { permission: "ask" }, toolPolicy },
    ], "the fallback uses the saved explicit mode, its own provider defaults, and the original tool policy");
  } finally {
    await connection.close();
  }
});

test("a turn recovers from a timed-out workspace OpenCode catalog", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cheapskate-catalog-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const cwd = join(home, "worktree");
  const backend = "opencode/opencode/hy4-flash-free";
  const timeout = `OpenCode location ${cwd} did not activate within 30000ms`;
  const cases = [
    { name: "refreshes the scoped catalog and uses the requested controls", error: timeout, recovers: true, refresh: true, pauseAt: null },
    { name: "stops after one refresh if the timeout persists", error: timeout, recovers: false, refresh: true, pauseAt: null },
    { name: "leaves unrelated errors alone", error: "OpenCode is disabled", recovers: false, refresh: false, pauseAt: null },
    { name: "cancels when the interrupted retry fails", error: timeout, recovers: false, refresh: true, pauseAt: "retry" },
    { name: "cancels before launching an agent if interrupted while saving", error: timeout, recovers: true, refresh: true, pauseAt: "checkpoint" },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, { timeout: 5000 }, async (t) => {
      const refreshes: unknown[] = [];
      const launches: unknown[] = [];
      const paused = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      if (scenario.pauseAt === "checkpoint") {
        const writeFile = fs.writeFile;
        let firstWrite = true;
        t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
          if (firstWrite) {
            firstWrite = false;
            paused.resolve();
            await resume.promise;
          }
          return writeFile(...args);
        });
        syncBuiltinESMExports();
      }
      const refresh = async (options: unknown) => { refreshes.push(options); };
      const owner = {
        agent: { workspaceId: "workspace", metadata: {} },
        refresh: async () => owner,
        setMetadata: async () => {},
        timeline: { append: async () => {} },
      };
      type BackendEvent = { event: { type: "turn_started" | "turn_completed"; turnId: string } };
      const paseo = {
        agents: { ref: (id: string) => id === scenario.name ? owner : { refresh: async () => null } },
        config: { get: async () => ({ config: {} }) },
        providers: {
          listModels: async () => {
            if (refreshes.length && scenario.pauseAt === "retry") {
              paused.resolve();
              await resume.promise;
            }
            return scenario.recovers && refreshes.length
              ? { models: [{ id: "opencode/hy4-flash-free", label: "Hy4 Flash Free" }] }
              : { error: scenario.error };
          },
          listModes: async () => ({ modes: [{ id: "build", label: "Build" }] }),
          listControls: async () => ({ options: { auto_accept: false } }),
          snapshot: async () => ({ entries: [] }),
          refresh,
        },
        workspaces: { ref: () => ({
          agents: { create: async ({ agentId, config }: { agentId: string; config: unknown }) => {
            launches.push(config);
            let listener: (value: BackendEvent) => void;
            return {
              id: agentId,
              refresh: async () => null,
              timeline: { subscribe: (callback: typeof listener) => {
                listener = callback;
                return Object.assign(() => {}, { ready: Promise.resolve() });
              } },
              send: async () => {
                listener({ event: { type: "turn_started", turnId: "backend-turn" } });
                listener({ event: { type: "turn_completed", turnId: "backend-turn" } });
              },
            };
          } },
        }) },
      } as unknown as PaseoApi;
      const provider = createProvider({
        getPaseo: () => paseo,
        getPresets: async () => [{
          id: "cheapskate", name: "Cheapskate", chain: backend, billing: "free-only",
          costs: { [backend]: "free" }, overload: false, autoReturn: false,
        }],
      });
      const connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [] });
      const finished = Promise.withResolvers<Extract<ProviderEvent, { type: "session.turn" }>>();
      connection.onEvent((event) => {
        if (event.type === "session.turn" && event.state !== "started") finished.resolve(event);
      });
      try {
        await connection.send({
          type: "session.open", requestId: "open", sessionId: "session", history: "skip",
          config: {
            cwd, env: { [ownerEnvKey]: scenario.name }, mcpServers: {}, model: "cheapskate",
            mode: "build", persist: true, settings: {}, providerOptions: { auto_accept: true },
          },
        });
        assert.deepEqual(refreshes, []);
        await connection.send({
          type: "session.prompt", sessionId: "session",
          prompt: {
            clientMessageId: "message", delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Hello" }] },
          },
        });
        if (scenario.pauseAt) {
          await paused.promise;
          const interrupted = connection.send({ type: "session.interrupt", requestId: "interrupt", sessionId: "session" });
          resume.resolve();
          await interrupted;
        }
        const outcome = await finished.promise;
        const expected = scenario.pauseAt ? "canceled" : scenario.recovers ? "completed" : "failed";
        assert.equal(outcome.state, expected);
        assert.equal(outcome.error?.message, expected === "failed" ? scenario.error : undefined);
        assert.deepEqual(refreshes, scenario.refresh ? [{ cwd, providers: ["opencode"] }] : []);
        assert.deepEqual(launches.map((launch) => {
          const { provider, modeId, options } = launch as { provider: string; modeId: string; options: unknown };
          return { provider, modeId, options };
        }), expected === "completed" ? [{ provider: backend, modeId: "build", options: { auto_accept: true } }] : []);
      } finally {
        resume.resolve();
        try {
          await connection.close();
        } finally {
          if (scenario.pauseAt === "checkpoint") {
            t.mock.restoreAll();
            syncBuiltinESMExports();
          }
        }
      }
    });
  }
});

test("a provider tool-grammar rejection advances the chain without echoing the dump", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cheapskate-tool-grammar-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  for (const hasFallback of [true, false]) {
    await t.test(hasFallback ? "continues the same turn" : "reports a concise error when exhausted", { timeout: 5000 }, async () => {
      process.env.PASEO_HOME = join(home, String(hasFallback));
      const usageStore = createUsageStore();
      const headline = "Upstream error from Recursive: Failed to compile structural_tag grammar:";
      const dump = '   1 | start: <[150010]> "device-picker_list_devices"';
      const models = [
        { provider: "opencode", id: "opencode/hy4-flash-free", label: "Hy4 Flash Free", failure: { error: "Rate limit exceeded" } },
        { provider: "openrouter", id: "openrouter/free", label: "Free Models Router", failure: hasFallback
          ? { error: `${headline} at 1(99197): initial lexer configuration (grammar) too big (limit for this grammar: 1000000)\n${dump}` }
          : { error: `${headline}\n${dump}`, diagnostic: "initial lexer configuration (grammar)\nis too large" } },
        { provider: "alt", id: "alt/free", label: "Another Free Model" },
      ];
      const chain = (hasFallback ? models : models.slice(0, 2)).map(({ provider, id }) => `${provider}/${id}`);
      const ownerId = `owner-${hasFallback}`;
      const attempts: string[] = [];
      const receipts: Receipt[] = [];
      const changes: unknown[] = [];
      const owner = {
        agent: { workspaceId: "workspace", metadata: {} },
        refresh: async () => owner,
        setMetadata: async (metadata: unknown) => { changes.push(metadata); },
        timeline: { append: async ({ data }: { data: Receipt }) => { receipts.push(data); } },
      };
      type BackendEvent = { event: {
        type: "turn_started" | "turn_completed" | "turn_failed"; turnId: string;
        error?: string; diagnostic?: string;
        usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
      } };
      const paseo = {
        agents: { ref: (id: string) => id === ownerId ? owner : { refresh: async () => null } },
        config: { get: async () => ({ config: { providers: {
          openrouter: { extends: "opencode" }, alt: { extends: "opencode" },
        } } }) },
        providers: {
          listModels: async (provider: string) => ({
            models: models.filter((model) => model.provider === provider).map(({ id, label }) => ({ id, label })),
          }),
          listModes: async () => ({ modes: [{ id: "build", label: "Build" }] }),
          listControls: async () => ({ options: { auto_accept: false } }),
          snapshot: async () => ({ entries: [] }),
        },
        workspaces: { ref: () => ({
          agents: { create: async ({ agentId, config }: { agentId: string; config: { provider: string } }) => {
            const { provider } = config;
            attempts.push(provider);
            const failure = models.find((entry) => `${entry.provider}/${entry.id}` === provider)?.failure;
            let listener: (value: BackendEvent) => void;
            return {
              id: agentId,
              refresh: async () => null,
              timeline: { subscribe: (callback: typeof listener) => {
                listener = callback;
                return Object.assign(() => {}, { ready: Promise.resolve() });
              } },
              send: async () => {
                listener({ event: { type: "turn_started", turnId: agentId } });
                listener({ event: failure
                  ? { type: "turn_failed", turnId: agentId, ...failure }
                  : { type: "turn_completed", turnId: agentId,
                    usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 7 } } });
              },
            };
          } },
        }) },
      } as unknown as PaseoApi;
      const provider = createProvider({
        getPaseo: () => paseo,
        usage: usageStore,
        getPresets: async () => [{
          id: "cheapskate", name: "Cheapskate", chain: chain.join("\n"), billing: "free-only",
          costs: Object.fromEntries(chain.map((selection) => [selection, "free"])),
          overload: false, autoReturn: false,
        }],
      });
      const connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [] });
      const events: ProviderEvent[] = [];
      const finished = Promise.withResolvers<Extract<ProviderEvent, { type: "session.turn" }>>();
      connection.onEvent((event) => {
        events.push(event);
        if (event.type === "session.turn" && event.state !== "started") finished.resolve(event);
      });

      try {
        await connection.send({
          type: "session.open", requestId: "open", sessionId: "session", history: "skip",
          config: {
            cwd: home, env: { [ownerEnvKey]: ownerId }, mcpServers: {}, model: "cheapskate",
            mode: "build", persist: true, settings: {}, providerOptions: { auto_accept: true },
          },
        });
        await connection.send({
          type: "session.prompt", sessionId: "session",
          prompt: {
            clientMessageId: "message", delivery: "auto",
            input: { type: "message", content: [{ type: "text", text: "Hello" }] },
          },
        });

        const outcome = await finished.promise;
        assert.equal(outcome.state, hasFallback ? "completed" : "failed");
        assert.deepEqual(attempts, chain);
        assert.equal(JSON.stringify(events).includes("device-picker_list_devices"), false, "tool grammar leaked into provider events");
        assert.deepEqual(receipts[0]?.steps.map(({ result }) => result),
          hasFallback ? ["limit", "tool-grammar", "answered"] : ["limit", "tool-grammar"]);
        if (hasFallback) {
          assert.equal(outcome.error, undefined);
          assert.deepEqual(changes.at(-1), {
            "cheapskate.activeRoute": {
              selection: "alt/alt/free", label: "alt · Another Free Model",
              change: { reason: "tool-grammar", from: "openrouter · Free Models Router" },
            },
          });
          assert.ok(events.some((event) => event.type === "timeline.item" && event.item.type === "notification"
            && event.item.message.includes("Free Models Router exceeded its tool-call grammar limit")));
          assert.deepEqual(usageStore.summary().rows, [{
            providerId: "alt", modelId: "alt/free",
            inputTokens: 12, cachedInputTokens: 4, outputTokens: 7,
            completedTurns: 1, incompleteTurns: 0,
          }], "only the answering provider/model records usage");
          const reopened = createUsageStore();
          assert.deepEqual(reopened.summary().rows, usageStore.summary().rows, "usage is host-local and persists");
          reopened.close();
        } else {
          assert.match(outcome.error?.message ?? "", /Free Models Router exceeded its tool-call grammar limit/);
          assert.deepEqual(usageStore.summary().rows, [], "a turn with no answer records no usage");
        }
      } finally {
        await connection.close();
        usageStore.close();
      }
    });
  }
});

test("usage tallies explicit turns, misses stale snapshots, and survives a canceled refresh", { timeout: 10000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cheapskate-usage-integration-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  const usageStore = createUsageStore();
  const ownerId = "usage-integration-owner";
  const usage = { inputTokens: 20, cachedInputTokens: 3, outputTokens: 9 };
  const completions: { usage?: typeof usage; blockRefresh?: boolean }[] = [
    { usage }, { usage }, {}, { usage, blockRefresh: true },
  ];
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  let turn = 0;
  let gateRefresh = false;
  const owner = {
    agent: { workspaceId: "workspace", metadata: {} },
    refresh: async () => owner,
    setMetadata: async () => {},
    timeline: { append: async () => {} },
  };
  type BackendEvent = { event: {
    type: "turn_started" | "turn_completed"; turnId: string;
    usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  } };
  let listener: (value: BackendEvent) => void;
  const backend = {
    lastUsage: usage,
    refresh: async () => {
      if (gateRefresh) {
        gateRefresh = false;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return {};
    },
    archive: async () => {},
    timeline: { subscribe: (callback: typeof listener) => {
      listener = callback;
      return Object.assign(() => {}, { ready: Promise.resolve() });
    } },
    send: async () => {
      const index = turn++;
      const turnId = `backend-${index}`;
      const report = completions[index];
      listener({ event: { type: "turn_started", turnId } });
      listener({ event: { type: "turn_completed", turnId, ...(report.usage ? { usage: report.usage } : {}) } });
      if (report.blockRefresh) gateRefresh = true;
    },
  };
  const paseo = {
    agents: { ref: (id: string) => id === ownerId ? owner : { ...backend, id } },
    config: { get: async () => ({ config: {} }) },
    providers: {
      listModels: async () => ({ models: [{ id: "hy4", label: "Hy4" }] }),
      listModes: async () => ({ modes: [{ id: "build", label: "Build" }] }),
      listControls: async () => ({ options: {} }),
      snapshot: async () => ({ entries: [] }),
    },
    workspaces: { ref: () => ({ agents: { create: async ({ agentId }: { agentId: string }) => ({
      ...backend, id: agentId,
    }) } }) },
  } as unknown as PaseoApi;
  const provider = createProvider({
    getPaseo: () => paseo,
    usage: usageStore,
    getPresets: async () => [{
      id: "cheapskate", name: "Cheapskate", chain: "opencode/hy4", billing: "free-only",
      costs: { "opencode/hy4": "free" }, overload: false, autoReturn: false,
    }],
  });
  const connection = await provider.connect({ versions: [PROVIDER_PROTOCOL_VERSION], capabilities: [] });
  let pending = Promise.withResolvers<string>();
  connection.onEvent((event) => {
    if (event.type === "session.turn" && event.state !== "started") pending.resolve(event.state);
  });
  function prompt(messageId: string) {
    pending = Promise.withResolvers<string>();
    return connection.send({
      type: "session.prompt", sessionId: "session",
      prompt: {
        clientMessageId: messageId, delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: messageId }] },
      },
    }).then(() => pending.promise);
  }
  try {
    await connection.send({
      type: "session.open", requestId: "open", sessionId: "session", history: "skip",
      config: {
        cwd: home, env: { [ownerEnvKey]: ownerId }, mcpServers: {}, model: "cheapskate",
        mode: "build", persist: true, settings: {}, providerOptions: {},
      },
    });
    for (const messageId of ["one", "two", "three"]) {
      assert.equal(await prompt(messageId), "completed");
    }
    assert.deepEqual(usageStore.summary().rows, [{
      providerId: "opencode", modelId: "hy4",
      inputTokens: 40, cachedInputTokens: 6, outputTokens: 18,
      completedTurns: 3, incompleteTurns: 1,
    }], "explicit usage is attributed each turn while an unchanged snapshot is missing");

    const fourth = prompt("four");
    await refreshStarted.promise;
    const tallied = [{
      providerId: "opencode", modelId: "hy4",
      inputTokens: 60, cachedInputTokens: 9, outputTokens: 27,
      completedTurns: 4, incompleteTurns: 1,
    }];
    assert.deepEqual(usageStore.summary().rows, tallied, "the completed backend is tallied before its refresh settles");
    const interrupted = connection.send({ type: "session.interrupt", requestId: "interrupt", sessionId: "session" });
    releaseRefresh.resolve();
    await interrupted;
    assert.equal(await fourth, "canceled");
    assert.deepEqual(usageStore.summary().rows, tallied, "a canceled parent does not drop or duplicate the backend tally");
  } finally {
    releaseRefresh.resolve();
    await connection.close();
    usageStore.close();
  }
});
