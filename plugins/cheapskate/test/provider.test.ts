import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDER_PROTOCOL_VERSION, type ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { PaseoApi } from "../server/backend.ts";
import { createProvider, ownerEnvKey } from "../server/provider.ts";

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
    { name: "refreshes the scoped catalog and uses the requested controls", error: timeout, recovers: true, refresh: true },
    { name: "stops after one refresh if the timeout persists", error: timeout, recovers: false, refresh: true },
    { name: "leaves unrelated errors alone", error: "OpenCode is disabled", recovers: false, refresh: false },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const refreshes: unknown[] = [];
      const launches: unknown[] = [];
      const refresh = async (options: unknown) => { refreshes.push(options); };
      const owner = {
        agent: { workspaceId: "workspace", metadata: {} },
        refresh: async () => owner,
        setMetadata: async () => {},
        timeline: { append: async () => {} },
      };
      type BackendEvent = { event: { type: "turn_started" | "turn_completed"; turnId: string } };
      const paseo = {
        agents: { ref: () => owner },
        config: { get: async () => ({ config: {} }) },
        providers: {
          listModels: async () => scenario.recovers && refreshes.length
            ? { models: [{ id: "opencode/hy4-flash-free", label: "Hy4 Flash Free" }] }
            : { error: scenario.error },
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
        const outcome = await finished.promise;
        assert.equal(outcome.state, scenario.recovers ? "completed" : "failed");
        assert.equal(outcome.error?.message, scenario.recovers ? undefined : scenario.error);
        assert.deepEqual(refreshes, scenario.refresh ? [{ cwd, providers: ["opencode"] }] : []);
        assert.deepEqual(launches.map((launch) => {
          const { provider, modeId, options } = launch as { provider: string; modeId: string; options: unknown };
          return { provider, modeId, options };
        }), scenario.recovers ? [{ provider: backend, modeId: "build", options: { auto_accept: true } }] : []);
      } finally {
        await connection.close();
      }
    });
  }
});
