import * as NodeOS from "node:os";
import { type ListModelsOptions, ModelProvider, type ModelInfo } from "@factory/droid-sdk";
import { listModels } from "@factory/droid-sdk/node";
import { type DroidSettings, type ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { DroidModelCatalog } from "../droid/DroidModelCatalog.ts";
import { debugDroid } from "../droid/DroidDebug.ts";
import { REASONING_EFFORT_LABELS } from "../droid/DroidSdkMappings.ts";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DROID_PRESENTATION = {
  displayName: "Droid",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  supportsConversationRollback: false,
} as const;
const DROID_CLI_TIMEOUT_MS = 10_000;
const DROID_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const DROID_FALLBACK_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
    }),
  ],
});

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Factory default",
    shortName: "Default",
    isCustom: false,
    capabilities: DROID_FALLBACK_MODEL_CAPABILITIES,
  },
];

interface DroidProviderSdk {
  readonly listModels: (
    options?: ListModelsOptions & {
      readonly execPath?: string;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    },
  ) => Promise<ReadonlyArray<ModelInfo>>;
}

interface DroidProviderStatusOptions {
  readonly sdk?: DroidProviderSdk;
  /** Docs-collected catalog used as the model source when SDK discovery is unavailable. */
  readonly catalog?: DroidModelCatalog;
}

export class DroidModelDiscoveryError extends Data.TaggedError("DroidModelDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const defaultSdk: DroidProviderSdk = { listModels };

const modelProviderLabel = (provider: ModelProvider): string => {
  switch (provider) {
    case ModelProvider.ANTHROPIC:
      return "Anthropic";
    case ModelProvider.OPENAI:
      return "OpenAI";
    case ModelProvider.GENERIC_CHAT_COMPLETION_API:
      return "Custom";
    case ModelProvider.FACTORY:
      return "Factory";
    case ModelProvider.GOOGLE:
      return "Google";
    case ModelProvider.XAI:
      return "xAI";
    case ModelProvider.VOYAGE:
      return "Voyage";
    default:
      return provider;
  }
};

const compactEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
};

function droidModelCapabilities(model: ModelInfo) {
  const options = model.supportedReasoningEfforts.map((effort) => ({
    value: effort,
    label: REASONING_EFFORT_LABELS[effort] ?? effort,
    isDefault: effort === model.defaultReasoningEffort,
  }));
  return createModelCapabilities({
    optionDescriptors:
      options.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoningEffort",
              label: "Reasoning",
              options,
            }),
          ]
        : [],
  });
}

function droidModelToServerModel(model: ModelInfo): ServerProviderModel | null {
  if (model.disabled === true || model.id.trim().length === 0) return null;
  const name = model.displayName.trim() || model.id;
  const shortName = model.shortDisplayName.trim();
  return {
    slug: model.id,
    name,
    ...(shortName && shortName !== name ? { shortName } : {}),
    subProvider: modelProviderLabel(model.modelProvider),
    isCustom: model.isCustom,
    capabilities: droidModelCapabilities(model),
  };
}

export function buildDroidModelsFromSdkModels(
  models: ReadonlyArray<ModelInfo> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const resolved: ServerProviderModel[] = [];
  for (const model of models ?? []) {
    const entry = droidModelToServerModel(model);
    if (!entry || seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    resolved.push(entry);
  }
  return resolved;
}

export const discoverDroidModels = (
  settings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  options?: DroidProviderStatusOptions,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, DroidModelDiscoveryError> =>
  Effect.tryPromise({
    try: () => {
      const apiKey = environment.FACTORY_API_KEY?.trim() || undefined;
      return (options?.sdk ?? defaultSdk).listModels({
        cwd: NodeOS.tmpdir(),
        execPath: settings.binaryPath,
        env: compactEnvironment(environment),
        ...(apiKey ? { apiKey } : {}),
      });
    },
    catch: (cause) =>
      new DroidModelDiscoveryError({
        message: cause instanceof Error ? cause.message : "Failed to discover Droid models.",
        cause,
      }),
  }).pipe(Effect.map(buildDroidModelsFromSdkModels));

const modelsWithSettingsFallback = (
  sdkModels: ReadonlyArray<ServerProviderModel>,
  settings: DroidSettings,
): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(
    sdkModels.length > 0 ? sdkModels : FALLBACK_MODELS,
    settings.customModels,
    DROID_FALLBACK_MODEL_CAPABILITIES,
  );

export function makePendingDroidProvider(
  settings: DroidSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: modelsWithSettingsFallback([], settings),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Droid availability..."
          : "Droid is disabled in T3 Code settings.",
      },
    });
  });
}

