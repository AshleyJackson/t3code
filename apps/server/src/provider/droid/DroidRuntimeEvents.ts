import * as NodeCrypto from "node:crypto";
import { type DroidStreamEvent, type TokenUsage, type TokenUsageUpdate } from "@factory/droid-sdk";
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { DROID_PROVIDER, type DroidContext } from "./DroidAdapterTypes.ts";
import { debugDroid } from "./DroidDebug.ts";
import { contentBlockText, toTokenUsageSnapshot, toToolItemType } from "./DroidSdkMappings.ts";

export const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

export function updateDroidContextSession(
  context: DroidContext,
  patch: Partial<DroidContext["session"]>,
) {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function makeDroidEventBase(instanceId: ProviderInstanceId) {
  return (
    context: DroidContext,
    input?: {
      turnId?: TurnId;
      itemId?: string;
      requestId?: string;
      raw?: unknown;
    },
  ) => ({
    eventId: EventId.make(NodeCrypto.randomUUID()),
    provider: DROID_PROVIDER,
    providerInstanceId: instanceId,
    threadId: context.session.threadId,
    createdAt: nowIso(),
    ...(input?.turnId ? { turnId: input.turnId } : {}),
    ...(input?.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input?.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input?.raw !== undefined
      ? { raw: { source: "droid.sdk.message" as const, payload: input.raw } }
      : {}),
  });
}

type DroidEventBase = ReturnType<typeof makeDroidEventBase>;
type DroidEvent = ReturnType<DroidEventBase>;

function usageSnapshot(
  usage: TokenUsage | TokenUsageUpdate,
  context: DroidContext,
): ReturnType<typeof toTokenUsageSnapshot> {
  return toTokenUsageSnapshot(usage, context.activeTokenUsageBaseline);
}

function detailText(value: string | readonly unknown[]): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function ensureDroidToolStarted(input: {
  readonly context: DroidContext;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly data?: unknown;
  readonly source: string;
  readonly base: (itemId?: string) => DroidEvent;
  readonly emitNow: (event: ProviderRuntimeEvent) => Promise<void>;
}) {
  const { context, toolUseId, toolName, data, source, base, emitNow } = input;
  const alreadyStarted = context.activeStartedToolIds.has(toolUseId);
  debugDroid("tool.lifecycle.ensure_start", {
    toolUseId,
    toolName,
    source,
    alreadyStarted,
    startedToolCount: context.activeStartedToolIds.size,
  });
  if (alreadyStarted) return false;

  await emitNow({
    ...base(toolUseId),
    type: "item.started",
    payload: {
      itemType: toToolItemType(toolName),
      status: "inProgress",
      ...(toolName ? { title: toolName } : {}),
      ...(data !== undefined ? { data } : {}),
    },
  });
  context.activeStartedToolIds.add(toolUseId);
  return true;
}

export async function handleDroidMessage(input: {
  readonly context: DroidContext;
  readonly turnId: TurnId;
  readonly message: DroidStreamEvent;
  readonly eventBase: DroidEventBase;
  readonly emitNow: (event: ProviderRuntimeEvent) => Promise<void>;
}) {
  const { context, turnId, message, eventBase, emitNow } = input;
  const base = (itemId?: string) =>
    eventBase(context, { turnId, raw: message, ...(itemId ? { itemId } : {}) });

  switch (message.type) {
    case "assistant_text_delta": {
      const itemId = `${message.messageId}-${message.blockIndex}`;
      const text = `${context.activeAssistantItems.get(itemId) ?? ""}${message.text}`;
      context.activeAssistantItems.set(itemId, text);
      return emitNow({
        ...base(itemId),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: message.text },
      });
    }
    case "assistant_text_complete": {
      const itemId = `${message.messageId}-${message.blockIndex}`;
      if (context.activeCompletedAssistantItems.has(itemId)) return;
      context.activeCompletedAssistantItems.add(itemId);
      const detail = context.activeAssistantItems.get(itemId);
      return emitNow({
        ...base(itemId),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          ...(detail ? { detail } : {}),
        },
      });
    }
    case "thinking_text_delta": {
      const itemId = `${message.messageId}-${message.blockIndex}`;
      const text = `${context.activeThinkingItems.get(itemId) ?? ""}${message.text}`;
      context.activeThinkingItems.set(itemId, text);
      return emitNow({
        ...base(itemId),
        type: "content.delta",
        payload: { streamKind: "reasoning_text", delta: message.text },
      });
    }
    case "thinking_text_complete": {
      const itemId = `${message.messageId}-${message.blockIndex}`;
      if (context.activeCompletedThinkingItems.has(itemId)) return;
      context.activeCompletedThinkingItems.add(itemId);
      const detail = context.activeThinkingItems.get(itemId);
      return emitNow({
        ...base(itemId),
        type: "item.completed",
        payload: {
          itemType: "reasoning",
          status: "completed",
          ...(detail ? { detail } : {}),
          ...(message.durationMs !== undefined ? { data: { durationMs: message.durationMs } } : {}),
        },
      });
    }
    case "assistant": {
      if (message.message.role !== "assistant") return;
      for (const [index, block] of message.message.content.entries()) {
        const text = contentBlockText(block);
        if (text.length === 0) continue;
        const itemId = `${message.message.id}-${index}`;
        const isThinking = block.type === "thinking";
        const activeItems = isThinking ? context.activeThinkingItems : context.activeAssistantItems;
        const previousText = activeItems.get(itemId) ?? "";
        const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
        if (delta.length > 0) {
          await emitNow({
            ...base(itemId),
            type: "content.delta",
            payload: {
              streamKind: isThinking ? "reasoning_text" : "assistant_text",
              delta,
            },
          });
        }
        activeItems.set(itemId, text);
      }

      const firstTextIndex = message.message.content.findIndex(
        (block) => block.type === "text" && contentBlockText(block).length > 0,
      );
      const firstTextBlock =
        firstTextIndex >= 0 ? message.message.content[firstTextIndex] : undefined;
      if (firstTextIndex < 0 || !firstTextBlock) {
        debugDroid("assistant.message.no_text", {
          messageId: message.message.id,
          contentTypes: message.message.content.map((block) => block.type),
          topLevelTextLength: message.text.length,
        });
        return;
      }
      const completedItemId = `${message.message.id}-${firstTextIndex}`;
      if (context.activeCompletedAssistantItems.has(completedItemId)) return;
      context.activeCompletedAssistantItems.add(completedItemId);
      return emitNow({
        ...base(completedItemId),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: contentBlockText(firstTextBlock),
        },
      });
    }
    case "tool_call": {
      await ensureDroidToolStarted({
        context,
        toolUseId: message.toolUseId,
        toolName: message.name,
        data: message.input,
        source: "tool_call",
        base,
        emitNow,
      });
      return;
    }
    case "tool_call_delta": {
      const toolUseId = message.toolUse.id;
      await ensureDroidToolStarted({
        context,
        toolUseId,
        toolName: message.toolUse.name,
        data: message.toolUse.input,
        source: "tool_call_delta",
        base,
        emitNow,
      });
      return emitNow({
        ...base(toolUseId),
        type: "item.updated",
        payload: {
          itemType: toToolItemType(message.toolUse.name),
          status: "inProgress",
          title: message.toolUse.name,
          data: message.toolUse.input,
        },
      });
    }
    case "tool_progress": {
      await ensureDroidToolStarted({
        context,
        toolUseId: message.toolUseId,
        toolName: message.toolName,
        source: "tool_progress",
        base,
        emitNow,
      });
      return emitNow({
        ...base(message.toolUseId),
        type: "item.updated",
        payload: {
          itemType: toToolItemType(message.toolName),
          status: "inProgress",
          title: message.toolName,
          detail: message.content,
          data: message.update,
        },
      });
    }
    case "tool_result": {
      await ensureDroidToolStarted({
        context,
        toolUseId: message.toolUseId,
        toolName: message.toolName,
        source: "tool_result",
        base,
        emitNow,
      });
      return emitNow({
        ...base(message.toolUseId),
        type: "item.completed",
        payload: {
          itemType: toToolItemType(message.toolName),
          status: message.isError ? "failed" : "completed",
          title: message.toolName,
          detail: detailText(message.content),
        },
      });
    }
    case "working_state_changed":
      return emitNow({
        ...base(),
        type: "session.state.changed",
        payload: {
          state:
            message.state === "idle"
              ? "ready"
              : message.state === "waiting_for_tool_confirmation"
                ? "waiting"
                : "running",
          detail: message,
        },
      });
    case "token_usage_update":
      context.activeTokenUsage = usageSnapshot(message, context);
      context.cumulativeTokenUsage = context.activeTokenUsage;
      return emitNow({
        ...base(),
        type: "thread.token-usage.updated",
        payload: { usage: context.activeTokenUsage },
      });
    case "result":
      if (message.tokenUsage) {
        context.activeTokenUsage = usageSnapshot(message.tokenUsage, context);
        context.cumulativeTokenUsage = context.activeTokenUsage;
      }
      context.activeTurnState = message.interrupted
        ? "interrupted"
        : message.success
          ? "completed"
          : "failed";
      if (!message.success) {
        context.activeTurnError = message.error?.message ?? "Droid reported an unsuccessful turn.";
      }
      return;
    case "session_title_updated":
      return emitNow({
        ...base(),
        type: "thread.metadata.updated",
        payload: { name: message.title },
      });
    case "settings_updated":
      return emitNow({
        ...base(),
        type: "session.configured",
        payload: { config: message.settings },
      });
    case "mcp_status_changed":
      return emitNow({
        ...base(),
        type: "mcp.status.updated",
        payload: { status: message },
      });
    case "mcp_auth_required":
      return emitNow({
        ...base(),
        type: "auth.status",
        payload: { isAuthenticating: true, output: [message.message] },
      });
    case "mcp_auth_completed":
      return emitNow({
        ...base(),
        type: "mcp.oauth.completed",
        payload: {
          success: message.outcome === "success",
          name: message.serverName,
          ...(message.outcome === "success" ? {} : { error: message.message }),
        },
      });
    case "error":
      context.activeTurnError = message.message;
      context.activeTurnState = "failed";
      return emitNow({
        ...base(),
        type: "runtime.error",
        payload: { message: message.message, class: "provider_error" },
      });
    default:
      return;
  }
}
