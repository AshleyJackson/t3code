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
import {
  contentBlockText,
  droidProgressText,
  extractDroidPlan,
  isDroidPlanTool,
  summarizeDroidToolResult,
  toTokenUsageSnapshot,
  toToolItemType,
} from "./DroidSdkMappings.ts";

export const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
function normalizedAssistantContent(value: string): string {
  return value.trim();
}

function droidWebSearchDetail(toolName: string, input: unknown): string | undefined {
  if (!/^web[_\s-]?search$/iu.test(toolName)) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const query = ["query", "searchQuery", "search_query", "q"]
    .map((key) => record[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!query) return undefined;
  const normalized = query.replace(/\s+/gu, " ").trim();
  return `Search query: ${normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized}`;
}

function droidToolTitle(toolName: string): string {
  return toToolItemType(toolName) === "collab_agent_tool_call" ? "Subagent task" : toolName;
}

function droidToolInputDetail(toolName: string, input: unknown): string | undefined {
  const searchDetail = droidWebSearchDetail(toolName, input);
  if (searchDetail) return searchDetail;
  if (toToolItemType(toolName) !== "collab_agent_tool_call") return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;

  const record = input as Record<string, unknown>;
  const description =
    typeof record.description === "string" ? record.description.trim() : undefined;
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : undefined;
  const detail = description || prompt;
  if (!detail) return undefined;

  const normalized = detail.replace(/\s+/gu, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
}

export function completeDroidContentItem(
  completedItems: Set<string>,
  completedContents: Set<string>,
  itemId: string,
  detail: string | undefined,
): boolean {
  if (completedItems.has(itemId)) return false;
  completedItems.add(itemId);

  if (!detail) return true;
  const content = normalizedAssistantContent(detail);
  if (content.length === 0) return true;
  if (completedContents.has(content)) return false;
  completedContents.add(content);
  return true;
}

function longestMatchingAssistantPrefix(context: DroidContext, text: string): string {
  let longest = "";
  for (const candidate of context.activeAssistantItems.values()) {
    if (candidate.length > longest.length && text.startsWith(candidate)) {
      longest = candidate;
    }
  }
  return longest;
}

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

  const inputDetail = droidToolInputDetail(toolName, data);
  await emitNow({
    ...base(toolUseId),
    type: "item.started",
    payload: {
      itemType: toToolItemType(toolName),
      status: "inProgress",
      ...(toolName ? { title: droidToolTitle(toolName) } : {}),
      ...(inputDetail ? { detail: inputDetail } : {}),
      ...(data !== undefined ? { data } : {}),
    },
  });
  context.activeStartedToolIds.add(toolUseId);
  if (data !== undefined) {
    context.activeToolInputs.set(toolUseId, data);
    context.activeToolInputFingerprints.set(toolUseId, JSON.stringify(data));
  }
  return true;
}

function outputDelta(context: DroidContext, toolUseId: string, output: string): string {
  const previous = context.activeToolOutputs.get(toolUseId) ?? "";
  const delta = output.startsWith(previous) ? output.slice(previous.length) : output;
  context.activeToolOutputs.set(toolUseId, output);
  return delta;
}

async function emitDroidPlan(input: {
  readonly context: DroidContext;
  readonly toolUseId: string;
  readonly plan: ReadonlyArray<{ step: string; status: "pending" | "inProgress" | "completed" }>;
  readonly base: (itemId?: string) => DroidEvent;
  readonly emitNow: (event: ProviderRuntimeEvent) => Promise<void>;
}) {
  const fingerprint = JSON.stringify(input.plan);
  if (input.context.activePlanFingerprint === fingerprint) return;
  input.context.activePlanFingerprint = fingerprint;
  await input.emitNow({
    ...input.base(input.toolUseId),
    type: "turn.plan.updated",
    payload: { plan: input.plan },
  });
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
      const detail = context.activeAssistantItems.get(itemId);
      if (
        !completeDroidContentItem(
          context.activeCompletedAssistantItems,
          context.activeCompletedAssistantContents,
          itemId,
          detail,
        )
      ) {
        return;
      }
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
      const detail = context.activeThinkingItems.get(itemId);
      if (
        !completeDroidContentItem(
          context.activeCompletedThinkingItems,
          context.activeCompletedThinkingContents,
          itemId,
          detail,
        )
      ) {
        return;
      }
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
        const previousText =
          activeItems.get(itemId) ??
          (isThinking ? "" : longestMatchingAssistantPrefix(context, text));
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
      if (
        !completeDroidContentItem(
          context.activeCompletedAssistantItems,
          context.activeCompletedAssistantContents,
          completedItemId,
          contentBlockText(firstTextBlock),
        )
      ) {
        return;
      }
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
      if (isDroidPlanTool(message.name)) {
        const plan = extractDroidPlan(message.input);
        if (plan) {
          await emitDroidPlan({
            context,
            toolUseId: message.toolUseId,
            plan,
            base,
            emitNow,
          });
        }
      }
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
      if (isDroidPlanTool(message.toolUse.name)) {
        const plan = extractDroidPlan(message.toolUse.input);
        if (plan) {
          await emitDroidPlan({
            context,
            toolUseId,
            plan,
            base,
            emitNow,
          });
        }
      }
      const inputFingerprint = JSON.stringify(message.toolUse.input);
      if (context.activeToolInputFingerprints.get(toolUseId) === inputFingerprint) {
        return;
      }
      context.activeToolInputFingerprints.set(toolUseId, inputFingerprint);
      context.activeToolInputs.set(toolUseId, message.toolUse.input);
      const inputDetail = droidToolInputDetail(message.toolUse.name, message.toolUse.input);
      return emitNow({
        ...base(toolUseId),
        type: "item.updated",
        payload: {
          itemType: toToolItemType(message.toolUse.name),
          status: "inProgress",
          title: droidToolTitle(message.toolUse.name),
          ...(inputDetail ? { detail: inputDetail } : {}),
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
      const progressText = droidProgressText(message.update, message.content);
      if (progressText && context.activeToolOutputs.get(message.toolUseId) === progressText) {
        return;
      }
      const progressSummary = summarizeDroidToolResult(message.toolName, progressText ?? "");
      const itemType = toToolItemType(message.toolName);
      const inputDetail = droidToolInputDetail(
        message.toolName,
        context.activeToolInputs.get(message.toolUseId),
      );
      if (progressText && (itemType === "command_execution" || itemType === "file_change")) {
        const delta = outputDelta(context, message.toolUseId, progressText);
        if (delta.length > 0) {
          await emitNow({
            ...base(message.toolUseId),
            type: "content.delta",
            payload: {
              streamKind:
                itemType === "command_execution" ? "command_output" : "file_change_output",
              delta,
            },
          });
        }
      }
      const summary =
        (message.update.status ?? message.update.type === "error")
          ? (message.update.status ?? message.update.error ?? "Tool error")
          : undefined;
      // Droid emits an initial progress tick with no content while a tool is
      // starting. There is nothing useful to project from that tick, and
      // emitting it creates an empty work-log row on mobile. Keep status/error
      // updates because they still carry user-visible information.
      if (!progressText && !summary) {
        return;
      }
      if (progressText) {
        await emitNow({
          ...base(message.toolUseId),
          type: "tool.progress",
          payload: {
            toolUseId: message.toolUseId,
            toolName: message.toolName,
            ...(progressText ? { summary: progressSummary.title ?? progressText } : {}),
          },
        });
      }
      return emitNow({
        ...base(message.toolUseId),
        type: "item.updated",
        payload: {
          itemType,
          status: "inProgress",
          title: progressSummary.title ?? droidToolTitle(message.toolName),
          ...(progressSummary.detail
            ? { detail: progressSummary.detail }
            : itemType === "collab_agent_tool_call" && inputDetail
              ? { detail: inputDetail }
              : progressText && !progressSummary.title
                ? { detail: progressText }
                : {}),
          data: {
            ...message.update,
            ...(summary ? { summary } : {}),
            ...(context.activeToolInputs.has(message.toolUseId)
              ? { input: context.activeToolInputs.get(message.toolUseId) }
              : {}),
          },
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
      const resultSummary = message.isError
        ? {}
        : summarizeDroidToolResult(message.toolName, message.content);
      const inputDetail = droidToolInputDetail(
        message.toolName,
        context.activeToolInputs.get(message.toolUseId),
      );
      const resultDetail = message.isError
        ? typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content)
        : (resultSummary.detail ?? inputDetail);
      return emitNow({
        ...base(message.toolUseId),
        type: "item.completed",
        payload: {
          itemType: toToolItemType(message.toolName),
          status: message.isError ? "failed" : "completed",
          title: resultSummary.title ?? droidToolTitle(message.toolName),
          ...(resultDetail ? { detail: resultDetail } : {}),
          data: {
            input: context.activeToolInputs.get(message.toolUseId),
            output: message.content,
            ...(message.isError ? { error: true } : {}),
          },
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
