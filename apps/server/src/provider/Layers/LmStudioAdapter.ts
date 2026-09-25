// @effect-diagnostics globalDate:off globalRandom:off globalDateInEffect:off globalRandomInEffect:off abortControllerInEffect:off - session ids and cancellation are local adapter state.
import {
  EventId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionStartInput,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { LmStudioSettings } from "@t3tools/contracts";
import { streamLmStudioChat, type LmStudioMessage } from "../lmstudio/LmStudioApi.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("lmstudio");
const RESUME_VERSION = 1;
const WORKSPACE_CONTEXT_PREFIX = "The current working directory for this conversation is: ";

interface Context {
  session: ProviderSession;
  messages: LmStudioMessage[];
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  abort: AbortController | undefined;
}

const now = () => new Date().toISOString();
const eventId = () => EventId.make(`lmstudio-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function addWorkspaceContext(
  messages: ReadonlyArray<LmStudioMessage>,
  cwd: string | undefined,
): LmStudioMessage[] {
  const withoutPreviousWorkspaceContext = messages.filter(
    (message) =>
      message.role !== "system" || !message.content.startsWith(WORKSPACE_CONTEXT_PREFIX),
  );
  return cwd
    ? [
        {
          role: "system",
          content: `${WORKSPACE_CONTEXT_PREFIX}${cwd}. When the user refers to this folder or project, use this path.`,
        },
        ...withoutPreviousWorkspaceContext,
      ]
    : withoutPreviousWorkspaceContext;
}

export function makeLmStudioAdapter(
  settings: LmStudioSettings,
  options?: { readonly instanceId?: ProviderInstanceId },
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, Context>();
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("lmstudio");
    const emit = (event: ProviderRuntimeEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);
    const base = (threadId: ThreadId, turnId?: TurnId) => ({
      eventId: eventId(),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId,
      createdAt: now(),
      ...(turnId ? { turnId } : {}),
    });
    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession = (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const cursor =
          typeof input.resumeCursor === "object" && input.resumeCursor !== null
            ? (input.resumeCursor as { schemaVersion?: unknown; messages?: unknown })
            : undefined;
        const resumedMessages =
          cursor?.schemaVersion === RESUME_VERSION && Array.isArray(cursor.messages)
            ? (cursor.messages as LmStudioMessage[])
            : [];
        const messages = addWorkspaceContext(resumedMessages, input.cwd);
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: { schemaVersion: RESUME_VERSION, messages },
          createdAt: now(),
          updatedAt: now(),
        };
        const context = {
          session,
          messages,
          turns: [],
          activeTurnId: undefined,
          abort: undefined,
        } satisfies Context;
        sessions.set(input.threadId, context);
        yield* emit({
          ...base(input.threadId),
          type: "session.started",
          payload: { resume: session.resumeCursor },
        } as ProviderRuntimeEvent);
        yield* emit({
          ...base(input.threadId),
          type: "session.state.changed",
          payload: { state: "ready", reason: "LM Studio session ready" },
        } as ProviderRuntimeEvent);
        yield* emit({
          ...base(input.threadId),
          type: "thread.started",
          payload: { providerThreadId: String(input.threadId) },
        } as ProviderRuntimeEvent);
        return session;
      });

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const turnId = TurnId.make(`lmstudio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const model = input.modelSelection?.model ?? context.session.model;
        if (!model) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "chat/completions",
            issue: "LM Studio requires a model selection.",
          });
        }
        const text = input.input?.trim();
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "chat/completions",
            issue: "LM Studio does not support an empty prompt.",
          });
        }
        const controller = new AbortController();
        context.abort = controller;
        context.activeTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: now(),
          model,
        };
        context.messages.push({ role: "user", content: text });
        context.turns.push({ id: turnId, items: [] });
        yield* emit({
          ...base(input.threadId, turnId),
          type: "turn.started",
          payload: { model },
        } as ProviderRuntimeEvent);
        let response = "";
        yield* streamLmStudioChat({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model,
          messages: context.messages,
          signal: controller.signal,
        }).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              response += event.delta;
              if (event.delta) {
                yield* emit({
                  ...base(input.threadId, turnId),
                  itemId: RuntimeItemId.make(`lmstudio-item-${turnId}`),
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta: event.delta },
                } as ProviderRuntimeEvent);
              }
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "chat/completions",
                detail: cause.message,
                cause,
              }),
          ),
        );
        response = response.trim();
        if (!response) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat/completions",
            detail: "LM Studio returned an empty assistant message.",
          });
        }
        context.messages.push({ role: "assistant", content: response });
        context.session = {
          ...context.session,
          status: "ready",
          updatedAt: now(),
          resumeCursor: { schemaVersion: RESUME_VERSION, messages: context.messages },
        };
        yield* emit({
          ...base(input.threadId, turnId),
          itemId: RuntimeItemId.make(`lmstudio-item-${turnId}`),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            detail: response,
          },
        } as ProviderRuntimeEvent);
        yield* emit({
          ...base(input.threadId, turnId),
          type: "turn.completed",
          payload: {
            state: "completed",
            tokenUsage: {
              usageStatus: "unavailable",
              usageScope: "main_agent",
              hasSubagents: false,
            },
          },
        } as ProviderRuntimeEvent);
        context.activeTurnId = undefined;
        context.abort = undefined;
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        promptlessTurnContinuation: false,
        supportsConversationRollback: true,
      },
      startSession,
      sendTurn,
      interruptTurn: (threadId, turnId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          context.abort?.abort();
          const active = context.activeTurnId;
          if (active && (!turnId || active === turnId)) {
            yield* emit({
              ...base(threadId, active),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
                tokenUsage: {
                  usageStatus: "unavailable",
                  usageScope: "main_agent",
                  hasSubagents: false,
                },
              },
            } as ProviderRuntimeEvent);
          }
        }),
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: string,
        _decision: ProviderApprovalDecision,
      ) => Effect.void,
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: string,
        _answers: ProviderUserInputAnswers,
      ) => Effect.void,
      stopSession: (threadId) =>
        Effect.sync(() => {
          sessions.get(threadId)?.abort?.abort();
          sessions.delete(threadId);
        }),
      listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
      rollbackThread: (
        threadId,
        numTurns,
      ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        Effect.map(requireSession(threadId), (context) => {
          context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
          return { threadId, turns: context.turns } satisfies ProviderThreadSnapshot;
        }),
      stopAll: () =>
        Effect.sync(() => {
          for (const context of sessions.values()) context.abort?.abort();
          sessions.clear();
        }),
      streamEvents: Stream.fromQueue(queue),
    };
    return adapter;
  });
}
