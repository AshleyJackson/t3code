// @effect-diagnostics globalDate:off - Tests build timestamped Droid events.
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AutonomyLevel,
  DroidInteractionMode,
  McpServerStatus,
  McpServerType,
  ReasoningEffort,
  SettingsLevel,
  SkillLocation,
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
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { type DroidContext } from "../droid/DroidAdapterTypes.ts";
import {
  handleDroidMessage,
  handleDroidNotification,
  makeDroidEventBase,
} from "../droid/DroidRuntimeEvents.ts";
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
    readonly onNotification?: (
      callback: (notification: Record<string, unknown>) => void,
    ) => () => void;
    readonly getContextStats?: () => Promise<{
      readonly used: number;
      readonly remaining: number;
      readonly limit: number;
      readonly accuracy: "exact" | "estimated";
      readonly updatedAt: string;
    }>;
    readonly onCompact?: () => Promise<{
      readonly session: DroidSession;
      readonly removedCount: number;
    }>;
    readonly cwd?: string;
    readonly supportsWorkingDirectoryChange?: boolean;
    readonly onChangeWorkingDirectory?: (workingDirectory: string) => Promise<void> | void;
    readonly onListMcpServers?: () => Promise<Awaited<ReturnType<DroidSession["listMcpServers"]>>>;
    readonly onListMcpTools?: () => Promise<Awaited<ReturnType<DroidSession["listMcpTools"]>>>;
    readonly onListTools?: () => Promise<Awaited<ReturnType<DroidSession["listTools"]>>>;
    readonly onListSkills?: () => Promise<Awaited<ReturnType<DroidSession["listSkills"]>>>;
    readonly id?: string;
  },
): DroidSession {
  let sessionSettings = { interactionMode: DroidInteractionMode.Auto } as DroidSession["settings"];
  let sessionCwd = hooks?.cwd ?? process.cwd();
  return {
    id: hooks?.id ?? "droid-test-session",
    get cwd() {
      return sessionCwd;
    },
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
    ...(hooks?.onNotification ? { onNotification: hooks.onNotification } : {}),
    ...(hooks?.getContextStats ? { getContextStats: hooks.getContextStats } : {}),
    ...(hooks?.onCompact ? { compact: hooks.onCompact } : {}),
    listMcpServers:
      hooks?.onListMcpServers ??
      (async () => ({
        servers: [],
        summary: { total: 0, connected: 0, connecting: 0, failed: 0 },
      })),
    listMcpTools: hooks?.onListMcpTools ?? (async () => []),
    listTools: hooks?.onListTools ?? (async () => []),
    listSkills: hooks?.onListSkills ?? (async () => ({ skills: [] })),
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
    ...(hooks?.supportsWorkingDirectoryChange
      ? {
          changeWorkingDirectory: async ({
            workingDirectory,
          }: {
            readonly workingDirectory: string;
          }) => {
            sessionCwd = workingDirectory;
            await hooks.onChangeWorkingDirectory?.(workingDirectory);
            return { resolvedPath: workingDirectory };
          },
        }
      : {}),
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

it.effect("injects the prepared T3 MCP server and device environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mcp-injection");
      let createOptions: Record<string, unknown> | undefined;
      setMcpProviderSession({
        environmentId: EnvironmentId.make("environment"),
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("droid"),
        endpoint: "http://127.0.0.1:4310/mcp",
        authorizationHeader: "Bearer mcp-test-token",
        capabilities: new Set(["preview", "device"]),
        agentDeviceEnvironment: {
          PATH: "C:\\agent-device-shim",
          PATH_SEPARATOR: ";",
          AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
        },
      });
      const adapter = yield* makeDroidAdapter(settings, {
        environment: { PATH: "C:\\base-path" },
        sdk: {
          createSession: async (options) => {
            createOptions = options as Record<string, unknown>;
            return fakeSession([]);
          },
          resumeSession: async () => fakeSession([]),
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      NodeAssert.deepEqual(createOptions?.mcpServers, [
        {
          type: "http",
          name: "t3-code",
          url: "http://127.0.0.1:4310/mcp",
          headers: [{ name: "Authorization", value: "Bearer mcp-test-token" }],
        },
      ]);
      NodeAssert.equal(
        (createOptions?.env as Record<string, string> | undefined)?.PATH,
        "C:\\agent-device-shim;C:\\base-path",
      );
      NodeAssert.equal(
        (createOptions?.env as Record<string, string> | undefined)?.AGENT_DEVICE_NO_UPDATE_NOTIFIER,
        "1",
      );
      clearMcpProviderSession(threadId);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("discovers Droid MCP, native tools, and skills through diagnostics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-discovery");
      let mcpServerCalls = 0;
      let mcpToolCalls = 0;
      let nativeToolCalls = 0;
      let skillCalls = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([], {
              id: "droid-discovery-session",
              onListMcpServers: async () => {
                mcpServerCalls += 1;
                return {
                  servers: [
                    {
                      name: "t3-code",
                      status: McpServerStatus.Connected,
                      source: SettingsLevel.Project,
                      isManaged: true,
                      serverType: McpServerType.Http,
                      toolCount: 1,
                    },
                  ],
                  summary: { total: 1, connected: 1, connecting: 0, failed: 0 },
                };
              },
              onListMcpTools: async () => {
                mcpToolCalls += 1;
                return [
                  {
                    serverName: "t3-code",
                    name: "preview.open",
                    isEnabled: true,
                    isReadOnly: true,
                  },
                ];
              },
              onListTools: async () => {
                nativeToolCalls += 1;
                return [
                  {
                    id: "read",
                    displayName: "Read",
                    description: "Read a file",
                    category: "read",
                    defaultAllowed: true,
                    allowed: true,
                  },
                ];
              },
              onListSkills: async () => {
                skillCalls += 1;
                return {
                  skills: [
                    {
                      name: "review",
                      filePath: "C:\\skills\\review\\SKILL.md",
                      location: SkillLocation.Project,
                      enabled: true,
                      content: "private skill content",
                    },
                  ],
                };
              },
            }),
          resumeSession: async () => fakeSession([]),
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const diagnostics = yield* adapter.diagnostics.discover(threadId);

      NodeAssert.deepEqual(
        {
          sessionId: diagnostics.sessionId,
          serverNames: diagnostics.mcpServers.map((server) => server.name),
          mcpToolNames: diagnostics.mcpTools.map((tool) => tool.name),
          nativeToolIds: diagnostics.nativeTools.map((tool) => tool.id),
          skillNames: diagnostics.skills.map((skill) => skill.name),
        },
        {
          sessionId: "droid-discovery-session",
          serverNames: ["t3-code"],
          mcpToolNames: ["preview.open"],
          nativeToolIds: ["read"],
          skillNames: ["review"],
        },
      );
      NodeAssert.equal("content" in (diagnostics.skills[0] ?? {}), false);
      NodeAssert.equal(mcpServerCalls, 1);
      NodeAssert.equal(mcpToolCalls, 1);
      NodeAssert.equal(nativeToolCalls, 1);
      NodeAssert.equal(skillCalls, 1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("maps native notifications into usage and hook lifecycle events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-notifications");
      let notify: ((notification: Record<string, unknown>) => void) | undefined;
      let statsCall = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([], {
              onNotification: (callback) => {
                notify = callback;
                return () => undefined;
              },
              getContextStats: async () => {
                statsCall += 1;
                return {
                  used: statsCall === 1 ? 5 : 42,
                  remaining: statsCall === 1 ? 95 : 58,
                  limit: 100,
                  accuracy: "exact",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                };
              },
            }),
          resumeSession: async () => fakeSession([]),
        },
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(9),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      notify?.({
        method: "droid.session_notification",
        params: {
          notification: {
            type: "session_token_usage_changed",
            sessionId: "droid-test-session",
            tokenUsage: {
              inputTokens: 20,
              outputTokens: 10,
              cacheCreationTokens: 0,
              cacheReadTokens: 2,
              thinkingTokens: 3,
            },
            inclusiveTokenUsage: {
              inputTokens: 40,
              outputTokens: 20,
              cacheCreationTokens: 0,
              cacheReadTokens: 4,
              thinkingTokens: 6,
            },
            lastCallTokenUsage: {
              inputTokens: 20,
              cacheReadTokens: 2,
              outputTokens: 10,
            },
          },
        },
      });
      notify?.({
        type: "hook_execution_started",
        hookId: "hook-1",
        hookEventName: "PreToolUse",
        hookMatcher: "Execute",
        hookCommands: [{ command: "echo hook" }],
      });
      notify?.({
        type: "hook_execution_completed",
        hookId: "hook-1",
        hookEventName: "PreToolUse",
        hookStatus: "completed",
        hookResults: [{ exitCode: 0, stdout: "hook output", stderr: "" }],
      });
      notify?.({
        params: {
          type: "hook_execution_started",
          hookId: "hook-2",
          hookEventName: "PostToolUse",
          hookMatcher: "Execute",
        },
      });
      notify?.({
        params: {
          type: "hook_execution_completed",
          hookId: "hook-2",
          hookEventName: "PostToolUse",
          hookStatus: "cancelled",
          hookResults: [],
        },
      });

      const events = Array.from(yield* joinEvents(eventsFiber));
      const usages = events.filter((event) => event.type === "thread.token-usage.updated");
      const hooks = events.filter(
        (event) =>
          event.type === "hook.started" ||
          event.type === "hook.progress" ||
          event.type === "hook.completed",
      );
      NodeAssert.equal(usages.length, 2);
      const notificationUsage = usages[1];
      NodeAssert.equal(notificationUsage?.type, "thread.token-usage.updated");
      if (notificationUsage?.type === "thread.token-usage.updated") {
        NodeAssert.equal(notificationUsage.payload.usage.usedTokens, 42);
        NodeAssert.equal(notificationUsage.payload.usage.maxTokens, 100);
        NodeAssert.equal(notificationUsage.payload.usage.compactsAutomatically, true);
      }
      NodeAssert.equal(
        hooks[2]?.type === "hook.completed" ? hooks[2].payload.stdout : undefined,
        "hook output",
      );
      NodeAssert.deepEqual(
        hooks.map((event) => event.type),
        ["hook.started", "hook.progress", "hook.completed", "hook.started", "hook.completed"],
      );
      NodeAssert.equal(
        hooks[4]?.type === "hook.completed" ? hooks[4].payload.outcome : undefined,
        "cancelled",
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("uses the replacement Droid session after native compaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-compaction");
      let oldCloseCalls = 0;
      const replacement = fakeSession(
        [
          {
            type: "token_usage_update",
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            thinkingTokens: 0,
          },
        ],
        {
          id: "droid-compacted-session",
          getContextStats: async () => ({
            used: 12,
            remaining: 88,
            limit: 100,
            accuracy: "exact",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
      );
      const original = fakeSession([], {
        id: "droid-original-session",
        onClose: async () => {
          oldCloseCalls += 1;
        },
        getContextStats: async () => ({
          used: 80,
          remaining: 20,
          limit: 100,
          accuracy: "exact",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        onCompact: async () => ({
          session: replacement,
          removedCount: 7,
        }),
      });
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => original,
          resumeSession: async () => fakeSession([]),
        },
      });
      const compactedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      const started = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      NodeAssert.equal(started.resumeCursor, "droid-original-session");
      if (adapter.compaction?.type !== "native") {
        throw new Error("Droid adapter must expose native compaction.");
      }
      yield* adapter.compaction.start(threadId);

      const compacted = yield* Fiber.join(compactedFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(compacted._tag, "Some");
      const session = (yield* adapter.listSessions())[0];
      NodeAssert.equal(session?.resumeCursor, "droid-compacted-session");
      NodeAssert.equal(oldCloseCalls, 1);
      if (compacted._tag === "Some") {
        NodeAssert.equal(
          compacted.value.type === "thread.state.changed"
            ? compacted.value.payload.afterTokens
            : undefined,
          12,
        );
        NodeAssert.deepEqual(
          compacted.value.type === "thread.state.changed"
            ? compacted.value.payload.detail
            : undefined,
          {
            source: "droid.sdk",
            removedCount: 7,
          },
        );
      }
      const usageFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "thread.token-usage.updated"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({
        threadId,
        input: "after compaction",
        attachments: [],
      });
      const usage = yield* Fiber.join(usageFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(
        usage._tag === "Some" && usage.value.type === "thread.token-usage.updated"
          ? usage.value.payload.usage.usedTokens
          : undefined,
        12,
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("ignores notifications from a retired Droid session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-stale-notification");
      let notify: ((notification: Record<string, unknown>) => void) | undefined;
      let resolveStatsStarted!: () => void;
      let resolveStaleStats!: (stats: {
        readonly used: number;
        readonly remaining: number;
        readonly limit: number;
        readonly accuracy: "exact";
        readonly updatedAt: string;
      }) => void;
      const statsStarted = new Promise<void>((resolve) => {
        resolveStatsStarted = resolve;
      });
      const staleStats = new Promise<{
        readonly used: number;
        readonly remaining: number;
        readonly limit: number;
        readonly accuracy: "exact";
        readonly updatedAt: string;
      }>((resolve) => {
        resolveStaleStats = resolve;
      });
      let statsCalls = 0;
      const replacement = fakeSession([], {
        id: "droid-stale-replacement",
        getContextStats: async () => ({
          used: 12,
          remaining: 88,
          limit: 100,
          accuracy: "exact",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      });
      const original = fakeSession([], {
        id: "droid-stale-original",
        onNotification: (callback) => {
          notify = callback;
          return () => undefined;
        },
        getContextStats: async () => {
          statsCalls += 1;
          if (statsCalls === 1) {
            return {
              used: 5,
              remaining: 95,
              limit: 100,
              accuracy: "exact" as const,
              updatedAt: "2026-01-01T00:00:00.000Z",
            };
          }
          resolveStatsStarted();
          return staleStats;
        },
        onCompact: async () => ({
          session: replacement,
          removedCount: 1,
        }),
      });
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => original,
          resumeSession: async () => fakeSession([]),
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      const compacted = yield* Deferred.make<void>();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "thread.state.changed" && event.payload.state === "compacted") {
              yield* Deferred.succeed(compacted, undefined);
            }
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      notify?.({
        type: "session_token_usage_changed",
        sessionId: "droid-stale-original",
        tokenUsage: {
          inputTokens: 20,
          outputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          thinkingTokens: 0,
        },
      });
      yield* Effect.promise(() => statsStarted);
      if (adapter.compaction?.type !== "native") {
        throw new Error("Droid adapter must expose native compaction.");
      }
      yield* adapter.compaction.start(threadId);
      resolveStaleStats({
        used: 99,
        remaining: 1,
        limit: 100,
        accuracy: "exact",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Deferred.await(compacted);
      yield* Effect.promise(() => staleStats);
      yield* Effect.yieldNow;

      NodeAssert.equal(
        events.filter(
          (event) =>
            event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 99,
        ).length,
        0,
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
        const error = new Error("Update session settings request failed") as Error & {
          metadata: Record<string, unknown>;
        };
        error.metadata = {
          code: -32602,
          message: "Persisted session settings are incompatible with this Droid version.",
        };
        throw error;
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

it.effect("does not replace a resumed session for transient settings failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-settings-transient");
      let createCalls = 0;
      const resumed = fakeSession([]);
      resumed.updateSettings = async () => {
        throw new Error("temporary transport failure");
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

      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("droid"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: "transient-session",
        })
        .pipe(Effect.flip);

      NodeAssert.equal(createCalls, 0);
      NodeAssert.equal(result._tag, "ProviderAdapterRequestError");
      NodeAssert.match(result.detail, /temporary transport failure/u);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("starts a fresh session when the resumed cursor no longer exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-not-found");
      let createCalls = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => {
            createCalls += 1;
            return fakeSession([]);
          },
          resumeSession: async () => {
            const error = new Error("Load session request failed") as Error & {
              metadata: Record<string, unknown>;
            };
            error.metadata = { code: -32004, message: "Session not found" };
            throw error;
          },
        },
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: "expired-session",
      });

      NodeAssert.equal(createCalls, 1);
      NodeAssert.equal(session.resumeCursor, "droid-test-session");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("rejects resumed sessions that cannot be synchronized to the requested cwd", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-cwd-mismatch");
      let createCalls = 0;
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => {
            createCalls += 1;
            return fakeSession([]);
          },
          resumeSession: async () =>
            fakeSession([], {
              cwd: `${process.cwd()}-different`,
            }),
        },
      });

      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("droid"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: "cwd-mismatch-session",
        })
        .pipe(Effect.flip);

      NodeAssert.equal(createCalls, 0);
      NodeAssert.equal(result._tag, "ProviderAdapterRequestError");
      NodeAssert.match(result.detail, /working[- ]directory/u);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("synchronizes a resumed session when the SDK exposes cwd control", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-resume-cwd-change");
      let changedTo: string | undefined;
      const resumed = fakeSession([], {
        cwd: `${process.cwd()}-different`,
        supportsWorkingDirectoryChange: true,
        onChangeWorkingDirectory: (workingDirectory) => {
          changedTo = workingDirectory;
        },
      });
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => fakeSession([]),
          resumeSession: async () => resumed,
        },
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: "cwd-change-session",
      });

      NodeAssert.equal(session.resumeCursor, resumed.id);
      NodeAssert.equal(changedTo, process.cwd());
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("validates Droid model selections against the adapter instance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const wrongInstance = ProviderInstanceId.make("other-droid");
      const threadId = ThreadId.make("droid-instance-validation");
      const adapter = yield* makeDroidAdapter(settings, {
        instanceId: ProviderInstanceId.make("droid-primary"),
        sdk: {
          createSession: async () => fakeSession([]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const selection = createModelSelection(wrongInstance, "grok-4.6", []);

      const startResult = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("droid"),
          runtimeMode: "full-access",
          modelSelection: selection,
        })
        .pipe(Effect.flip);
      NodeAssert.equal(startResult._tag, "ProviderAdapterValidationError");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      const turnResult = yield* adapter
        .sendTurn({
          threadId,
          input: "should fail validation",
          attachments: [],
          modelSelection: selection,
        })
        .pipe(Effect.flip);
      NodeAssert.equal(turnResult._tag, "ProviderAdapterValidationError");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("ignores completion from a retired Droid turn worker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-retired-worker");
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let createCalls = 0;
      const oldSession = fakeSession([], {
        onStream: async function* (_prompt, options) {
          markStarted();
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
          yield* [];
        },
      });
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () => {
            createCalls += 1;
            return createCalls === 1 ? oldSession : fakeSession([]);
          },
          resumeSession: async () => fakeSession([]),
        },
      });
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "retire me",
        attachments: [],
      });
      yield* Effect.promise(() => started);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* Effect.yieldNow;

      NodeAssert.equal(
        events.some(
          (event) =>
            event.turnId === turn.turnId &&
            (event.type === "turn.completed" || event.type === "runtime.error"),
        ),
        false,
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("keeps live Droid stream messages in thread snapshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-live-thread");
      const assistantMessage = {
        type: "assistant" as const,
        message: {
          id: "assistant-history-1",
          role: "assistant",
          content: [{ type: "text" as never, text: "hello from history" }],
        } as never,
        text: "hello from history",
      };
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              assistantMessage,
              {
                type: "result",
                subtype: "success",
                sessionId: "droid-test-session",
                durationMs: 1,
                tokenUsage: null,
                messages: [assistantMessage],
                text: "hello from history",
                turnCount: 1,
                success: true,
                interrupted: false,
                error: null,
              },
            ]),
          resumeSession: async () => fakeSession([]),
        },
      });
      const completed = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
      yield* Fiber.join(completed).pipe(Effect.timeout("2 seconds"));

      const snapshot = yield* adapter.readThread(threadId);
      NodeAssert.equal(snapshot.turns.length, 1);
      NodeAssert.deepEqual(snapshot.turns[0]?.items, [assistantMessage]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("surfaces SDK protocol metadata when session initialization fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeDroidAdapter(settings, {
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
                type: "tool_result",
                toolUseId: "todo-1",
                toolName: "TodoWrite",
                content: "",
                isError: false,
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

it.effect("maps the Droid SDK TodoWrite text format into plan steps", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-text-plan");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "tool_call",
                toolUseId: "todo-text-1",
                name: "TodoWrite",
                input: {
                  todos:
                    "- [x] Inspect logs\n- [in_progress] Implement mapping\n- [ ] Verify output",
                },
              },
              {
                type: "tool_result",
                toolUseId: "todo-text-1",
                toolName: "TodoWrite",
                content: "",
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
      const planFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.plan.updated"),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "work through the text plan", attachments: [] });

      const plan = yield* Fiber.join(planFiber).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal(plan._tag, "Some");
      if (plan._tag === "Some" && plan.value.type === "turn.plan.updated") {
        NodeAssert.deepEqual(plan.value.payload.plan, [
          { step: "Inspect logs", status: "completed" },
          { step: "Implement mapping", status: "inProgress" },
          { step: "Verify output", status: "pending" },
        ]);
      }
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("maps successive Droid TodoWrite snapshots into live plan updates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-plan-updates");
      const adapter = yield* makeDroidAdapter(settings, {
        sdk: {
          createSession: async () =>
            fakeSession([
              {
                type: "tool_call_delta",
                toolUse: {
                  type: "tool_use" as never,
                  id: "todo-1",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      { content: "Inspect logs", status: "in_progress" },
                      { content: "Implement mapping", status: "pending" },
                    ],
                  },
                } as never,
              },
              {
                type: "tool_result",
                toolUseId: "todo-1",
                toolName: "TodoWrite",
                content: "",
                isError: false,
              },
              {
                type: "tool_call_delta",
                toolUse: {
                  type: "tool_use" as never,
                  id: "todo-2",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      { content: "Inspect logs", status: "completed" },
                      { content: "Implement mapping", status: "active" },
                      { content: "Cancelled task", status: "cancelled" },
                    ],
                  },
                } as never,
              },
              {
                type: "tool_result",
                toolUseId: "todo-2",
                toolName: "TodoWrite",
                content: "",
                isError: false,
              },
              {
                type: "tool_call_delta",
                toolUse: {
                  type: "tool_use" as never,
                  id: "todo-3",
                  name: "TodoWrite",
                  input: {
                    todos: [{ content: "Cancelled task", status: "canceled" }],
                  },
                } as never,
              },
              {
                type: "tool_result",
                toolUseId: "todo-3",
                toolName: "TodoWrite",
                content: "",
                isError: true,
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
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.plan.updated"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "work through the tasks", attachments: [] });

      const events = yield* joinEvents(eventsFiber);
      NodeAssert.deepEqual(
        events.map((event) => (event.type === "turn.plan.updated" ? event.payload.plan : [])),
        [
          [
            { step: "Inspect logs", status: "inProgress" },
            { step: "Implement mapping", status: "pending" },
          ],
          [
            { step: "Inspect logs", status: "completed" },
            { step: "Implement mapping", status: "inProgress" },
          ],
        ],
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("ignores stale Droid messages and scopes plan deduplication to a turn", () =>
  Effect.promise(async () => {
    const threadId = ThreadId.make("droid-stale-plan");
    const firstTurnId = TurnId.make("droid-turn-first");
    const secondTurnId = TurnId.make("droid-turn-second");
    const instanceId = ProviderInstanceId.make("droid");
    const events: Array<ProviderRuntimeEvent> = [];
    const context = {
      session: {
        provider: ProviderDriverKind.make("droid"),
        providerInstanceId: instanceId,
        status: "running",
        runtimeMode: "full-access",
        threadId,
        model: "default",
        activeTurnId: secondTurnId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      droid: {} as DroidSession,
      pendingPermissions: new Map(),
      pendingUserInputs: new Map(),
      turns: [],
      activeStartedToolIds: new Set<string>(),
      activeToolInputs: new Map(),
      activeToolOutputs: new Map(),
      activeToolInputFingerprints: new Map(),
      activePlanFingerprint: undefined,
      activePlanToolUseSequences: new Map(),
      nextPlanToolUseSequence: 0,
      activePlanSequence: -1,
    } as unknown as DroidContext;
    const eventBase = makeDroidEventBase(instanceId);
    const message = (toolUseId: string) =>
      ({
        type: "tool_call",
        toolUseId,
        name: "TodoWrite",
        input: { todos: "- [ ] Keep this task" },
      }) as never as DroidStreamEvent;
    const result = (toolUseId: string) =>
      ({
        type: "tool_result",
        toolUseId,
        toolName: "TodoWrite",
        content: "",
        isError: false,
      }) as never as DroidStreamEvent;

    await handleDroidMessage({
      context,
      turnId: firstTurnId,
      message: message("stale-todo"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });
    NodeAssert.equal(events.filter((event) => event.type === "turn.plan.updated").length, 0);

    await handleDroidMessage({
      context,
      turnId: secondTurnId,
      message: message("active-todo-1"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });
    await handleDroidMessage({
      context,
      turnId: secondTurnId,
      message: result("active-todo-1"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });
    await handleDroidMessage({
      context,
      turnId: secondTurnId,
      message: message("active-todo-2"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });
    await handleDroidMessage({
      context,
      turnId: secondTurnId,
      message: result("active-todo-2"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });
    context.session = { ...context.session, activeTurnId: firstTurnId };
    await handleDroidMessage({
      context,
      turnId: firstTurnId,
      message: message("new-turn-todo"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });
    await handleDroidMessage({
      context,
      turnId: firstTurnId,
      message: result("new-turn-todo"),
      eventBase,
      emitNow: async (event) => {
        events.push(event);
      },
    });

    const plans = events.filter((event) => event.type === "turn.plan.updated");
    NodeAssert.equal(plans.length, 2);
    NodeAssert.equal(plans[0]?.turnId, secondTurnId);
    NodeAssert.equal(plans[1]?.turnId, firstTurnId);
  }),
);

it.effect("applies only successful, non-empty, newest Droid TodoWrite results", () =>
  Effect.promise(async () => {
    const threadId = ThreadId.make("droid-todo-result-guards");
    const turnId = TurnId.make("droid-todo-result-turn");
    const instanceId = ProviderInstanceId.make("droid");
    const events: Array<ProviderRuntimeEvent> = [];
    const context = {
      session: {
        provider: ProviderDriverKind.make("droid"),
        providerInstanceId: instanceId,
        status: "running",
        runtimeMode: "full-access",
        threadId,
        model: "default",
        activeTurnId: turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      droid: {} as DroidSession,
      pendingPermissions: new Map(),
      pendingUserInputs: new Map(),
      turns: [],
      activeStartedToolIds: new Set<string>(),
      activeToolInputs: new Map(),
      activeToolOutputs: new Map(),
      activeToolInputFingerprints: new Map(),
      activePlanFingerprint: undefined,
      activePlanToolUseSequences: new Map(),
      nextPlanToolUseSequence: 0,
      activePlanSequence: -1,
    } as unknown as DroidContext;
    const eventBase = makeDroidEventBase(instanceId);
    const toolCall = (toolUseId: string, step: string) =>
      ({
        type: "tool_call",
        toolUseId,
        name: "TodoWrite",
        input: { todos: [{ content: step, status: "pending" }] },
      }) as never as DroidStreamEvent;
    const toolResult = (toolUseId: string, isError: boolean) =>
      ({
        type: "tool_result",
        toolUseId,
        toolName: "TodoWrite",
        content: "",
        isError,
      }) as never as DroidStreamEvent;
    const handle = (message: DroidStreamEvent) =>
      handleDroidMessage({
        context,
        turnId,
        message,
        eventBase,
        emitNow: async (event) => {
          events.push(event);
        },
      });

    await handle(toolCall("todo-older", "Older snapshot"));
    await handle(toolCall("todo-newer", "Newer snapshot"));
    await handle(toolResult("todo-newer", false));
    await handle(toolResult("todo-older", false));
    await handle(toolCall("todo-failed", "Failed snapshot"));
    await handle(toolResult("todo-failed", true));
    await handle({
      type: "tool_call",
      toolUseId: "todo-empty",
      name: "TodoWrite",
      input: { todos: [] },
    } as never as DroidStreamEvent);
    await handle(toolResult("todo-empty", false));

    const plans = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "turn.plan.updated" }> =>
        event.type === "turn.plan.updated",
    );
    NodeAssert.deepEqual(
      plans.map((event) => event.payload.plan),
      [[{ step: "Newer snapshot", status: "pending" }]],
    );
    NodeAssert.equal(context.activePlanToolUseSequences.size, 0);
  }),
);

it.effect("keeps Droid idle notifications from settling a live turn", () =>
  Effect.promise(async () => {
    const threadId = ThreadId.make("droid-idle-state");
    const turnId = TurnId.make("droid-idle-turn");
    const staleTurnId = TurnId.make("droid-stale-turn");
    const instanceId = ProviderInstanceId.make("droid");
    const droid = fakeSession([], {
      getContextStats: async () => ({
        used: 80,
        remaining: 20,
        limit: 100,
        accuracy: "exact" as const,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    const context = {
      session: {
        provider: ProviderDriverKind.make("droid"),
        providerInstanceId: instanceId,
        status: "running",
        runtimeMode: "full-access",
        threadId,
        model: "default",
        activeTurnId: turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      droid,
      cumulativeTokenUsage: { usedTokens: 80 },
      activeTokenUsage: undefined,
      compactionInProgress: false,
      pendingCompactionNotification: undefined,
    } as unknown as DroidContext;
    const events: Array<ProviderRuntimeEvent> = [];
    const eventBase = makeDroidEventBase(instanceId);
    const emitNow = async (event: ProviderRuntimeEvent) => {
      events.push(event);
    };

    await handleDroidNotification({
      context,
      sourceDroid: droid,
      notification: { type: "droid_working_state_changed", newState: "idle" },
      turnId: staleTurnId,
      eventBase,
      emitNow,
    });
    await handleDroidNotification({
      context,
      sourceDroid: droid,
      notification: { type: "droid_working_state_changed", newState: "idle" },
      turnId,
      eventBase,
      emitNow,
    });
    context.session = { ...context.session, activeTurnId: undefined };
    await handleDroidNotification({
      context,
      sourceDroid: droid,
      notification: { type: "droid_working_state_changed", newState: "idle" },
      turnId: undefined,
      eventBase,
      emitNow,
    });
    await handleDroidNotification({
      context,
      sourceDroid: droid,
      notification: { type: "session_compacted", removedCount: 1 },
      turnId: undefined,
      eventBase,
      emitNow,
    });

    const stateEvents = events.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "session.state.changed" }> =>
        event.type === "session.state.changed",
    );
    NodeAssert.deepEqual(
      stateEvents.map((event) => event.payload.state),
      ["running", "ready"],
    );
    const compaction = events.find(
      (event): event is Extract<ProviderRuntimeEvent, { type: "thread.state.changed" }> =>
        event.type === "thread.state.changed",
    );
    NodeAssert.equal(compaction?.payload.beforeTokens, undefined);
    NodeAssert.equal(compaction?.payload.afterTokens, undefined);
  }),
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
