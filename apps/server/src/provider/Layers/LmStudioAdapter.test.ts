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
});
