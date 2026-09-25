// @effect-diagnostics globalFetchInEffect:off globalFetch:off globalErrorInEffect:off preferSchemaOverJson:off - LM Studio uses the platform fetch boundary for a small local REST client.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class LmStudioApiError extends Schema.TaggedError<LmStudioApiError>()("LmStudioApiError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface LmStudioToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface LmStudioTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export type LmStudioContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface LmStudioMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | ReadonlyArray<LmStudioContentPart>;
  readonly tool_calls?: ReadonlyArray<LmStudioToolCall>;
  readonly tool_call_id?: string;
}

export interface LmStudioToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

export interface LmStudioStreamEvent {
  readonly delta: string;
  readonly reasoningDelta?: string;
  readonly toolCalls?: ReadonlyArray<LmStudioToolCallDelta>;
  readonly done: boolean;
  readonly finishReason?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

const ModelListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isNonEmpty()),
    }),
  ),
});
const ChatStreamEvent = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.optional(
        Schema.Struct({
          content: Schema.optional(Schema.String),
          reasoning_content: Schema.optional(Schema.String),
          reasoning: Schema.optional(Schema.String),
          tool_calls: Schema.optional(
            Schema.Array(
              Schema.Struct({
                index: Schema.Number,
                id: Schema.optional(Schema.String),
                type: Schema.optional(Schema.String),
                function: Schema.optional(
                  Schema.Struct({
                    name: Schema.optional(Schema.String),
                    arguments: Schema.optional(Schema.String),
                  }),
                ),
              }),
            ),
          ),
        }),
      ),
      finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Schema.optional(Schema.Number),
      completion_tokens: Schema.optional(Schema.Number),
    }),
  ),
});
function endpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LmStudioApiError({ detail: "LM Studio server URL is invalid." });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.endsWith("/v1") ||
    parsed.pathname.endsWith("/api/v1")
  ) {
    throw new LmStudioApiError({
      detail: "LM Studio server URL must be an HTTP(S) origin without an API path.",
    });
  }
  return `${trimmed.replace(/\/+$/, "")}${path}`;
}

export const requestLmStudioJson = <T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Effect.Effect<T, LmStudioApiError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(endpoint(baseUrl, path), init);
      const body = await response.text();
      if (!response.ok) {
        throw new LmStudioApiError({
          detail: `LM Studio returned HTTP ${response.status}.`,
        });
      }
      return JSON.parse(body) as T;
    },
    catch: (cause) =>
      Schema.is(LmStudioApiError)(cause)
        ? cause
        : new LmStudioApiError({ detail: String(cause), cause }),
  });

export const listLmStudioModels = (baseUrl: string, apiKey: string) =>
  requestLmStudioJson<unknown>(baseUrl, "/v1/models", {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
  }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(ModelListResponse)(response).pipe(
        Effect.map((decoded) => {
          const seen = new Set<string>();
          return decoded.data.flatMap((model) => {
            const id = model.id.trim();
            if (!id || seen.has(id)) return [];
            seen.add(id);
            return [{ id }];
          });
        }),
        Effect.mapError(
          (cause) =>
            new LmStudioApiError({
              detail: "LM Studio returned an invalid model list.",
              cause,
            }),
        ),
      ),
    ),
  );

export const streamLmStudioChat = (input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: ReadonlyArray<LmStudioMessage>;
  readonly tools?: ReadonlyArray<LmStudioTool>;
  readonly signal?: AbortSignal;
}) => {
  const events = async function* (): AsyncGenerator<LmStudioStreamEvent> {
    const response = await fetch(endpoint(input.baseUrl, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto" } : {}),
        stream: true,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new LmStudioApiError({
        detail: `LM Studio streaming request returned HTTP ${response.status}.`,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    const parseFrame = (frame: string): LmStudioStreamEvent | undefined => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") {
        if (data === "[DONE]") sawDone = true;
        return data === "[DONE]" ? { delta: "", done: true } : undefined;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch (cause) {
        throw new LmStudioApiError({
          detail: "LM Studio returned malformed streaming JSON.",
          cause,
        });
      }
      const decoded = Schema.decodeUnknownSync(ChatStreamEvent)(raw);
      const choice = decoded.choices[0];
      const delta = choice?.delta?.content ?? "";
      const reasoningDelta =
        choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? undefined;
      const toolCalls = choice?.delta?.tool_calls?.map((toolCall) => ({
        index: toolCall.index,
        ...(toolCall.id ? { id: toolCall.id } : {}),
        ...(toolCall.function?.name ? { name: toolCall.function.name } : {}),
        ...(toolCall.function?.arguments ? { arguments: toolCall.function.arguments } : {}),
      }));
      const finishReason = choice?.finish_reason ?? undefined;
      return {
        delta,
        ...(reasoningDelta ? { reasoningDelta } : {}),
        ...(toolCalls?.length ? { toolCalls } : {}),
        done: finishReason !== undefined || sawDone,
        ...(finishReason ? { finishReason } : {}),
        ...(typeof decoded.usage?.prompt_tokens === "number"
          ? { promptTokens: decoded.usage.prompt_tokens }
          : {}),
        ...(typeof decoded.usage?.completion_tokens === "number"
          ? { completionTokens: decoded.usage.completion_tokens }
          : {}),
      };
    };

    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
      if (chunk.done) break;
    }
    const finalFrame = parseFrame(buffer);
    if (finalFrame) yield finalFrame;
    if (!sawDone) {
      yield { delta: "", done: true };
    }
  };

  return Stream.fromAsyncIterable(events(), (cause) =>
    Schema.is(LmStudioApiError)(cause)
      ? cause
      : new LmStudioApiError({ detail: String(cause), cause }),
  );
};

export const collectLmStudioChat = (input: Parameters<typeof streamLmStudioChat>[0]) =>
  streamLmStudioChat(input).pipe(
    Stream.runFold(
      () => ({
        content: "",
        promptTokens: undefined as number | undefined,
        completionTokens: undefined as number | undefined,
      }),
      (result, event) => ({
        content: result.content + event.delta,
        promptTokens: event.promptTokens ?? result.promptTokens,
        completionTokens: event.completionTokens ?? result.completionTokens,
      }),
    ),
    Effect.flatMap((result) =>
      result.content.trim()
        ? Effect.succeed({ ...result, content: result.content.trim() })
        : Effect.fail(
            new LmStudioApiError({ detail: "LM Studio returned an empty assistant message." }),
          ),
    ),
  );
