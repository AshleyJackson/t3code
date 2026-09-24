import {
  AutonomyLevel,
  ReasoningEffort,
  type CreateSessionOptions,
  type DroidSession,
  type DroidStreamEvent,
  type MessageOptions,
} from "@factory/droid-sdk/node";
import { DroidSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  collectDroidResponseText,
  makeDroidTextGeneration,
  parseDroidBranchName,
  parseDroidCommitMessage,
  parseDroidPrContent,
  parseDroidThreadTitle,
} from "./DroidTextGeneration.ts";

const settings = DroidSettings.make({
  enabled: true,
  binaryPath: "fake-droid",
  customModels: [],
});

function fakeSession(
  messages: ReadonlyArray<DroidStreamEvent>,
  hooks?:
    | (() => void)
    | {
        readonly onClose?: () => void;
        readonly onStream?: (
          prompt: string,
          options?: MessageOptions,
        ) => AsyncGenerator<DroidStreamEvent, void, undefined>;
      },
): DroidSession {
  return {
    id: "droid-text-generation-test",
    stream: async function* (prompt: string, options?: MessageOptions) {
      if (typeof hooks === "object" && hooks.onStream) {
        yield* hooks.onStream(prompt, options);
        return;
      }
      for (const message of messages) {
        yield message;
      }
    },
    close: async () => (typeof hooks === "function" ? hooks() : hooks?.onClose?.()),
  } as unknown as DroidSession;
}

