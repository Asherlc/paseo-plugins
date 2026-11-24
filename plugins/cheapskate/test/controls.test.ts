import assert from "node:assert/strict";
import test from "node:test";
import { closestThinking, closestMode, fallbackOptions, resolveBackendPermissions, routePermissions, type BackendControls, type Options } from "../server/controls.ts";
import type { ModeMappings } from "../shared/settings.ts";

const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const openCode = (id: string) => ({ id, family: "opencode", modes: levels("build", "plan") });
const claude = { id: "claude", family: "claude", modes: levels("default", "plan", "auto", "bypassPermissions") };
const control = (
  catalog: { id: string; family: string; modes: { id: string; label: string }[] },
  selection: string, options: Options = {},
): BackendControls => ({ ...catalog, selection, options, modelId: catalog.id, label: selection,
  selectable: true, thinking: [], controls: [] });

test("thinking maps to the closest native level and keeps exact choices", () => {
  assert.equal(closestThinking("high", levels("low", "high", "max")), "high");
  assert.equal(closestThinking("max", levels("low", "high")), "high");
  assert.equal(closestThinking("medium", levels("low", "high")), "low");
  assert.equal(closestThinking("none", levels("low", "max")), "low");
  assert.equal(closestThinking("high", []), undefined);
  assert.equal(closestThinking("auto", levels("low", "high")), undefined);
});

test("permission modes stay exact within a provider and tighten across providers", () => {
  assert.equal(closestMode("build", openCode("opencode"), openCode("opencode")), "build");
  assert.equal(closestMode("plan", openCode("opencode"), claude), "plan");
  assert.equal(closestMode("default", claude, openCode("opencode")), "plan");
  assert.equal(closestMode("bypassPermissions", claude, openCode("opencode")), "build");
  assert.equal(closestMode("plan", claude, { id: "unknown", family: "unknown", modes: levels("plan") }), null);
  const codex = { id: "codex", family: "codex", modes: levels("auto", "full-access") };
  assert.equal(closestMode("plan", claude, codex), null);
  assert.equal(closestMode("auto", codex, openCode("opencode")), "plan");
  assert.equal(closestMode("auto", codex, { ...claude, modes: levels("default", "acceptEdits", "auto") }), null);
});

test("object-key-like provider and mode IDs never auto-map through the prototype", () => {
  const shadowSource = { id: "constructor", family: "constructor", modes: levels("name") };
  const shadowDestination = { id: "toString", family: "toString", modes: levels("name", "length") };
  assert.equal(closestMode("name", shadowSource, shadowDestination), null);
  assert.equal(closestMode("constructor", openCode("opencode"), claude), null);
  assert.equal(closestMode("toString", openCode("opencode"), claude), null);
  assert.equal(closestMode("default", claude, shadowDestination), null);
});

test("permission options are preserved only when there is a safe mapping", () => {
  const source = openCode("opencode");
  const destination = openCode("opencode-other");
  assert.deepEqual(fallbackOptions(source, destination, { auto_accept: false }), { auto_accept: false });
  assert.deepEqual(fallbackOptions(source, claude, { auto_accept: false }), {});
  assert.equal(fallbackOptions(source, claude, { permission: { bash: "deny" } }), null);
  assert.deepEqual(fallbackOptions(claude, destination, { fast: true }), { auto_accept: false, permission: "ask" });
  assert.deepEqual(fallbackOptions(claude, destination, {}, "plan"), { auto_accept: false, permission: "deny" });
});

test("routing rejects a fallback with compatible modes but incompatible permission options", () => {
  const source = openCode("opencode");
  assert.equal(routePermissions("plan", source, claude, { permission: { bash: "deny" } }), null);
  assert.deepEqual(routePermissions("plan", claude, source, {}), {
    mode: "plan", options: { auto_accept: false, permission: "deny" },
  });
});

test("explicit mappings are a fallback, never an override of a safe automatic match", () => {
  const source = control(openCode("opencode"), "opencode/source");
  const destination = control(claude, "claude/destination");
  const mappings: ModeMappings = [
    { source: "opencode/source", sourceMode: "build", destination: "claude/destination", destinationMode: "plan" },
  ];
  // The automatic match (default) wins over the configured plan mode.
  assert.deepEqual(resolveBackendPermissions(source, destination, "build", {}, mappings), {
    mode: "default", options: {},
  });
  // When automatic routing has no equivalent, the explicit mode applies with the
  // destination's own options rather than the source's.
  const custom = control({ id: "custom", family: "custom", modes: levels("custom-mode") },
    "custom/destination", { permission: "ask" });
  const usable: ModeMappings = [{ ...mappings[0], destination: "custom/destination", destinationMode: "custom-mode" }];
  assert.deepEqual(resolveBackendPermissions(source, custom, "build", { auto_accept: true }, usable), {
    mode: "custom-mode", options: { permission: "ask" },
  });
  // A saved mode the destination no longer offers is stale, so the backend is skipped.
  const stale: ModeMappings = [{ ...usable[0], destinationMode: "removed" }];
  assert.equal(resolveBackendPermissions(source, custom, "build", {}, stale), null);
  assert.equal(resolveBackendPermissions(source, custom, "build", {}, [{ ...usable[0], destination: "other/destination" }]), null);
});

test("only a mode-less source uses the empty mode sentinel at explicit mapping lookup", () => {
  const destination = control({ id: "dest", family: "dest", modes: [] }, "dest/destination", { auto_accept: false });
  const mappings: ModeMappings = [
    { source: "mode-less/source", sourceMode: "", destination: "dest/destination", destinationMode: "" },
  ];
  const modeLess = control({ id: "mode-less", family: "mode-less", modes: [] }, "mode-less/source");
  // Paseo can report a defaultModeId even while it lists no modes; the empty
  // sentinel is applied at lookup, not to the session/catalog default.
  assert.equal(modeLess.defaultMode, undefined);
  assert.deepEqual(resolveBackendPermissions(modeLess, destination, "build", {}, mappings), {
    mode: undefined, options: { auto_accept: false },
  });
  // Once the source reports modes, undefined is not the mode-less sentinel.
  const withModes = control({ id: "mode-less", family: "mode-less", modes: levels("build") }, "mode-less/source");
  assert.equal(resolveBackendPermissions(withModes, destination, undefined, {}, mappings), null);
  assert.equal(resolveBackendPermissions(withModes, destination, "other", {}, mappings), null);
  // An empty destination mode expires once the destination reports modes.
  const destWithModes = control({ id: "dest", family: "dest", modes: levels("build") },
    "dest/destination", { auto_accept: false });
  assert.equal(resolveBackendPermissions(modeLess, destWithModes, "build", {}, mappings), null);
});

test("mode IDs that collide with inherited object keys still match exactly", () => {
  const source = control({ id: "custom-source", family: "custom-source", modes: levels("constructor") },
    "custom/source");
  const destination = control({ id: "custom-dest", family: "custom-dest", modes: levels("constructor") },
    "custom/destination", { flag: true });
  const mappings: ModeMappings = [
    { source: "custom/source", sourceMode: "constructor", destination: "custom/destination", destinationMode: "constructor" },
  ];
  assert.deepEqual(resolveBackendPermissions(source, destination, "constructor", {}, mappings), {
    mode: "constructor", options: { flag: true },
  });
  assert.equal(resolveBackendPermissions(source, destination, "toString", {}, mappings), null);
});
