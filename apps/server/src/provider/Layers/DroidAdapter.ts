import * as NodeCrypto from "node:crypto";
import {
  type AskUserRequestParams,
  type AskUserResult,
  createSession,
  type MessageOptions,
  resumeSession,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from "@factory/droid-sdk/node";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  type DroidSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { resolveDroidImages } from "../droid/DroidAttachmentResolver.ts";
import {
  DROID_PROVIDER,
  type DroidAdapterOptions,
  type DroidAdapterShape,
  type DroidContext,
} from "../droid/DroidAdapterTypes.ts";
import {
  completeDroidContentItem,
  handleDroidMessage,
  makeDroidEventBase,
  nowIso,
  updateDroidContextSession,
} from "../droid/DroidRuntimeEvents.ts";
import {
  DroidInteractionMode,
  normalizeAskUserQuestions,
  permissionDetail,
  toAskUserResult,
  toAutonomyLevel,
  toAutonomyLevelForRuntimeMode,
  toModelId,
  toOutcome,
  toReasoningEffort,
  toRequestType,
} from "../droid/DroidSdkMappings.ts";
import { debugDroid, debugDroidRuntimeEvent, debugDroidSdkMessage } from "../droid/DroidDebug.ts";

export type { DroidAdapterOptions } from "../droid/DroidAdapterTypes.ts";

export function makeDroidAdapter(settings: DroidSettings, options?: DroidAdapterOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const sdk = options?.sdk ?? { createSession, resumeSession };
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("droid");
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, DroidContext>();
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...options?.environment }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const apiKey = env.FACTORY_API_KEY?.trim() || undefined;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const emitNow = (event: ProviderRuntimeEvent) => {
      debugDroidRuntimeEvent(event);
      return runPromise(emit(event));
    };
    const eventBase = makeDroidEventBase(instanceId);
    debugDroid("adapter.created", {
      instanceId,
      enabled: settings.enabled,
      binaryPath: settings.binaryPath,
      hasApiKey: apiKey !== undefined,
    });

    const settlePendingInteractions = (context: DroidContext) =>
      Effect.gen(function* () {
        for (const [requestId, pending] of context.pendingPermissions) {
          context.pendingPermissions.delete(requestId);
          pending.resolve("cancel");
          yield* emit({
            ...eventBase(context, { requestId }),
            type: "request.resolved",
            payload: { requestType: pending.requestType, decision: "cancel" },
          });
        }
        for (const [requestId, pending] of context.pendingUserInputs) {
          context.pendingUserInputs.delete(requestId);
          pending.resolve({ cancelled: true, answers: [] });
          yield* emit({
            ...eventBase(context, { requestId }),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
        }
      });

    const abortContext = (context: DroidContext) =>
      Effect.gen(function* () {
        context.activeAbort?.abort();
        context.activeAbort = undefined;
        yield* settlePendingInteractions(context);
      });

    const closeContext = (context: DroidContext) =>
      Effect.gen(function* () {
        yield* abortContext(context);
        yield* Effect.tryPromise(() => context.droid.close()).pipe(Effect.ignore);
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => closeContext(context), {
          concurrency: "unbounded",
          discard: true,
        });
        yield* Queue.shutdown(runtimeEvents);
      }),
    );

    const requireSession = Effect.fn("requireDroidSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: DROID_PROVIDER,
          threadId,
        });
      }
      return context;
    });

    const startSession: DroidAdapterShape["startSession"] = Effect.fn("startDroidSession")(
      function* (input) {
        if (input.provider !== undefined && input.provider !== DROID_PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: DROID_PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${DROID_PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: DROID_PROVIDER,
            operation: "startSession",
            issue: `Expected provider instance '${instanceId}' but received '${input.providerInstanceId}'.`,
          });
        }

        const existingContext = sessions.get(input.threadId);
        if (existingContext) {
          sessions.delete(input.threadId);
          yield* closeContext(existingContext);
        }

        let contextRef: DroidContext | undefined;
        const permissionHandler = (
          params: RequestPermissionRequestParams,
        ): Promise<RequestPermissionHandlerResult> =>
          new Promise((resolve) => {
            const context = contextRef;
            if (!context) {
              resolve("cancel");
              return;
            }
            const requestId = ApprovalRequestId.make(`droid-${NodeCrypto.randomUUID()}`);
            const requestType = toRequestType(params);
            context.pendingPermissions.set(requestId, { requestType, resolve });
            void emitNow({
              ...eventBase(context, { requestId, raw: params }),
              raw: { source: "droid.sdk.permission", payload: params },
              type: "request.opened",
              payload: {
                requestType,
                detail: permissionDetail(params),
                args: params,
              },
            });
          });

        const askUserHandler = (params: AskUserRequestParams): Promise<AskUserResult> =>
          new Promise((resolve) => {
            const context = contextRef;
            if (!context) {
              resolve({ cancelled: true, answers: [] });
              return;
            }
            const requestId = ApprovalRequestId.make(`droid-question-${NodeCrypto.randomUUID()}`);
            const questions = normalizeAskUserQuestions(params);
            context.pendingUserInputs.set(requestId, {
              questions,
              droidQuestions: params.questions,
              resolve,
            });
            void emitNow({
              ...eventBase(context, { requestId, raw: params }),
              raw: { source: "droid.sdk.permission", payload: params },
              type: "user-input.requested",
              payload: { questions },
            });
          });

        const modelSelection = input.modelSelection;
        const modelId = toModelId(modelSelection?.model);
        const reasoningEffort = toReasoningEffort(
          getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
        );
        const commonOptions = {
          execPath: settings.binaryPath,
          env,
          ...(apiKey ? { apiKey } : {}),
          permissionHandler,
          askUserHandler,
        };
        debugDroid("session.create.begin", {
          threadId: input.threadId,
          resume: typeof input.resumeCursor === "string",
          cwd: input.cwd,
          modelId,
          reasoningEffort,
          runtimeMode: input.runtimeMode,
          hasApiKey: apiKey !== undefined,
        });
        const droid = yield* Effect.tryPromise({
          try: async () => {
            if (typeof input.resumeCursor === "string") {
              const resumed = await sdk.resumeSession(input.resumeCursor, commonOptions);
              try {
                await resumed.updateSettings({
                  autonomyLevel: toAutonomyLevel(input),
                  ...(modelId ? { modelId } : {}),
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                });
                return resumed;
              } catch (cause) {
                // A persisted session can outlive the model or protocol version that
                // created it. Start a fresh session rather than failing the turn when
                // the daemon rejects settings on resume.
                debugDroid("session.resume.settings.failed", {
                  threadId: input.threadId,
                  modelId,
                  detail: cause instanceof Error ? cause.message : String(cause),
                });
                await resumed.close().catch(() => undefined);
                return sdk.createSession({
                  ...commonOptions,
                  ...(input.cwd ? { cwd: input.cwd } : {}),
                  ...(modelId ? { modelId } : {}),
                  autonomyLevel: toAutonomyLevel(input),
                  interactionMode: DroidInteractionMode.Auto,
                  ...(reasoningEffort ? { reasoningEffort } : {}),
                });
              }
            }
            return sdk.createSession({
              ...commonOptions,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(modelId ? { modelId } : {}),
              autonomyLevel: toAutonomyLevel(input),
              interactionMode: DroidInteractionMode.Auto,
              ...(reasoningEffort ? { reasoningEffort } : {}),
            });
          },
          catch: (cause) => {
            const detail =
              cause instanceof Error ? cause.message : "Failed to start Droid session.";
            debugDroid("session.create.failed", {
              threadId: input.threadId,
              modelId,
              detail,
            });
            return new ProviderAdapterRequestError({
              provider: DROID_PROVIDER,
              method: "createSession",
              detail,
              cause,
            });
          },
        });
        debugDroid("session.create.success", {
          threadId: input.threadId,
          droidSessionId: droid.id,
          resumed: typeof input.resumeCursor === "string",
        });

        const session: ProviderSession = {
          provider: DROID_PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          model: modelSelection?.model ?? "default",
          threadId: input.threadId,
          resumeCursor: droid.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        const context: DroidContext = {
          session,
          droid,
          pendingPermissions: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          activeAbort: undefined,
          activeAssistantItems: new Map(),
          activeThinkingItems: new Map(),
          activeCompletedAssistantItems: new Set(),
          activeCompletedAssistantContents: new Set(),
          activeCompletedThinkingItems: new Set(),
          activeCompletedThinkingContents: new Set(),
          activeStartedToolIds: new Set(),
          activeToolInputs: new Map(),
          activeToolOutputs: new Map(),
          activeToolInputFingerprints: new Map(),
          activePlanFingerprint: undefined,
          activeTurnError: undefined,
          activeTurnState: undefined,
          activeTokenUsage: undefined,
          activeTokenUsageBaseline: undefined,
          cumulativeTokenUsage: undefined,
        };
        contextRef = context;
        sessions.set(input.threadId, context);

        yield* emit({
          ...eventBase(context),
          type: "session.started",
          payload: { message: "Droid SDK session started" },
        });
        yield* emit({
          ...eventBase(context),
          type: "thread.started",
          payload: { providerThreadId: droid.id },
        });
        return session;
      },
    );

    const sendTurn: DroidAdapterShape["sendTurn"] = Effect.fn("sendDroidTurn")(function* (input) {
      debugDroid("turn.requested", {
        threadId: input.threadId,
        inputLength: input.input?.length ?? 0,
        attachmentCount: input.attachments?.length ?? 0,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
      });
      const context = sessions.get(input.threadId);
      if (!context) {
        return yield* new ProviderAdapterValidationError({
          provider: DROID_PROVIDER,
          operation: "sendTurn",
          issue: `Unknown Droid thread: ${input.threadId}`,
        });
      }
      if (context.session.status === "running" || context.session.activeTurnId) {
        return yield* new ProviderAdapterValidationError({
          provider: DROID_PROVIDER,
          operation: "sendTurn",
          issue: `Droid thread ${input.threadId} already has an active turn.`,
        });
      }

      const text = input.input?.trim();
      const images = yield* resolveDroidImages(input.attachments ?? [], {
        attachmentsDir: serverConfig.attachmentsDir,
        fileSystem,
      });
      if (!text && images.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: DROID_PROVIDER,
          operation: "sendTurn",
          issue: "Droid turns require text input or at least one attachment.",
        });
      }

      const turnId = TurnId.make(`droid-turn-${NodeCrypto.randomUUID()}`);
      const abort = new AbortController();
      context.activeAbort = abort;
      context.activeAssistantItems = new Map();
      context.activeThinkingItems = new Map();
      context.activeCompletedAssistantItems = new Set();
      context.activeCompletedAssistantContents = new Set();
      context.activeCompletedThinkingItems = new Set();
      context.activeCompletedThinkingContents = new Set();
      context.activeStartedToolIds = new Set();
      context.activeToolInputs = new Map();
      context.activeToolOutputs = new Map();
      context.activeToolInputFingerprints = new Map();
      context.activePlanFingerprint = undefined;
      context.activeTurnError = undefined;
      context.activeTurnState = undefined;
      context.activeTokenUsage = undefined;
      context.activeTokenUsageBaseline = context.cumulativeTokenUsage;
      context.turns.push({ id: turnId, items: [] });
      updateDroidContextSession(context, {
        status: "running",
        activeTurnId: turnId,
        model: input.modelSelection?.model ?? context.session.model,
        lastError: undefined,
      });

      yield* emit({
        ...eventBase(context, { turnId }),
        type: "turn.started",
        payload: { model: context.session.model },
      });

      yield* Effect.promise(async () => {
        try {
          debugDroid("turn.worker.started", {
            threadId: input.threadId,
            turnId,
            droidSessionId: context.droid.id,
          });
          const modelId = toModelId(input.modelSelection?.model);
          const reasoningEffort = toReasoningEffort(
            getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort"),
          );
          const autonomyLevel = toAutonomyLevelForRuntimeMode(context.session.runtimeMode);
          if (input.interactionMode === "plan") {
            await context.droid.enterSpecMode({
              ...(modelId ? { specModeModelId: modelId } : {}),
              ...(reasoningEffort ? { specModeReasoningEffort: reasoningEffort } : {}),
            });
          } else if (context.droid.settings.interactionMode === DroidInteractionMode.Spec) {
            await context.droid.exitSpecMode();
          }
          await context.droid.updateSettings({
            autonomyLevel,
            ...(modelId ? { modelId } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(input.interactionMode === "plan"
              ? { interactionMode: DroidInteractionMode.Spec }
              : { interactionMode: DroidInteractionMode.Auto }),
          });
          debugDroid("turn.stream.begin", {
            threadId: input.threadId,
            turnId,
            modelId,
            reasoningEffort,
            autonomyLevel,
            hasImages: images.length > 0,
          });

          const messageOptions: MessageOptions & { includePartialMessages: true } = {
            abortSignal: abort.signal,
            includePartialMessages: true,
            ...(images.length > 0 ? { images } : {}),
          };
          for await (const message of context.droid.stream(
            text || "Please respond to the attached image.",
            messageOptions,
          )) {
            debugDroidSdkMessage(message);
            await handleDroidMessage({ context, turnId, message, eventBase, emitNow });
          }
          debugDroid("turn.stream.ended", {
            threadId: input.threadId,
            turnId,
            activeTurnState: context.activeTurnState,
            activeTurnError: context.activeTurnError,
            assistantItemCount: context.activeAssistantItems.size,
            thinkingItemCount: context.activeThinkingItems.size,
            startedToolCount: context.activeStartedToolIds.size,
          });

          if (context.activeTurnState === "interrupted" || abort.signal.aborted) {
            context.activeAbort = undefined;
            updateDroidContextSession(context, {
              status: "ready",
              activeTurnId: undefined,
            });
            await emitNow({
              ...eventBase(context, { turnId }),
              type: "turn.completed",
              payload: { state: "interrupted" },
            });
            return;
          }
          if (context.activeTurnError || context.activeTurnState === "failed") {
            const message = context.activeTurnError ?? "Droid reported an unsuccessful turn.";
            context.activeAbort = undefined;
            updateDroidContextSession(context, {
              status: "error",
              activeTurnId: undefined,
              lastError: message,
            });
            await emitNow({
              ...eventBase(context, { turnId }),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: message },
            });
            return;
          }

          for (const [itemId, detail] of context.activeAssistantItems) {
            if (
              !completeDroidContentItem(
                context.activeCompletedAssistantItems,
                context.activeCompletedAssistantContents,
                itemId,
                detail,
              )
            ) {
              continue;
            }
            await emitNow({
              ...eventBase(context, { turnId, itemId }),
              type: "item.completed",
              payload: { itemType: "assistant_message", status: "completed", detail },
            });
          }
          for (const [itemId, detail] of context.activeThinkingItems) {
            if (
              !completeDroidContentItem(
                context.activeCompletedThinkingItems,
                context.activeCompletedThinkingContents,
                itemId,
                detail,
              )
            ) {
              continue;
            }
            await emitNow({
              ...eventBase(context, { turnId, itemId }),
              type: "item.completed",
              payload: { itemType: "reasoning", status: "completed", detail },
            });
          }
          context.activeAbort = undefined;
          updateDroidContextSession(context, { status: "ready", activeTurnId: undefined });
          await emitNow({
            ...eventBase(context, { turnId }),
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(context.activeTokenUsage ? { usage: context.activeTokenUsage } : {}),
            },
          });
        } catch (cause) {
          debugDroid("turn.worker.failed", {
            threadId: input.threadId,
            turnId,
            aborted: abort.signal.aborted,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          if (abort.signal.aborted) {
            context.activeAbort = undefined;
            updateDroidContextSession(context, { status: "ready", activeTurnId: undefined });
            await emitNow({
              ...eventBase(context, { turnId }),
              type: "turn.completed",
              payload: { state: "interrupted" },
            });
            return;
          }
          const message = cause instanceof Error ? cause.message : "Droid turn failed.";
          context.activeAbort = undefined;
          updateDroidContextSession(context, {
            status: "error",
            activeTurnId: undefined,
            lastError: message,
          });
          await emitNow({
            ...eventBase(context, { turnId }),
            type: "runtime.error",
            payload: { message, class: "provider_error" },
          });
          await emitNow({
            ...eventBase(context, { turnId }),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: message },
          });
        }
      }).pipe(Effect.forkDetach);

      return { threadId: input.threadId, turnId, resumeCursor: context.droid.id };
    });

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) return;
        sessions.delete(threadId);
        yield* closeContext(context);
        yield* emit({
          ...eventBase(context),
          type: "session.exited",
          payload: { reason: "Session stopped", recoverable: false, exitKind: "graceful" },
        });
      });

    return {
      provider: DROID_PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) return;
          yield* abortContext(context);
          yield* Effect.tryPromise(() => context.droid.interrupt()).pipe(Effect.ignore);
        }),
      respondToRequest: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          const pending = context?.pendingPermissions.get(requestId);
          if (!context || !pending) {
            return yield* new ProviderAdapterRequestError({
              provider: DROID_PROVIDER,
              method: "respondToRequest",
              detail: `Unknown pending Droid permission request: ${requestId}`,
            });
          }
          context.pendingPermissions.delete(requestId);
          pending.resolve(toOutcome(decision));
          yield* emit({
            ...eventBase(context, { requestId }),
            type: "request.resolved",
            payload: { requestType: pending.requestType, decision },
          });
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          const pending = context?.pendingUserInputs.get(requestId);
          if (!context || !pending) {
            return yield* new ProviderAdapterRequestError({
              provider: DROID_PROVIDER,
              method: "respondToUserInput",
              detail: `Unknown pending Droid user-input request: ${requestId}`,
            });
          }
          context.pendingUserInputs.delete(requestId);
          pending.resolve(toAskUserResult(pending.droidQuestions, answers));
          yield* emit({
            ...eventBase(context, { requestId }),
            type: "user-input.resolved",
            payload: { answers },
          });
        }),
      stopSession,
      listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          return { threadId, turns: context.turns };
        }),
      rollbackThread: (threadId, numTurns) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: DROID_PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          return yield* new ProviderAdapterRequestError({
            provider: DROID_PROVIDER,
            method: "rollbackThread",
            detail:
              "Droid rollback requires provider-native rewind/fork support and is not yet wired into T3 Code.",
          });
        }),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], stopSession, {
          concurrency: "unbounded",
          discard: true,
        }),
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies DroidAdapterShape;
  });
}
