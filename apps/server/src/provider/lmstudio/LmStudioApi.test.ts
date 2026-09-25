import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { LmStudioSettings } from "@t3tools/contracts";
import {
  collectLmStudioChat,
  listLmStudioModels,
  requestLmStudioJson,
  streamLmStudioChat,
} from "./LmStudioApi.ts";

const decodeSettings = Schema.decodeUnknownSync(LmStudioSettings);

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("LM Studio API validation", () => {
  it("accepts the documented local server default and rejects API-path URLs", () => {
    expect(decodeSettings({}).baseUrl).toBe("http://127.0.0.1:1234");
    expect(() => decodeSettings({ baseUrl: "http://localhost:1234/v1" })).toThrow();
    expect(() => decodeSettings({ baseUrl: "file:///tmp/lmstudio" })).toThrow();
    expect(() => decodeSettings({ baseUrl: "http://user:password@localhost:1234" })).toThrow();
    expect(() => decodeSettings({ baseUrl: "http://localhost:1234?token=secret" })).toThrow();
  });

  it.effect("deduplicates and validates model ids", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          response({
            data: [{ id: " qwen/model " }, { id: "qwen/model" }],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const models = yield* listLmStudioModels("http://127.0.0.1:1234", "");
      expect(models).toEqual([{ id: "qwen/model" }]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:1234/v1/models",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
      vi.unstubAllGlobals();
    }),
  );

  it.effect("rejects malformed model lists instead of silently producing an empty catalog", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", () => Promise.resolve(response({ models: [] })));
      const result = yield* listLmStudioModels("http://127.0.0.1:1234", "").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      vi.unstubAllGlobals();
    }),
  );

  it.effect("does not expose an unauthorized response body", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(response({ error: "token-must-not-leak" }, 401)),
      );
      const result = yield* requestLmStudioJson("http://127.0.0.1:1234", "/v1/models").pipe(
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("HTTP 401");
        expect(result.failure.message).not.toContain("token-must-not-leak");
      }
      vi.unstubAllGlobals();
    }),
  );

  it.effect("confirms a non-empty assistant message and usage fields", () =>
    Effect.gen(function* () {
      let request: Request | undefined;
      let requestBody: unknown;
      vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
        request = new Request(input, init);
        requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return Promise.resolve(
          new Response(
            [
              'data: {"choices":[{"delta":{"content":"  ready  "}}]}',
              "",
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        );
      });
      const result = yield* collectLmStudioChat({
        baseUrl: "http://127.0.0.1:1234",
        apiKey: "secret",
        model: "qwen/model",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result).toEqual({ content: "ready", promptTokens: 12, completionTokens: 7 });
      expect(request?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(request?.headers.get("authorization")).toBe("Bearer secret");
      expect(requestBody).toEqual({
        model: "qwen/model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      vi.unstubAllGlobals();
    }),
  );

  it.effect("rejects missing choices, empty content, and malformed JSON contracts", () =>
    Effect.gen(function* () {
      for (const body of [
        { choices: [] },
        { choices: [{ message: { content: "   " } }] },
        { choices: [{ message: { content: 42 } }] },
      ]) {
        vi.stubGlobal("fetch", () =>
          Promise.resolve(
            new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        );
        const result = yield* collectLmStudioChat({
          baseUrl: "http://127.0.0.1:1234",
          apiKey: "",
          model: "qwen/model",
          messages: [{ role: "user", content: "hello" }],
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        vi.unstubAllGlobals();
      }
    }),
  );

  it.effect("consumes streamed deltas and terminal events", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          new Response(
            [
              'data: {"choices":[{"delta":{"content":"STREAM_"}}]}',
              "",
              'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}',
              "",
              "data: [DONE]",
              "",
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        ),
      );
      const events = yield* streamLmStudioChat({
        baseUrl: "http://127.0.0.1:1234",
        apiKey: "",
        model: "qwen/model",
        messages: [{ role: "user", content: "hello" }],
      }).pipe(Stream.runCollect);
      expect(events.map((event) => event.delta).join("")).toBe("STREAM_OK");
      expect(events.some((event) => event.done && event.finishReason === "stop")).toBe(true);
      vi.unstubAllGlobals();
    }),
  );
});
