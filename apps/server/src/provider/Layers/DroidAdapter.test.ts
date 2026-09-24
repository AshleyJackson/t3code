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
        environment: {
          DROID_TEST_ENV: "present",
          FACTORY_API_KEY: "test-api-key",
        },
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
                  id: "m2",
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
      NodeAssert.equal(createOptions?.apiKey, "test-api-key");
      NodeAssert.equal(
        (createOptions?.env as Record<string, string> | undefined)?.DROID_TEST_ENV,
        "present",
      );
      NodeAssert.equal(
        (createOptions?.env as Record<string, string> | undefined)?.FACTORY_API_KEY,
        "test-api-key",
      );
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

it.effect("starts a fresh session when a resumed session rejects settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-settings");
      let createCalls = 0;
      let closeCalls = 0;
      const resumed = fakeSession([]);
      resumed.updateSettings = async () => {
        throw new Error("stale session settings");
      };
      resumed.close = async () => {
        closeCalls += 1;
      };
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => {
            createCalls += 1;
            return fakeSession([]);
          },
          resumeSession: async () => resumed,
        },
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "grok-4.6", [
          { id: "reasoningEffort", value: "high" },
        ]),
        resumeCursor: "stale-session",
      });

      NodeAssert.equal(createCalls, 1);
      NodeAssert.equal(closeCalls, 1);
      NodeAssert.equal(session.resumeCursor, "droid-test-session");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("surfaces SDK protocol metadata when session initialization fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let blacklistedModel: string | undefined;
      const adapter = yield* makeDroidAdapter(settings, {
        onModelBlacklisted: (modelId) => {
          blacklistedModel = modelId;
        },
        sdk: {
          createSession: async () => {
            const error = new Error("Initialize session request failed") as Error & {
              metadata: Record<string, unknown>;
            };
            error.metadata = {
              code: -32001,
              message: "Model not allowed by organization policy",
              data: { message: "The selected model is not available for this account." },
            };
            throw error;
          },
          resumeSession: async () => fakeSession([]),
        },
      });

      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("droid-init-error"),
          provider: ProviderDriverKind.make("droid"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "grok-4.6", []),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(result._tag, "ProviderAdapterRequestError");
      NodeAssert.match(result.detail, /Model not allowed by organization policy/u);
      NodeAssert.match(result.detail, /code -32001/u);
      NodeAssert.match(result.detail, /not available for this account/u);
      NodeAssert.equal(blacklistedModel, "grok-4.6");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("orders tool lifecycle events and ignores assistant messages without text", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-tool-order");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "assistant",
                message: {
                  id: "tool-message",
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use" as never,
                      id: "tool-1",
                      name: "WebSearch",
                      input: { query: "Factory Droid model policy" },
                    },
                  ],
                } as never,
                text: "",
              },
              {
                type: "tool_call_delta",
                toolUse: {
                  type: "tool_use" as never,
                  id: "tool-1",
                  name: "WebSearch",
                  input: { query: "Factory Droid model policy" },
                } as never,
              },
              {
                type: "tool_call",
                toolUseId: "tool-1",
                name: "WebSearch",
                input: { command: "pwd" },
              },
              {
                type: "tool_result",
                toolUseId: "tool-1",
                toolName: "WebSearch",
                content: "C:\\workspace",
                isError: false,
              },
              {
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
              },
            ]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "search", attachments: [] });

      const events = yield* joinEvents(eventsFiber);
      NodeAssert.equal(
        events.filter(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "assistant_message",
        ).length,
        0,
      );
      const toolEvents = events.filter(
        (event) =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "tool-1",
      );
      NodeAssert.deepEqual(
        toolEvents.map((event) => event.type),
        ["item.started", "item.completed"],
      );
      NodeAssert.equal(
        toolEvents[0]?.type === "item.started" ? toolEvents[0].payload.detail : undefined,
        "Search query: Factory Droid model policy",
      );
      NodeAssert.equal(
        toolEvents[1]?.type === "item.completed" ? toolEvents[1].payload.detail : undefined,
        "Search query: Factory Droid model policy",
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("presents Droid Task calls as descriptive subagent work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-subagent-task");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "tool_call",
                toolUseId: "task-1",
                name: "Task",
                input: {
                  description: "  Review the database\nlayer  ",
                  prompt: "Audit the SQL changes in detail.",
                  subagent_type: "code-reviewer",
                },
              },
              {
                type: "tool_progress",
                toolUseId: "task-1",
                toolName: "Task",
                content: "Inspecting queries",
                update: {
                  type: "status",
                  status: "running",
                  fullOutput: "Inspecting queries",
                },
              },
              {
                type: "tool_result",
                toolUseId: "task-1",
                toolName: "Task",
                content: "Review complete",
                isError: false,
              },
              {
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
              },
            ]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "delegate this", attachments: [] });

      const events = yield* joinEvents(eventsFiber);
      const taskEvents = events.filter(
        (event) =>
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          String(event.itemId) === "task-1",
      );
      NodeAssert.deepEqual(
        taskEvents.map((event) => event.type),
        ["item.started", "item.updated", "item.completed"],
      );
      for (const event of taskEvents) {
        if (
          event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed"
        ) {
          NodeAssert.equal(event.payload.itemType, "collab_agent_tool_call");
          NodeAssert.equal(event.payload.title, "Subagent task");
          NodeAssert.equal(event.payload.detail, "Review the database layer");
        }
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("maps Droid tool progress output and TodoWrite input to shared events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-progress-plan");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "tool_call",
                toolUseId: "todo-1",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Inspect logs", status: "completed" },
                    { content: "Implement mapping", status: "in_progress" },
                  ],
                },
              },
              {
                type: "tool_call",
                toolUseId: "exec-1",
                name: "Execute",
                input: { command: "echo hi" },
              },
              {
                type: "tool_progress",
                toolUseId: "exec-1",
                toolName: "Execute",
                content: "",
                update: {
                  type: "status",
                  status: "running",
                  fullOutput: "",
                },
              },
              {
                type: "tool_progress",
                toolUseId: "exec-1",
                toolName: "Execute",
                content: "hi",
                update: {
                  type: "status",
                  status: "running",
                  fullOutput: "hi",
                },
              },
              {
                type: "tool_progress",
                toolUseId: "exec-1",
                toolName: "Execute",
                content: "hi",
                update: {
                  type: "status",
                  status: "running",
                  fullOutput: "hi",
                },
              },
              {
                type: "tool_result",
                toolUseId: "exec-1",
                toolName: "Execute",
                content: "hi",
                isError: false,
              },
              {
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
              },
            ]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(9),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "work", attachments: [] });
      const events = yield* joinEvents(eventsFiber);
      const plan = events.find((event) => event.type === "turn.plan.updated");
      NodeAssert.deepEqual(plan?.type === "turn.plan.updated" ? plan.payload.plan : [], [
        { step: "Inspect logs", status: "completed" },
        { step: "Implement mapping", status: "inProgress" },
      ]);
      NodeAssert.ok(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "command_output" &&
            event.payload.delta === "hi",
        ),
      );
      NodeAssert.equal(
        events.filter((event) => event.type === "item.updated" && String(event.itemId) === "exec-1")
          .length,
        1,
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("summarizes Skill results without exposing the activation document", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-skill-result");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "tool_call",
                toolUseId: "skill-1",
                name: "Skill",
                input: { name: "review" },
              },
              {
                type: "tool_result",
                toolUseId: "skill-1",
                toolName: "Skill",
                content: `Skill 'review' is now active.\n<skill name="review" filePath="builtin:review">You are a senior staff software engineer.</skill>`,
                isError: false,
              },
              {
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
              },
            ]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "review this", attachments: [] });

      const events = yield* joinEvents(eventsFiber);
      const completed = events.find(
        (event) => event.type === "item.completed" && String(event.itemId) === "skill-1",
      );
      NodeAssert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.title, 'Skill "review" is now active.');
        NodeAssert.equal("detail" in completed.payload, false);
        NodeAssert.equal(
          (completed.payload.data as { output?: string }).output?.startsWith("Skill 'review'"),
          true,
        );
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("summarizes structured file-change results by path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-file-result");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "tool_call",
                toolUseId: "edit-1",
                name: "Edit",
                input: { file_path: "src/example.ts" },
              },
              {
                type: "tool_result",
                toolUseId: "edit-1",
                toolName: "Edit",
                content: JSON.stringify({
                  success: true,
                  files: [{ file_path: "C:\\workspace\\src\\example.ts" }],
                }),
                isError: false,
              },
              {
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
              },
            ]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "edit this", attachments: [] });

      const events = yield* joinEvents(eventsFiber);
      const completed = events.find(
        (event) => event.type === "item.completed" && String(event.itemId) === "edit-1",
      );
      NodeAssert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.title, "Changed files");
        NodeAssert.equal(completed.payload.detail, "C:\\workspace\\src\\example.ts");
      }
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
