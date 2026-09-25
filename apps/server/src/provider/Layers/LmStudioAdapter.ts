// @effect-diagnostics globalDate:off globalRandom:off globalDateInEffect:off globalRandomInEffect:off abortControllerInEffect:off nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off - session ids and cancellation are local adapter state; LM Studio's OpenAI tool wire format requires JSON and a bounded local shell bridge.
import { spawn } from "node:child_process";
import { join } from "node:path";

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
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { LmStudioSettings } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  streamLmStudioChat,
  type LmStudioMessage,
  type LmStudioTool,
  type LmStudioToolCall,
} from "../lmstudio/LmStudioApi.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";

const PROVIDER = ProviderDriverKind.make("lmstudio");
const RESUME_VERSION = 1;
const WORKSPACE_CONTEXT_PREFIX = "The current working directory for this conversation is: ";
const MAX_COMMAND_OUTPUT_CHARS = 64_000;
const MAX_LOG_RESULT_CHARS = 16_000;

interface Context {
  session: ProviderSession;
  messages: LmStudioMessage[];
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  abort: AbortController | undefined;
  approvedRequestTypes: Set<"command_execution_approval" | "file_change_approval">;
  pendingApprovals: Map<
    string,
    {
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
      readonly requestType: "command_execution_approval" | "file_change_approval";
    }
  >;
}

