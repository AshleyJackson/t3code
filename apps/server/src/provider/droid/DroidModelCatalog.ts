import { listModels, type ModelInfo } from "@factory/droid-sdk/node";
import { type DroidSettings, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { REASONING_EFFORT_LABELS } from "./DroidSdkMappings.ts";

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 15_000;
const MODEL_BLACKLIST_TTL_MS = 48 * 60 * 60 * 1000;

export class DroidModelCatalogError extends Data.TaggedError("DroidModelCatalogError")<{
  readonly message: string;
}> {}

function modelProviderLabel(provider: ModelInfo["modelProvider"]): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "xai":
      return "xAI";
    case "factory":
      return "Factory";
    default:
      return provider;
  }
}

export function mapDroidModelInfo(model: ModelInfo): ServerProviderModel {
  const efforts = model.supportedReasoningEfforts;
  return {
    slug: model.id,
    name: model.displayName,
    subProvider: modelProviderLabel(model.modelProvider),
    isCustom: model.isCustom === true,
    capabilities: createModelCapabilities({
      optionDescriptors:
        efforts.length > 0
          ? [
              buildSelectOptionDescriptor({
                id: "reasoningEffort",
                label: "Reasoning",
                options: efforts.map((effort) => ({
                  value: effort,
                  label: REASONING_EFFORT_LABELS[effort] ?? effort,
                  isDefault: effort === model.defaultReasoningEffort,
                })),
              }),
            ]
          : [],
    }),
  };
}

export interface DroidModelCatalog {
  /** Models reported by the installed Droid SDK, refreshed at most once a day. */
  readonly models: Effect.Effect<ReadonlyArray<ServerProviderModel>, DroidModelCatalogError>;
  readonly blacklistModel: (modelId: string) => void;
}

export function makeDroidModelCatalog(input: {
  readonly settings: DroidSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly listModels?: typeof listModels;
}) {
  let cache: { fetchedAtMillis: number; models: ReadonlyArray<ServerProviderModel> } | undefined;
  const blacklistedModels = new Map<string, number>();
  const discoverModels = input.listModels ?? listModels;
  const filterBlacklistedModels = (
    candidateModels: ReadonlyArray<ServerProviderModel>,
    now: number,
  ) => {
    for (const [modelId, expiresAt] of blacklistedModels) {
      if (expiresAt <= now) blacklistedModels.delete(modelId);
    }
    return candidateModels.filter((model) => !blacklistedModels.has(model.slug));
  };

  const models = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cache !== undefined && now - cache.fetchedAtMillis < CATALOG_TTL_MS) {
      return filterBlacklistedModels(cache.models, now);
    }

    const environment = Object.fromEntries(
      Object.entries(input.environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const fetched = yield* Effect.tryPromise({
      try: () =>
        discoverModels({
          includeDisabled: false,
          execPath: input.settings.binaryPath,
          env: environment,
          ...(input.environment.FACTORY_API_KEY
            ? { apiKey: input.environment.FACTORY_API_KEY }
            : {}),
        }),
      catch: (cause) =>
        new DroidModelCatalogError({
          message: cause instanceof Error ? cause.message : "Failed to discover Droid models.",
        }),
    }).pipe(Effect.timeout(CATALOG_FETCH_TIMEOUT_MS), Effect.result);

    const fresh = Result.isSuccess(fetched)
      ? fetched.success.filter((model) => model.disabled !== true).map(mapDroidModelInfo)
      : undefined;
    if (fresh === undefined || fresh.length === 0) {
      if (cache !== undefined) return filterBlacklistedModels(cache.models, now);
      return yield* new DroidModelCatalogError({
        message: "Droid model discovery returned no selectable models.",
      });
    }

    cache = { fetchedAtMillis: now, models: fresh };
    return filterBlacklistedModels(fresh, now);
  });

  const blacklistModel = (modelId: string): void => {
    // @effect-diagnostics-next-line globalDate:off
    blacklistedModels.set(modelId, Date.now() + MODEL_BLACKLIST_TTL_MS);
  };

  return { models, blacklistModel } satisfies DroidModelCatalog;
}
