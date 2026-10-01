import {
  AutonomyLevel,
  createSession,
  type CreateSessionOptions,
  type DroidSession,
  type DroidStreamEvent,
} from "@factory/droid-sdk/node";
import { TextGenerationError, type DroidSettings, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

function collectDroidResponse(messages: Iterable<DroidStreamEvent>): string {
  let partialText = "";
  let assistantMessageText = "";
  let resultText: string | undefined;
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
  return resultText ?? (partialText.length > 0 ? partialText : assistantMessageText);
}

export function collectDroidResponseText(messages: Iterable<DroidStreamEvent>): string {
  return collectDroidResponse(messages);
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
      const runAttempt = async () => {
        const session = await startSession({
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
        });
        try {
          const messages: DroidStreamEvent[] = [];
          for await (const message of session.stream(prompt, { includePartialMessages: false })) {
            messages.push(message);
          }
          const response = collectDroidResponse(messages);
          return parse(response);
        } finally {
          await session.close();
        }
      };

      return yield* Effect.tryPromise({
        try: runAttempt,
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: cause instanceof Error ? cause.message : "Droid failed during text generation.",
            cause,
          }),
      });
    });

  const generateThreadTitle: TextGeneration["Service"]["generateThreadTitle"] = Effect.fn(
    "DroidTextGeneration.generateThreadTitle",
  )(function* (request) {
    const { prompt } = buildThreadTitlePrompt({
      message: request.message,
      previousTitle: request.previousTitle,
      linkedContext: request.linkedContext,
      attachments: request.attachments,
    });
    return yield* runPrompt("generateThreadTitle", request, prompt, parseDroidThreadTitle);
  });

  const generateCommitMessage: TextGeneration["Service"]["generateCommitMessage"] = Effect.fn(
    "DroidTextGeneration.generateCommitMessage",
  )(function* (request) {
    const { prompt } = buildCommitMessagePrompt(request);
    return yield* runPrompt("generateCommitMessage", request, prompt, (raw) =>
      parseDroidCommitMessage(raw, request.includeBranch === true),
    );
  });

  const generatePrContent: TextGeneration["Service"]["generatePrContent"] = Effect.fn(
    "DroidTextGeneration.generatePrContent",
  )(function* (request) {
    const { prompt } = buildPrContentPrompt(request);
    return yield* runPrompt("generatePrContent", request, prompt, parseDroidPrContent);
  });

  const generateBranchName: TextGeneration["Service"]["generateBranchName"] = Effect.fn(
    "DroidTextGeneration.generateBranchName",
  )(function* (request) {
    const { prompt } = buildBranchNamePrompt(request);
    return yield* runPrompt("generateBranchName", request, prompt, parseDroidBranchName);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration["Service"];
}