describe("parseDroidThreadTitle", () => {
  it("prefers the complete result text over partial assistant deltas", () => {
    expect(
      collectDroidResponseText([
        { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: '{"title":"' },
        { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: "incomplete" },
        {
          type: "result",
          subtype: "success",
          sessionId: "s1",
          durationMs: 1,
          tokenUsage: null,
          messages: [],
          text: '{"title":"Complete title","needsRefinement":false}',
          turnCount: 1,
          success: true,
          interrupted: false,
          error: null,
        },
      ]),
    ).toBe('{"title":"Complete title","needsRefinement":false}');
  });

  it("does not duplicate partial text with the aggregate assistant message", () => {
    expect(
      collectDroidResponseText([
        { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: "hello" },
        {
          type: "assistant",
          message: {
            id: "m1",
            role: "assistant",
            content: [{ type: "text" as never, text: "hello" }],
          } as never,
          text: "hello",
        },
      ]),
    ).toBe("hello");
  });

  it("parses JSON and removes a markdown code fence", () => {
    expect(
      parseDroidThreadTitle(
        '```json\n{"title":"Fix title regeneration","needsRefinement":false}\n```',
      ),
    ).toEqual({
      title: "Fix title regeneration",
      needsRefinement: false,
    });
  });

  it("recovers a title when the JSON response is truncated", () => {
    expect(parseDroidThreadTitle('{"title":"Recoverable title","needsRefinement":false')).toEqual({
      title: "Recoverable title",
      needsRefinement: false,
    });
  });

  it("parses and sanitizes a commit message with a branch", () => {
    expect(
      parseDroidCommitMessage(
        '```json\n{"subject":" Fix commit. ","body":"  Explain the change.  ","branch":"Add UI Fix"}\n```',
        true,
      ),
    ).toEqual({
      subject: "Fix commit",
      body: "Explain the change.",
      branch: "feature/add-ui-fix",
    });
  });

  it("parses and sanitizes pull-request content", () => {
    expect(
      parseDroidPrContent('{"title":" Improve Droid PR ","body":"\\n## Summary\\n- Fixed it\\n"}'),
    ).toEqual({
      title: "Improve Droid PR",
      body: "## Summary\n- Fixed it",
    });
  });

  it("parses and sanitizes a branch name", () => {
    expect(parseDroidBranchName('{"branch":" Fix/Title Generation "}')).toEqual({
      branch: "fix/title-generation",
    });
  });

  it.effect("uses safe session settings and forwards explicit model options", () =>
    Effect.gen(function* () {
      let receivedOptions: CreateSessionOptions | undefined;
      let closed = false;
      const textGeneration = makeDroidTextGeneration({
        settings,
        environment: {},
        createSession: async (options) => {
          receivedOptions = options;
          return fakeSession(
            [
              {
                type: "result",
                subtype: "success",
                sessionId: "s1",
                durationMs: 1,
                tokenUsage: null,
                messages: [],
                text: '{"title":"Safe metadata generation","needsRefinement":false}',
                turnCount: 1,
                success: true,
                interrupted: false,
                error: null,
              },
            ],
            () => {
              closed = true;
            },
          );
        },
      });

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Generate a title",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "default", [
          { id: "reasoningEffort", value: "xhigh" },
        ]),
      });

      expect(result.title).toBe("Safe metadata generation");
      expect(receivedOptions).toMatchObject({
        autonomyLevel: AutonomyLevel.Off,
        autoRejectPermissionRequests: true,
        reasoningEffort: ReasoningEffort.ExtraHigh,
      });
      expect(receivedOptions).not.toHaveProperty("modelId");
      expect(closed).toBe(true);
    }),
  );

  it.effect("uses native structured output with the prompt schema", () =>
    Effect.gen(function* () {
      let streamOptions: MessageOptions | undefined;
      const textGeneration = makeDroidTextGeneration({
        settings,
        environment: {},
        createSession: async () =>
          fakeSession([], {
            onStream: async function* (_prompt, options) {
              streamOptions = options;
              yield {
                type: "result",
                subtype: "success",
                sessionId: "s1",
                durationMs: 1,
                tokenUsage: null,
                messages: [],
                text: "",
                turnCount: 1,
                success: true,
                interrupted: false,
                structuredOutput: {
                  title: "Native title",
                  needsRefinement: false,
                },
                structuredOutputError: null,
                error: null,
              };
            },
          }),
      });

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Generate a title",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "default"),
      });

      expect(result.title).toBe("Native title");
      expect(streamOptions?.outputFormat).toMatchObject({
        type: "json_schema",
        schema: {
          required: ["title", "needsRefinement"],
          properties: {
            title: { type: "string" },
            needsRefinement: { type: "boolean" },
          },
        },
      });
    }),
  );

  it.effect("falls back to result text when structured output is null", () =>
    Effect.gen(function* () {
      const textGeneration = makeDroidTextGeneration({
        settings,
        environment: {},
        createSession: async () =>
          fakeSession([
            {
              type: "result",
              subtype: "success",
              sessionId: "s1",
              durationMs: 1,
              tokenUsage: null,
              messages: [],
              text: '{"title":"Text fallback","needsRefinement":false}',
              turnCount: 1,
              success: true,
              interrupted: false,
              structuredOutput: null,
              structuredOutputError: null,
              error: null,
            },
          ]),
      });

      const result = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Generate a title",
        modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "default"),
      });

      expect(result.title).toBe("Text fallback");
    }),
  );

  it.effect("rejects unsuccessful terminal results even when they contain usable text", () =>
    Effect.gen(function* () {
      const textGeneration = makeDroidTextGeneration({
        settings,
        environment: {},
        createSession: async () =>
          fakeSession([
            {
              type: "result",
              subtype: "error_during_execution",
              sessionId: "s1",
              durationMs: 1,
              tokenUsage: null,
              messages: [],
              text: '{"title":"Do not accept this","needsRefinement":false}',
              turnCount: 1,
              success: false,
              interrupted: false,
              error: null,
            },
          ]),
      });

      const failure = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Generate a title",
          modelSelection: createModelSelection(ProviderInstanceId.make("droid"), "default"),
        })
        .pipe(Effect.flip);

      expect(failure._tag).toBe("TextGenerationError");
      expect(failure.detail).toBe("Droid text generation failed.");
    }),
  );
});
