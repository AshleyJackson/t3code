import { AutonomyLevel, createSession, type DroidStreamEvent } from "@factory/droid-sdk/node";
import { TextGenerationError, type DroidSettings, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

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

export function parseDroidThreadTitle(raw: string): {
  readonly title: string;
  readonly needsRefinement: boolean;
} {
  const normalized = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const parsed = JSON.parse(normalized) as {
    readonly title?: unknown;
    readonly needsRefinement?: unknown;
  };
  if (typeof parsed.title !== "string" || parsed.title.trim().length === 0) {
    throw new Error("Droid returned a title response without a title.");
  }
  return {
    title: sanitizeThreadTitle(parsed.title),
    needsRefinement: parsed.needsRefinement === true,
  };
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
}) {
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
      const modelId = request.modelSelection.model;
      const session = yield* Effect.tryPromise({
        try: () =>
          createSession({
            execPath: input.settings.binaryPath,
            env: environment,
            ...(input.environment.FACTORY_API_KEY
              ? { apiKey: input.environment.FACTORY_API_KEY }
              : {}),
            cwd: request.cwd,
            ...(modelId ? { modelId } : {}),
            autonomyLevel: AutonomyLevel.Low,
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
          let output = "";
          for await (const message of session.stream(prompt, {
            includePartialMessages: true,
          })) {
            output += assistantText(message) ?? "";
          }
          return parse(output);
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
