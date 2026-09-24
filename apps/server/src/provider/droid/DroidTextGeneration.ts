import {
  AutonomyLevel,
  createSession,
  type CreateSessionOptions,
  type DroidSession,
  type DroidStreamEvent,
} from "@factory/droid-sdk/node";
import { TextGenerationError, type DroidSettings, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../../textGeneration/TextGenerationUtils.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { toModelId, toReasoningEffort } from "./DroidSdkMappings.ts";

function assistantText(message: DroidStreamEvent): string | undefined {
  if (message.type === "assistant_text_delta") {
    return message.text;
  }
  if (message.type !== "assistant") {
    return undefined;
  }
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text;
  }
  return message.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function asJsonSchemaObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Droid text generation produced an invalid JSON Schema.");
  }
  return value as Record<string, unknown>;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function collectDroidResponse(messages: Iterable<DroidStreamEvent>): {
  readonly text: string;
  readonly structuredOutput: unknown;
} {
  let partialText = "";
  let assistantMessageText = "";
  let resultText: string | undefined;
  let hasStructuredOutput = false;
  let structuredOutput: unknown;
  for (const message of messages) {
    if (message.type === "result") {
      if (!message.success) {
        throw new Error(
          message.interrupted
            ? "Droid text generation was interrupted."
            : (message.structuredOutputError?.message ??
                message.error?.message ??
                "Droid text generation failed."),
        );
      }
      if (message.structuredOutput !== undefined && message.structuredOutput !== null) {
        hasStructuredOutput = true;
        structuredOutput = message.structuredOutput;
      }
      if (message.text.trim().length > 0) {
        resultText = message.text;
      }
      continue;
    }
    const text = assistantText(message) ?? "";
    if (message.type === "assistant_text_delta") {
      partialText += text;
    } else {
      assistantMessageText += text;
    }
  }
  return {
    text: resultText ?? (partialText.length > 0 ? partialText : assistantMessageText),
    structuredOutput: hasStructuredOutput ? structuredOutput : undefined,
  };
}

export function collectDroidResponseText(messages: Iterable<DroidStreamEvent>): string {
  return collectDroidResponse(messages).text;
}

export function parseDroidThreadTitle(raw: string): {
  readonly title: string;
  readonly needsRefinement: boolean;
} {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  if (normalized.length === 0) {
    throw new Error("Droid returned an empty title response.");
  }

  try {
    const parsed = JSON.parse(normalized) as {
      readonly title?: unknown;
      readonly needsRefinement?: unknown;
    };
    if (typeof parsed.title === "string" && parsed.title.trim().length > 0) {
      return {
        title: sanitizeThreadTitle(parsed.title),
        needsRefinement: parsed.needsRefinement === true,
      };
    }
  } catch {
    // Droid occasionally closes the stream before emitting the final JSON
    // brace. Recover the completed title field when it is still present.
  }

  const titleField = normalized.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/isu)?.[1];
  if (titleField) {
    const title = JSON.parse(`"${titleField}"`) as string;
    if (title.trim().length > 0) {
      return { title: sanitizeThreadTitle(title), needsRefinement: false };
    }
  }

  throw new Error("Droid returned a title response without a usable title.");
}

function parseDroidJson(raw: string): Record<string, unknown> {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const parsed = JSON.parse(normalized) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Droid returned a non-object JSON response.");
  }
  return parsed as Record<string, unknown>;
}

export function parseDroidCommitMessage(
  raw: string,
  includeBranch: boolean,
): { readonly subject: string; readonly body: string; readonly branch?: string } {
  const parsed = parseDroidJson(raw);
  if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") {
    throw new Error("Droid returned an invalid commit-message response.");
  }
  return {
    subject: sanitizeCommitSubject(parsed.subject),
    body: parsed.body.trim(),
    ...(includeBranch && typeof parsed.branch === "string"
      ? { branch: sanitizeFeatureBranchName(parsed.branch) }
      : {}),
  };
}

export function parseDroidPrContent(raw: string): {
  readonly title: string;
  readonly body: string;
} {
  const parsed = parseDroidJson(raw);
  if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
    throw new Error("Droid returned an invalid pull-request response.");
  }
  return {
    title: sanitizePrTitle(parsed.title),
    body: parsed.body.trim(),
  };
}