const now = () => new Date().toISOString();
const eventId = () => EventId.make(`lmstudio-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const LM_STUDIO_TOOLS: ReadonlyArray<LmStudioTool> = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the immediate files and directories under a workspace-relative directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory, or empty for root." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search workspace file paths or file contents.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["paths", "contents"] },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or replace a UTF-8 text file in the workspace. This can require user approval.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace. This can require user approval.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    !/^(?:[A-Za-z]:)?\//.test(normalized) &&
    !normalized.split("/").some((part) => part === ".." || part === ".git")
  );
}

function parseToolArguments(argumentsText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(["']?)[^\s"',}]+/gi,
      "$1$2[REDACTED]",
    )
    .slice(0, MAX_LOG_RESULT_CHARS);
}

function redactToolValue(name: string, value: unknown): unknown {
  if (name === "write_file")
    return { path: (value as Record<string, unknown>).path, content: "[REDACTED FILE CONTENT]" };
  if (name === "read_file")
    return { path: (value as Record<string, unknown>).path, contents: "[REDACTED FILE CONTENT]" };
  if (name === "search_files" && (value as Record<string, unknown>).mode === "contents") {
    return { ...(value as Record<string, unknown>), results: "[REDACTED FILE CONTENT]" };
  }
  if (typeof value === "string") return redactSecrets(value);
  return value;
}

function redactToolResult(
  name: string,
  args: Record<string, unknown> | undefined,
  output: string,
): unknown {
  if (name === "read_file" || (name === "search_files" && args?.mode === "contents")) {
    return "[REDACTED FILE CONTENT]";
  }
  return redactSecrets(output);
}

function redactLoopMessage(message: LmStudioMessage): Record<string, unknown> {
  return {
    role: message.role,
    content:
      message.role === "tool"
        ? "[REDACTED TOOL RESULT]"
        : typeof message.content === "string"
          ? redactSecrets(message.content)
          : message.content.map((part) =>
              part.type === "text" ? { type: "text", text: redactSecrets(part.text) } : part,
            ),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: redactToolValue(
              call.function.name,
              parseToolArguments(call.function.arguments) ?? call.function.arguments,
            ),
          })),
        }
      : {}),
  };
}

function collectToolCalls(
  target: Map<number, { id?: string; name?: string; arguments: string }>,
  calls: ReadonlyArray<{ index: number; id?: string; name?: string; arguments?: string }>,
) {
  for (const call of calls) {
    const current = target.get(call.index) ?? { arguments: "" };
    const id = call.id ?? current.id;
    const name = call.name ?? current.name;
    target.set(call.index, {
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      arguments: current.arguments + (call.arguments ?? ""),
    });
  }
}

function runWorkspaceCommand(command: string, cwd: string, signal: AbortSignal) {
  return Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve) => {
        const child = spawn(command, {
          cwd,
          shell: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        const append = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-MAX_COMMAND_OUTPUT_CHARS);
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timeout = setTimeout(() => child.kill(), 120_000);
        signal.addEventListener("abort", () => child.kill(), { once: true });
        child.once("close", (code) => {
          clearTimeout(timeout);
          resolve(`Exit code: ${code ?? "unknown"}\n${output}`.trim());
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          resolve(`Command failed to start: ${error.message}`);
        });
      }),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "run_command",
        detail: "Failed to run workspace command.",
        cause,
      }),
  });
}

function addWorkspaceContext(
  messages: ReadonlyArray<LmStudioMessage>,
  cwd: string | undefined,
): LmStudioMessage[] {
  const withoutPreviousWorkspaceContext = messages.filter(
    (message) =>
      message.role !== "system" ||
      typeof message.content !== "string" ||
      !message.content.startsWith(WORKSPACE_CONTEXT_PREFIX),
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
  options?: {
    readonly instanceId?: ProviderInstanceId;
    readonly workspace?: {
      readonly entries: WorkspaceEntries.WorkspaceEntries["Service"];
      readonly fileSystem: WorkspaceFileSystem.WorkspaceFileSystem["Service"];
    };
  },
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, Context>();
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("lmstudio");
    const workspaceEntries = yield* Effect.serviceOption(WorkspaceEntries.WorkspaceEntries);
    const workspaceFileSystem = yield* Effect.serviceOption(
      WorkspaceFileSystem.WorkspaceFileSystem,
    );
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const loopLogger: EventNdjsonLogger | undefined = Option.isSome(serverConfig)
      ? yield* makeEventNdjsonLogger(
          join(serverConfig.value.providerLogsDir, "lmstudio-tool-loop.log"),
          {
            stream: "canonical",
            batchWindowMs: 0,
          },
        )
      : undefined;
    const workspace =
      options?.workspace ??
      (Option.isSome(workspaceEntries) && Option.isSome(workspaceFileSystem)
        ? { entries: workspaceEntries.value, fileSystem: workspaceFileSystem.value }
        : undefined);
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
    const logLoop = (threadId: ThreadId, event: Record<string, unknown>) =>
      loopLogger
        ? loopLogger.write({ type: "lmstudio.tool_loop", observedAt: now(), ...event }, threadId)
        : Effect.void;
    const buildUserMessage = (input: ProviderSendTurnInput, text: string) =>
      Effect.gen(function* () {
        const images = input.attachments?.filter((attachment) => attachment.type === "image") ?? [];
        if (!images.length) return { role: "user" as const, content: text };
        if (!Option.isSome(serverConfig) || !Option.isSome(fileSystem)) {
          return { role: "user" as const, content: text };
        }
        const content: Array<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "image_url"; readonly image_url: { readonly url: string } }
        > = [{ type: "text", text }];
        for (const attachment of images) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.value.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chat/completions",
              detail: "Invalid image attachment.",
            });
          }
          const bytes = yield* fileSystem.value.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "chat/completions",
                  detail: "Failed to read image attachment.",
                  cause,
                }),
            ),
          );
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          });
        }
        return { role: "user" as const, content };
      });
    const requestApproval = (
      context: Context,
      turnId: TurnId,
      requestType: "command_execution_approval" | "file_change_approval",
      detail: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) =>
      Effect.gen(function* () {
        if (
          context.session.runtimeMode === "full-access" ||
          context.approvedRequestTypes.has(requestType) ||
          (context.session.runtimeMode === "auto-accept-edits" &&
            requestType === "file_change_approval")
        ) {
          return true;
        }
        const requestId = `lmstudio-request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const deferred = yield* Deferred.make<ProviderApprovalDecision>();
        const currentContext = yield* Effect.context();
        context.pendingApprovals.set(requestId, { decision: deferred, requestType });
        yield* emit({
          ...base(context.session.threadId, turnId),
          requestId: RuntimeRequestId.make(requestId),
          type: "request.opened",
          payload: {
            requestType,
            detail,
            args,
            options: [
              { decision: "accept", label: "Allow once" },
              { decision: "acceptForSession", label: "Allow for workspace" },
              { decision: "decline", label: "Deny" },
            ],
          },
        } as ProviderRuntimeEvent);
        const decision = yield* Effect.promise(
          () =>
            new Promise<ProviderApprovalDecision>((resolve) => {
              let settled = false;
              const finish = (value: ProviderApprovalDecision) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                resolve(value);
              };
              const onAbort = () => finish("cancel");
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) {
                onAbort();
                return;
              }
              void Effect.runPromiseWith(currentContext)(Deferred.await(deferred)).then(finish);
            }),
        );
        context.pendingApprovals.delete(requestId);
        return (
          decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways"
        );
      });

    const executeTool = (
      context: Context,
      turnId: TurnId,
      call: LmStudioToolCall,
      signal: AbortSignal,
    ) =>
      Effect.gen(function* () {
        const args = parseToolArguments(call.function.arguments);
        const itemId = RuntimeItemId.make(`lmstudio-tool-${call.id}`);
        const name = call.function.name;
        const itemType =
          name === "write_file"
            ? "file_change"
            : name === "run_command"
              ? "command_execution"
              : "dynamic_tool_call";
        yield* logLoop(context.session.threadId, {
          phase: "tool.started",
          turnId,
          toolCallId: call.id,
          toolName: name,
          arguments: redactToolValue(name, args ?? call.function.arguments),
        });
        yield* emit({
          ...base(context.session.threadId, turnId),
          itemId,
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title: name,
            detail: args ? `${name} ${JSON.stringify(args)}` : `${name} ${call.function.arguments}`,
            data: {
              toolName: name,
              toolCallId: call.id,
              input: args ?? call.function.arguments,
            },
          },
        } as ProviderRuntimeEvent);
        const fail = (detail: string) =>
          Effect.gen(function* () {
            yield* emit({
              ...base(context.session.threadId, turnId),
              itemId,
              type: "item.completed",
              payload: {
                itemType,
                status: "failed",
                title: name,
                detail,
                data: { toolName: name, toolCallId: call.id, error: detail },
              },
            } as ProviderRuntimeEvent);
            yield* logLoop(context.session.threadId, {
              phase: "tool.failed",
              turnId,
              toolCallId: call.id,
              toolName: name,
              error: redactSecrets(detail),
            });
            return `Error: ${detail}`;
          });
        if (!workspace || !context.session.cwd) {
          return yield* fail("Workspace tools require a project directory.");
        }
        if (!args) return yield* fail("Tool arguments must be a JSON object.");

        let output: string;
        if (name === "list_directory") {
          if (
            typeof args.path !== "string" ||
            (args.path !== "" && !isWorkspaceRelativePath(args.path))
          ) {
            return yield* fail("Path must be workspace-relative and cannot access .git.");
          }
          output = JSON.stringify(
            yield* workspace.entries.list({ cwd: context.session.cwd, directoryPath: args.path }),
          );
        } else if (name === "search_files") {
          if (typeof args.query !== "string" || !args.query.trim())
            return yield* fail("A non-empty query is required.");
          output = JSON.stringify(
            args.mode === "contents"
              ? yield* workspace.entries.searchContents({
                  cwd: context.session.cwd,
                  query: args.query,
                  limit: 200,
                  caseSensitive: false,
                  wholeWord: false,
                  useRegex: false,
                })
              : yield* workspace.entries.search({
                  cwd: context.session.cwd,
                  query: args.query,
                  limit: 100,
                }),
          );
        } else if (name === "read_file") {
          if (!isWorkspaceRelativePath(args.path)) {
            return yield* fail("Path must be workspace-relative and cannot access .git.");
          }
          output = JSON.stringify(
            yield* workspace.fileSystem.readFile({
              cwd: context.session.cwd,
              relativePath: args.path,
            }),
          );
        } else if (name === "write_file") {
          if (!isWorkspaceRelativePath(args.path) || typeof args.content !== "string") {
            return yield* fail("write_file requires a workspace-relative path and string content.");
          }
          if (
            !(yield* requestApproval(
              context,
              turnId,
              "file_change_approval",
              `Write ${args.path}`,
              { path: args.path },
              signal,
            ))
          ) {
            return yield* fail("User declined the file change.");
          }
          output = JSON.stringify(
            yield* workspace.fileSystem.writeFile({
              cwd: context.session.cwd,
              relativePath: args.path,
              contents: args.content,
            }),
          );
        } else if (name === "run_command") {
          if (typeof args.command !== "string" || !args.command.trim())
            return yield* fail("A non-empty command is required.");
          if (
            !(yield* requestApproval(
              context,
              turnId,
              "command_execution_approval",
              args.command,
              { command: args.command },
              signal,
            ))
          ) {
            return yield* fail("User declined the command.");
          }
          output = yield* runWorkspaceCommand(args.command, context.session.cwd, signal);
          yield* emit({
            ...base(context.session.threadId, turnId),
            itemId,
            type: "content.delta",
            payload: { streamKind: "command_output", delta: output },
          } as ProviderRuntimeEvent);
        } else {
          return yield* fail(`Unsupported tool '${name}'.`);
        }
        yield* emit({
          ...base(context.session.threadId, turnId),
          itemId,
          type: "item.completed",
          payload: {
            itemType,
            status: "completed",
            title: name,
            detail: name,
            data: {
              toolName: name,
              toolCallId: call.id,
              input: args,
              rawOutput: output,
            },
          },
        } as ProviderRuntimeEvent);
        yield* logLoop(context.session.threadId, {
          phase: "tool.completed",
          turnId,
          toolCallId: call.id,
          toolName: name,
          arguments: redactToolValue(name, args),
          result: redactToolResult(name, args, output),
        });
        return output;
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.succeed(`Error: ${cause instanceof Error ? cause.message : String(cause)}`),
          onSuccess: Effect.succeed,
        }),
      );

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
          approvedRequestTypes: new Set(),
          pendingApprovals: new Map(),
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
        context.messages.push(yield* buildUserMessage(input, text));
        context.turns.push({ id: turnId, items: [] });
        yield* emit({
          ...base(input.threadId, turnId),
          type: "turn.started",
          payload: { model },
        } as ProviderRuntimeEvent);
        let response = "";
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let previousToolSignature: string | undefined;
        let repeatedToolSignatureCount = 0;
        let round = 0;
        for (;;) {
          let roundResponse = "";
          const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
          yield* logLoop(input.threadId, {
            phase: "request",
            turnId,
            round,
            messages: context.messages.map(redactLoopMessage),
            toolsEnabled: Boolean(workspace && context.session.cwd),
          });
          yield* streamLmStudioChat({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model,
            messages: context.messages,
            ...(workspace && context.session.cwd ? { tools: LM_STUDIO_TOOLS } : {}),
            signal: controller.signal,
          }).pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                roundResponse += event.delta;
                promptTokens = event.promptTokens ?? promptTokens;
                completionTokens = event.completionTokens ?? completionTokens;
                if (event.toolCalls) collectToolCalls(calls, event.toolCalls);
                if (event.delta) {
                  yield* emit({
                    ...base(input.threadId, turnId),
                    itemId: RuntimeItemId.make(`lmstudio-item-${turnId}`),
                    type: "content.delta",
                    payload: { streamKind: "assistant_text", delta: event.delta },
                  } as ProviderRuntimeEvent);
                }
                if (event.reasoningDelta) {
                  yield* emit({
                    ...base(input.threadId, turnId),
                    itemId: RuntimeItemId.make(`lmstudio-reasoning-${turnId}`),
                    type: "content.delta",
                    payload: { streamKind: "reasoning_text", delta: event.reasoningDelta },
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
          const toolCalls: LmStudioToolCall[] = [...calls.values()].flatMap((call) =>
            call.id && call.name
              ? [
                  {
                    id: call.id,
                    type: "function" as const,
                    function: { name: call.name, arguments: call.arguments },
                  },
                ]
              : [],
          );
          yield* logLoop(input.threadId, {
            phase: "response",
            turnId,
            round,
            assistantText: redactSecrets(roundResponse),
            toolCalls: toolCalls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: redactToolValue(
                call.function.name,
                parseToolArguments(call.function.arguments) ?? call.function.arguments,
              ),
            })),
          });
          context.messages.push({
            role: "assistant",
            content: roundResponse,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          });
          if (!toolCalls.length) {
            response += roundResponse;
            break;
          }
          const toolSignature = toolCalls
            .map((call) => `${call.function.name}:${call.function.arguments}`)
            .join("|");
          if (toolSignature === previousToolSignature) {
            repeatedToolSignatureCount++;
          } else {
            previousToolSignature = toolSignature;
            repeatedToolSignatureCount = 1;
          }
          if (repeatedToolSignatureCount >= 8) {
            yield* logLoop(input.threadId, {
              phase: "loop.detected",
              turnId,
              round,
              toolSignature: redactSecrets(toolSignature),
            });
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chat/completions",
              detail:
                "LM Studio repeated the same tool call eight times; stopping to prevent an infinite loop.",
            });
          }
          for (const call of toolCalls) {
            const result = yield* executeTool(context, turnId, call, controller.signal);
            context.messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          round++;
        }
        response = response.trim();
        if (!response) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat/completions",
            detail: "LM Studio returned an empty assistant message.",
          });
        }
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
            ...(promptTokens !== undefined || completionTokens !== undefined
              ? {
                  tokenUsage: {
                    usageStatus: "partial" as const,
                    usageScope: "main_agent" as const,
                    hasSubagents: false,
                    ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
                    ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}),
                  },
                }
              : {}),
            ...(promptTokens === undefined && completionTokens === undefined
              ? {
                  tokenUsage: {
                    usageStatus: "unavailable" as const,
                    usageScope: "main_agent" as const,
                    hasSubagents: false,
                  },
                }
              : {}),
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
        threadId: ThreadId,
        requestId: string,
        decision: ProviderApprovalDecision,
      ) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const pending = context.pendingApprovals.get(requestId);
          if (pending) {
            yield* Deferred.succeed(pending.decision, decision).pipe(Effect.asVoid);
            if (decision === "acceptForSession" || decision === "acceptAlways") {
              context.approvedRequestTypes.add(pending.requestType);
            }
            yield* emit({
              ...base(threadId, context.activeTurnId),
              requestId: RuntimeRequestId.make(requestId),
              type: "request.resolved",
              payload: { requestType: pending.requestType, decision },
            } as ProviderRuntimeEvent);
          }
        }),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: string,
        _answers: ProviderUserInputAnswers,
      ) => Effect.void,
      stopSession: (threadId) =>
        Effect.sync(() => {
          const context = sessions.get(threadId);
          context?.abort?.abort();
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
        Effect.gen(function* () {
          for (const context of sessions.values()) {
            context.abort?.abort();
          }
          sessions.clear();
          if (loopLogger) yield* loopLogger.close();
        }),
      streamEvents: Stream.fromQueue(queue),
    };
    return adapter;
  });
}
