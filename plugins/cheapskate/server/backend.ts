import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  ProviderEventSchema,
  type ProviderContent,
  type ProviderError,
  type ProviderEvent,
  type ProviderUsage,
} from "@getpaseo/plugin/server/provider";

export type PaseoApi = PluginHandlerContext["paseo"];
type PaseoAgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;

export type Message = {
  text: string;
  images: NonNullable<Parameters<PaseoAgentHandle["send"]>[1]>["images"];
  attachments: NonNullable<Parameters<PaseoAgentHandle["send"]>[1]>["attachments"];
};

export function parseMessage(content: ProviderContent[]): Message {
  const text: string[] = [];
  const images: NonNullable<Message["images"]> = [];
  const attachments: NonNullable<Message["attachments"]> = [];
  for (const part of content) {
    if (part.type === "text" && !("mimeType" in part)) {
      text.push(part.text);
    } else if (part.type === "image") {
      images.push({ data: part.data, mimeType: part.mimeType });
    } else if (part.type === "forge_change_request" || part.type === "forge_issue") {
      if (!part.forge) throw new Error("The forge attachment is missing its provider.");
      attachments.push({ ...part, forge: part.forge });
    } else {
      attachments.push(part);
    }
  }
  return {
    text: text.join("\n\n"),
    images: images.length ? images : undefined,
    attachments: attachments.length ? attachments : undefined,
  };
}

type BackendOutcome =
  | { state: "completed"; usage?: ProviderUsage }
  | { state: "canceled" }
  | { state: "failed"; error: ProviderError };

const cursorPlanNotice = "Upgrade your plan to continue";

export async function runBackend({
  agent, backendFamily, sessionId, turnId, attemptId, message, signal, emit,
}: {
  agent: PaseoAgentHandle;
  backendFamily: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  message: Message;
  signal: AbortSignal;
  emit(event: ProviderEvent): void;
}): Promise<BackendOutcome> {
  const completion = Promise.withResolvers<BackendOutcome>();
  const cancel = () => completion.resolve({ state: "canceled" });
  const prefix = `${turnId}:${attemptId}:`;
  const pending = new Set<string>();
  let activeTurnId: string | undefined;
  let started = false;
  let accepting = false;
  let disconnected = false;
  let textItem: { type: "assistant_message" | "reasoning"; key?: string; id: string; text: string } | undefined;
  let checkingCursorPlanNotice = backendFamily === "cursor";

  function publishText({ type, id, text }: NonNullable<typeof textItem>) {
    emit({ type: "timeline.item", sessionId, item: { type, id, text } });
  }

  function flushCursorPlanNotice() {
    if (!checkingCursorPlanNotice) return;
    checkingCursorPlanNotice = false;
    if (textItem) publishText(textItem);
  }

  function forward(event: unknown) {
    const parsed = ProviderEventSchema.safeParse(event);
    if (parsed.success) emit(parsed.data);
    return parsed.success;
  }

  function disconnect(message: string) {
    disconnected = true;
    completion.resolve({ state: "failed", error: { message, code: "cheapskate_backend_disconnect" } });
  }

  const unsubscribe = agent.timeline.subscribe(({ event }) => {
    if (signal.aborted || disconnected) return;
    if (event.type === "subscription_restored" || event.type === "replacement" || event.type === "error") {
      disconnect("Cheapskate lost the backend timeline. Send a new message to continue.");
      return;
    }
    if (!accepting) return;
    if (event.type === "turn_started") {
      activeTurnId = event.turnId;
      started = true;
      return;
    }
    if (!started || ("turnId" in event && event.turnId && activeTurnId && event.turnId !== activeTurnId)) return;

    switch (event.type) {
      case "turn_completed": {
        // Cursor sends this limit as assistant text followed by a normal completion.
        if (checkingCursorPlanNotice && textItem?.text.trim() === cursorPlanNotice) {
          checkingCursorPlanNotice = false;
          completion.resolve({ state: "failed", error: { message: cursorPlanNotice, code: "usage_limit_reached" } });
          break;
        }
        flushCursorPlanNotice();
        const usage = event.usage;
        if (usage) emit({ type: "session.usage", sessionId, turnId, usage });
        completion.resolve({ state: "completed", usage });
        break;
      }
      case "turn_canceled":
        completion.resolve({ state: "canceled" });
        break;
      case "turn_failed":
        completion.resolve({ state: "failed", error: { message: event.error, code: event.code, diagnostic: event.diagnostic } });
        break;
      case "permission_requested": {
        flushCursorPlanNotice();
        const { id, name, kind, title, description, actions } = event.request;
        pending.add(id);
        const permissionId = prefix + id;
        const sent = forward({
          type: "session.permission", sessionId, request: { ...event.request, id: permissionId },
        });
        if (!sent) {
          // A vendor detail may be richer than the plugin protocol can carry.
          emit({
            type: "session.permission", sessionId,
            request: { id: permissionId, name, kind, title, description, actions },
          });
        }
        break;
      }
      case "permission_resolved":
        pending.delete(event.requestId);
        emit({ type: "session.permission_resolved", sessionId, permissionId: prefix + event.requestId });
        break;
      case "timeline": {
        const item = event.item;
        // The wrapper already emitted the user's message. Backend errors are handled by routing.
        if (item.type === "user_message" || item.type === "error" || item.type === "plugin") break;
        if (item.type === "assistant_message" || item.type === "reasoning") {
          // Paseo emits a synthetic assistant row before reporting a provider failure.
          if (item.type === "assistant_message" && item.text.startsWith("[System Error]")) break;
          const key = item.type === "assistant_message" ? item.messageId : undefined;
          if (textItem?.type !== item.type || textItem.key !== key) {
            if (textItem || item.type === "reasoning") flushCursorPlanNotice();
            textItem = { type: item.type, key, id: prefix + crypto.randomUUID(), text: "" };
          }
          textItem.text += item.text;
          if (checkingCursorPlanNotice && cursorPlanNotice.startsWith(textItem.text.trim())) break;
          checkingCursorPlanNotice = false;
          publishText(textItem);
          break;
        }
        flushCursorPlanNotice();
        textItem = undefined;
        const id = prefix + (item.type === "tool_call" ? item.callId : item.type);
        forward({
          type: "timeline.item", sessionId,
          item: { ...item, id, ...(item.type === "tool_call" ? { callId: id } : {}) },
        });
        break;
      }
    }
  });

  signal.addEventListener("abort", cancel, { once: true });
  try {
    await unsubscribe.ready;
    if (signal.aborted) return { state: "canceled" };
    if (disconnected) return await completion.promise;
    accepting = true;
    await agent.send(message.text, { images: message.images, attachments: message.attachments });
    return await completion.promise;
  } finally {
    signal.removeEventListener("abort", cancel);
    unsubscribe();
    flushCursorPlanNotice();
    for (const id of pending) {
      emit({ type: "session.permission_resolved", sessionId, permissionId: prefix + id });
    }
  }
}
