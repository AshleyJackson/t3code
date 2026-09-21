// @effect-diagnostics globalDate:off - Tests build timestamped Droid events.
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AutonomyLevel,
  DroidInteractionMode,
  ReasoningEffort,
  ToolConfirmationOutcome,
  ToolConfirmationType,
} from "@factory/droid-sdk";
import {
  type AskUserRequestParams,
  type DroidSession,
  type DroidStreamEvent,
  type MessageOptions,
  type RequestPermissionRequestParams,
} from "@factory/droid-sdk/node";
import {
  ApprovalRequestId,
  DroidSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeDroidAdapter } from "./DroidAdapter.ts";

const settings = Schema.decodeSync(DroidSettings)({
  enabled: true,
  binaryPath: "fake-droid",
});
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-droid-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function fakeSession(
  messages: ReadonlyArray<DroidStreamEvent>,
  hooks?: {
    readonly onStream?: (
      prompt: string,
      options?: MessageOptions,
    ) => AsyncGenerator<DroidStreamEvent, void, undefined>;
    readonly onInterrupt?: () => Promise<void>;
    readonly onClose?: () => Promise<void>;
  },
): DroidSession {
  let sessionSettings = { interactionMode: DroidInteractionMode.Auto } as DroidSession["settings"];
  return {
    id: "droid-test-session",
    get settings() {
      return sessionSettings;
    },
    stream: async function* (_prompt: string, options?: MessageOptions) {
      if (options?.includePartialMessages !== true) {
        throw new Error("The adapter must request partial Droid messages.");
      }
      if (hooks?.onStream) {
        yield* hooks.onStream(_prompt, options);
        return;
      }
      for (const message of messages) {
        yield message;
      }
    },
    interrupt: hooks?.onInterrupt ?? (async () => undefined),
    close: hooks?.onClose ?? (async () => undefined),
    updateSettings: async (params: Parameters<DroidSession["updateSettings"]>[0]) => {
      sessionSettings = { ...sessionSettings, ...params } as DroidSession["settings"];
      return {} as never;
    },
    enterSpecMode: async (params: Parameters<DroidSession["enterSpecMode"]>[0]) => {
      sessionSettings = {
        ...sessionSettings,
        ...params,
        interactionMode: DroidInteractionMode.Spec,
      } as DroidSession["settings"];
      return {} as never;
    },
    exitSpecMode: async () => {
      sessionSettings = {
        ...sessionSettings,
        interactionMode: DroidInteractionMode.Auto,
      } as DroidSession["settings"];
      return {} as never;
    },
  } as unknown as DroidSession;
}

const joinEvents = <A, E>(fiber: Fiber.Fiber<Iterable<A>, E>) =>
  Effect.gen(function* () {
    const result = yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"));
    return Array.from(result);
  });

