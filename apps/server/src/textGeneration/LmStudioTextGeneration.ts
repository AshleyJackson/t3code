// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type LmStudioSettings,
  TextGenerationError,
  type ModelSelection,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { collectLmStudioChat } from "../provider/lmstudio/LmStudioApi.ts";

export const makeLmStudioTextGeneration = Effect.succeed(
  (settings: LmStudioSettings): TextGeneration.TextGeneration["Service"] => {
    const runJson = <S extends Schema.Top>(input: {
      operation:
        | "generateCommitMessage"
        | "generatePrContent"
        | "generateBranchName"
        | "generateThreadTitle";
      prompt: string;
      outputSchema: S;
      modelSelection: ModelSelection;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      collectLmStudioChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: input.modelSelection.model,
        messages: [
          {
            role: "user",
            content: `${input.prompt}\n\nReturn only valid JSON matching the requested output shape.`,
          },
        ],
      }).pipe(
        Effect.timeout("180 seconds"),
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(input.outputSchema)(
            JSON.parse(extractJsonObject(response.content)),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "LM Studio returned invalid structured output.",
              cause,
            }),
        ),
      );

    return {
      generateCommitMessage: (input) => {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        return runJson({
          operation: "generateCommitMessage",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(
          Effect.map((value) => ({
            subject: sanitizeCommitSubject(value.subject),
            body: value.body.trim(),
            ...("branch" in value && typeof value.branch === "string"
              ? { branch: sanitizeFeatureBranchName(value.branch) }
              : {}),
          })),
        );
      },
      generatePrContent: (input) => {
        const { prompt, outputSchema } = buildPrContentPrompt(input);
        return runJson({
          operation: "generatePrContent",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(
          Effect.map((value) => ({ title: sanitizePrTitle(value.title), body: value.body.trim() })),
        );
      },
      generateBranchName: (input) => {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        return runJson({
          operation: "generateBranchName",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(Effect.map((value) => ({ branch: sanitizeBranchFragment(value.branch) })));
      },
      generateThreadTitle: (input) => {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          linkedContext: input.linkedContext,
          attachments: input.attachments,
        });
        return runJson({
          operation: "generateThreadTitle",
          prompt,
          outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(
          Effect.map((value) => ({
            title: sanitizeThreadTitle(value.title),
            ...(value.needsRefinement ? { needsRefinement: true } : {}),
          })),
        );
      },
    };
  },
);
