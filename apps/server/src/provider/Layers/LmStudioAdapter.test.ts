import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  LmStudioSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { makeLmStudioAdapter } from "./LmStudioAdapter.ts";

const decodeSettings = Schema.decodeUnknownSync(LmStudioSettings);

describe("LM Studio adapter", () => {
  it.effect("gives the model the session workspace as explicit context", () =>
    Effect.gen(function* () {
      let requestBody: { messages?: unknown } | undefined;
      vi.stubGlobal("fetch", (_input: string | URL, init?: RequestInit) => {
        requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Promise.resolve(
          new Response(
            [
              'data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      });

      const threadId = ThreadId.make("lmstudio-workspace-context");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("lmstudio"),
        model: "qwen/model",
      };
      const adapter = yield* makeLmStudioAdapter(decodeSettings({}));
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("lmstudio"),
        providerInstanceId: modelSelection.instanceId,
        threadId,
        cwd: "/workspace/project",
        modelSelection,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "What folder am I working in?",
      });

      expect(requestBody?.messages).toEqual([
        {
          role: "system",
          content:
            "The current working directory for this conversation is: /workspace/project. When the user refers to this folder or project, use this path.",
        },
        { role: "user", content: "What folder am I working in?" },
      ]);
      vi.unstubAllGlobals();
    }),
  );

  it.effect("executes an LM Studio tool call and continues the same turn", () =>
    Effect.gen(function* () {
      const requestBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
      let requestCount = 0;
      vi.stubGlobal("fetch", (_input: string | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        requestCount++;
        const data =
          requestCount === 1
            ? [
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
                "",
                "data: [DONE]",
                "",
              ]
            : [
                'data: {"choices":[{"delta":{"content":"The README is present."},"finish_reason":"stop"}]}',
                "",
                "data: [DONE]",
                "",
              ];
        return Promise.resolve(
          new Response(data.join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      });
      const threadId = ThreadId.make("lmstudio-tool-loop");
      const adapter = yield* makeLmStudioAdapter(decodeSettings({}), {
        workspace: {
          entries: {} as never,
          fileSystem: {
            readFile: () =>
              Effect.succeed({
                relativePath: "README.md",
                contents: "# Test",
                byteLength: 6,
                truncated: false,
              }),
          } as never,
        },
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("lmstudio"),
        providerInstanceId: ProviderInstanceId.make("lmstudio"),
        threadId,
        cwd: "/workspace/project",
        modelSelection: { instanceId: ProviderInstanceId.make("lmstudio"), model: "qwen/model" },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Read the README." });
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]?.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_read",
        content:
          '{"relativePath":"README.md","contents":"# Test","byteLength":6,"truncated":false}',
      });
      vi.unstubAllGlobals();
    }),
  );
});