export function checkDroidProviderStatus(
  settings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  options?: DroidProviderStatusOptions,
): Effect.Effect<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const catalogModels =
      options?.catalog?.models ?? Effect.succeed<ReadonlyArray<ServerProviderModel>>([]);
    const fallbackModels = catalogModels.pipe(
      Effect.orElseSucceed((): ReadonlyArray<ServerProviderModel> => []),
      Effect.map((models) => modelsWithSettingsFallback(models, settings)),
    );

    if (!settings.enabled) {
      return yield* makePendingDroidProvider(settings);
    }

    const command = ChildProcess.make(settings.binaryPath, ["--version"], {
      env: environment,
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Provider snapshot probes run outside the Effect runtime service graph.
      shell: process.platform === "win32",
    });
    const result = yield* spawnAndCollect(settings.binaryPath, command).pipe(
      Effect.timeoutOption(DROID_CLI_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(result)) {
      const cause = result.failure;
      const missing = isCommandMissingCause(cause);
      const message = cause instanceof Error ? cause.message : String(cause);
      return buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: true,
        checkedAt,
        models: yield* fallbackModels,
        probe: {
          installed: !missing,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: missing
            ? "Droid CLI (`droid`) is not installed or not on PATH."
            : `Failed to execute Droid CLI health check: ${message}.`,
        },
      });
    }

    if (Option.isNone(result.success)) {
      return buildServerProvider({
        presentation: DROID_PRESENTATION,
        enabled: true,
        checkedAt,
        models: yield* fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Timed out while checking Droid CLI availability.",
        },
      });
    }

    const commandResult = result.success.value;
    const detail = commandResult.stderr.trim() || commandResult.stdout.trim();
    const discoveredModels =
      commandResult.code === 0
        ? yield* catalogModels.pipe(
            Effect.timeoutOption(DROID_MODEL_DISCOVERY_TIMEOUT_MS),
            Effect.result,
          )
        : Result.succeed(Option.none<ReadonlyArray<ServerProviderModel>>());
    const modelDiscoveryUnsupported =
      Result.isFailure(discoveredModels) &&
      /unknown method:\s*droid\.list_models/iu.test(discoveredModels.failure.message);
    const modelDiscoveryFailed =
      commandResult.code === 0 &&
      !modelDiscoveryUnsupported &&
      (Result.isFailure(discoveredModels) ||
        (Result.isSuccess(discoveredModels) && Option.isNone(discoveredModels.success)));
    const discoveryMessage = modelDiscoveryUnsupported
      ? undefined
      : Result.isFailure(discoveredModels)
        ? discoveredModels.failure.message
        : modelDiscoveryFailed
          ? "Timed out while discovering Droid models."
          : undefined;
    const models =
      Result.isSuccess(discoveredModels) && Option.isSome(discoveredModels.success)
        ? modelsWithSettingsFallback(discoveredModels.success.value, settings)
        : commandResult.code === 0
          ? modelsWithSettingsFallback([], settings)
          : yield* fallbackModels;
    debugDroid("provider.status", {
      commandCode: commandResult.code,
      modelCount: models.length,
      modelDiscoveryUnsupported,
      modelDiscoveryFailed,
      ...(discoveryMessage ? { discoveryMessage } : {}),
    });

    return buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: commandResult.code === 0,
        version: parseGenericCliVersion(commandResult.stdout || commandResult.stderr),
        status: commandResult.code === 0 && !modelDiscoveryFailed ? "ready" : "warning",
        auth: { status: commandResult.code === 0 ? "unknown" : "unauthenticated" },
        ...(commandResult.code === 0 && discoveryMessage
          ? { message: `Droid model discovery failed: ${discoveryMessage}` }
          : commandResult.code === 0
            ? {}
            : {
                message: detail || "Failed to check Droid CLI availability.",
              }),
      },
    });
  });
}