export function parseDroidBranchName(raw: string): { readonly branch: string } {
  const parsed = parseDroidJson(raw);
  if (typeof parsed.branch !== "string") {
    throw new Error("Droid returned an invalid branch-name response.");
  }
  return { branch: sanitizeBranchFragment(parsed.branch) };
}

export function makeDroidTextGeneration(input: {
  readonly settings: DroidSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly createSession?: (options?: CreateSessionOptions) => Promise<DroidSession>;
}) {
  const startSession = input.createSession ?? createSession;
  const runPrompt = <A>(
    operation: TextGenerationError["operation"],
    request: { readonly modelSelection: ModelSelection; readonly cwd: string },
    prompt: string,
    outputSchema: Schema.Top,
    parse: (raw: string) => A,
  ) =>
    Effect.gen(function* () {
      const environment = Object.fromEntries(
        Object.entries(input.environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      const modelId = toModelId(request.modelSelection.model);
      const reasoningEffort = toReasoningEffort(
        getModelSelectionStringOptionValue(request.modelSelection, "reasoningEffort"),
      );
      const outputFormat = {
        type: "json_schema" as const,
        schema: asJsonSchemaObject(toJsonSchemaObject(outputSchema)),
      };
      const session = yield* Effect.tryPromise({
        try: () =>
          startSession({
            execPath: input.settings.binaryPath,
            env: environment,
            ...(input.environment.FACTORY_API_KEY
              ? { apiKey: input.environment.FACTORY_API_KEY }
              : {}),
            cwd: request.cwd,
            ...(modelId ? { modelId } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            autonomyLevel: AutonomyLevel.Off,
            autoRejectPermissionRequests: true,
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: cause instanceof Error ? cause.message : "Failed to start Droid text session.",
            cause,
          }),
      });

      return yield* Effect.tryPromise({
        try: async () => {
          const messages: DroidStreamEvent[] = [];
          for await (const message of session.stream(prompt, {
            includePartialMessages: true,
            outputFormat,
          })) {
            messages.push(message);
          }
          const response = collectDroidResponse(messages);
          return parse(
            response.structuredOutput !== undefined
              ? encodeJson(response.structuredOutput)
              : response.text,
          );
        },
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: cause instanceof Error ? cause.message : "Droid failed during text generation.",
            cause,
          }),
      }).pipe(Effect.ensuring(Effect.promise(() => session.close())));
    });

  const generateThreadTitle: TextGeneration["Service"]["generateThreadTitle"] = Effect.fn(
    "DroidTextGeneration.generateThreadTitle",
  )(function* (request) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: request.message,
      previousTitle: request.previousTitle,
      linkedContext: request.linkedContext,
      attachments: request.attachments,
    });
    return yield* runPrompt(
      "generateThreadTitle",
      request,
      prompt,
      outputSchema,
      parseDroidThreadTitle,
    );
  });

  const generateCommitMessage: TextGeneration["Service"]["generateCommitMessage"] = Effect.fn(
    "DroidTextGeneration.generateCommitMessage",
  )(function* (request) {
    const { prompt, outputSchema } = buildCommitMessagePrompt(request);
    return yield* runPrompt("generateCommitMessage", request, prompt, outputSchema, (raw) =>
      parseDroidCommitMessage(raw, request.includeBranch === true),
    );
  });

  const generatePrContent: TextGeneration["Service"]["generatePrContent"] = Effect.fn(
    "DroidTextGeneration.generatePrContent",
  )(function* (request) {
    const { prompt, outputSchema } = buildPrContentPrompt(request);
    return yield* runPrompt(
      "generatePrContent",
      request,
      prompt,
      outputSchema,
      parseDroidPrContent,
    );
  });

  const generateBranchName: TextGeneration["Service"]["generateBranchName"] = Effect.fn(
    "DroidTextGeneration.generateBranchName",
  )(function* (request) {
    const { prompt, outputSchema } = buildBranchNamePrompt(request);
    return yield* runPrompt(
      "generateBranchName",
      request,
      prompt,
      outputSchema,
      parseDroidBranchName,
    );
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration["Service"];
}