it.effect("streams partial assistant output once and accumulates usage", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-streaming");
      let createOptions: Record<string, unknown> | undefined;
      const adapter = yield* makeDroidAdapter(settings, {
        instanceId: ProviderInstanceId.make("droid"),
        sdk: {
          createSession: async (options) => {
            createOptions = options as Record<string, unknown>;
            return fakeSession([
              { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: "hel" },
              { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: "lo" },
              { type: "assistant_text_complete", messageId: "m1", blockIndex: 0 },
              {
                type: "assistant",
                message: {
                  id: "m1",
                  role: "assistant",
                  content: [{ type: "text" as never, text: "hello" }],
                } as never,
                text: "hello",
              },
              {
                type: "token_usage_update",
                inputTokens: 10,
                outputTokens: 4,
                cacheCreationTokens: 2,
                cacheReadTokens: 3,
                thinkingTokens: 1,
              },
              {
                type: "result",
                subtype: "success",
                sessionId: "droid-test-session",
                durationMs: 1,
                tokenUsage: null,
                messages: [],
                text: "hello",
                turnCount: 1,
                success: true,
                interrupted: false,
                error: null,
              },
            ]);
          },
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(8),
        Stream.runCollect,
        Effect.forkChild,
      );

      const modelSelection = createModelSelection(ProviderInstanceId.make("droid"), "model-1", [
        { id: "reasoningEffort", value: "high" },
      ]);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection,
      });
      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        modelSelection,
      });

      const events = yield* joinEvents(eventsFiber);
      NodeAssert.equal(createOptions?.modelId, "model-1");
      NodeAssert.equal(createOptions?.autonomyLevel, AutonomyLevel.High);
      NodeAssert.equal(createOptions?.reasoningEffort, ReasoningEffort.High);
      NodeAssert.equal(
        events.filter(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        ).length,
        1,
      );
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["hel", "lo"],
      );
      const usage = events.find((event) => event.type === "thread.token-usage.updated");
      NodeAssert.deepEqual(
        usage?.type === "thread.token-usage.updated" ? usage.payload.usage : null,
        {
          usedTokens: 20,
          inputTokens: 15,
          cachedInputTokens: 3,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          lastUsedTokens: 20,
          lastInputTokens: 15,
          lastCachedInputTokens: 3,
          lastOutputTokens: 5,
          lastReasoningOutputTokens: 1,
        },
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("routes Droid permission requests through canonical approval events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-permission");
      let permissionResult: unknown;
      const permissionParams: RequestPermissionRequestParams = {
        options: [
          { label: "Allow once", value: ToolConfirmationOutcome.ProceedOnce },
          { label: "Cancel", value: ToolConfirmationOutcome.Cancel },
        ],
        toolUses: [
          {
            toolUse: {
              type: "tool_use" as never,
              id: "tool-1",
              input: {},
              name: "Execute",
            },
            confirmationType: ToolConfirmationType.Execute,
            details: {
              type: ToolConfirmationType.Execute,
              fullCommand: "bun test",
              command: "bun",
            },
          },
        ],
      };
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async (options) =>
            fakeSession([], {
              onStream: async function* () {
                const result = await options?.permissionHandler?.(permissionParams);
                permissionResult = result;
                yield {
                  type: "result",
                  subtype: "success",
                  sessionId: "droid-test-session",
                  durationMs: 1,
                  tokenUsage: null,
                  messages: [],
                  text: "",
                  turnCount: 1,
                  success: true,
                  interrupted: false,
                  error: null,
                };
              },
            }),
          resumeSession: async () => fakeSession([]),
        },
      });
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run tests", attachments: [] });
      const opened = yield* Fiber.join(openedFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(opened._tag, "Some");
      if (opened._tag === "Some") {
        const requestId = opened.value.requestId;
        NodeAssert.ok(requestId);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(requestId)),
          "accept",
        );
      }
      const completed = yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(completed._tag, "Some");
      NodeAssert.equal(permissionResult, ToolConfirmationOutcome.ProceedOnce);
      yield* adapter.stopSession(threadId);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("routes Droid AskUser requests through canonical user-input events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-ask-user");
      let askUserResult: unknown;
      const askUserParams: AskUserRequestParams = {
        toolCallId: "tool-user-1",
        questions: [
          {
            index: 0,
            topic: "Language",
            question: "Which language should the example use?",
            options: ["TypeScript", "JavaScript"],
            multiSelect: false,
          },
        ],
      };
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async (options) =>
            fakeSession([], {
              onStream: async function* () {
                if (!options?.askUserHandler) {
                  throw new Error("The adapter must provide an AskUser handler.");
                }
                askUserResult = await options.askUserHandler(askUserParams);
                yield {
                  type: "result",
                  subtype: "success",
                  sessionId: "droid-test-session",
                  durationMs: 1,
                  tokenUsage: null,
                  messages: [],
                  text: "",
                  turnCount: 1,
                  success: true,
                  interrupted: false,
                  error: null,
                };
              },
            }),
          resumeSession: async () => fakeSession([]),
        },
      });
      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkChild,
      );
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "auto-accept-edits",
      });
      yield* adapter.sendTurn({ threadId, input: "ask me", attachments: [] });
      const opened = yield* Fiber.join(openedFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(opened._tag, "Some");
      if (opened._tag === "Some") {
        const requestId = opened.value.requestId;
        NodeAssert.ok(requestId);
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(String(requestId)), {
          "question-0": "TypeScript",
        });
      }
      const completed = yield* Fiber.join(completedFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(completed._tag, "Some");
      NodeAssert.deepEqual(askUserResult, {
        answers: [
          {
            index: 0,
            question: "Which language should the example use?",
            answer: "TypeScript",
          },
        ],
      });
      yield* adapter.stopSession(threadId);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("interrupts an active Droid stream without reporting a provider error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-interrupt");
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([], {
              onStream: async function* (_prompt, options) {
                markStarted?.();
                yield {
                  type: "assistant_text_delta",
                  messageId: "m1",
                  blockIndex: 0,
                  text: "working",
                };
                await new Promise<void>((_resolve, reject) => {
                  if (options?.abortSignal?.aborted) {
                    reject(new DOMException("Aborted", "AbortError"));
                    return;
                  }
                  options?.abortSignal?.addEventListener(
                    "abort",
                    () => reject(new DOMException("Aborted", "AbortError")),
                    { once: true },
                  );
                });
              },
            }),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "interrupt", attachments: [] });
      yield* Effect.promise(() => started).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId);
      const events = yield* joinEvents(eventsFiber);
      NodeAssert.equal(
        events.some((event) => event.type === "runtime.error"),
        false,
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);
