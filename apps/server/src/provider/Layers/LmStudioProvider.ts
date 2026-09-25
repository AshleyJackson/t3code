import type { LmStudioSettings, ModelCapabilities, ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { listLmStudioModels } from "../lmstudio/LmStudioApi.ts";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const PRESENTATION = {
  displayName: "LM Studio",
  supportsConversationRollback: true,
  showInteractionModeToggle: false,
} as const;

export function buildInitialLmStudioProviderSnapshot(
  settings: LmStudioSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: settings.enabled ? "warning" : "warning",
        auth: {
          status: settings.apiKey ? "authenticated" : "unknown",
          type: "api_key",
          label: "LM Studio",
        },
        message: settings.enabled
          ? "Checking LM Studio server availability..."
          : "LM Studio is disabled in T3 Code settings.",
      },
    }),
  );
}

export const checkLmStudioProviderStatus = (
  settings: LmStudioSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: false,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "LM Studio is disabled in T3 Code settings.",
        },
      });
    }
    const probe = yield* listLmStudioModels(settings.baseUrl, settings.apiKey).pipe(
      Effect.map((entries) => ({ reachable: true, entries })),
      Effect.orElseSucceed(() => ({ reachable: false, entries: [] })),
    );
    const models = providerModelsFromSettings(
      probe.entries.map((entry) => ({
        slug: entry.id,
        name: entry.id,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      })),
      settings.customModels,
      EMPTY_CAPABILITIES,
    );
    const reachable = probe.reachable;
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: reachable,
        version: null,
        status: reachable ? "ready" : "error",
        auth: settings.apiKey
          ? {
              status: reachable ? "authenticated" : "unknown",
              type: "api_key",
              label: "LM Studio API key",
            }
          : { status: "unknown" },
        ...(reachable
          ? models.some((model) => !model.isCustom)
            ? {}
            : { message: "LM Studio is reachable, but no models are currently available." }
          : { message: `Could not reach LM Studio at ${settings.baseUrl}.` }),
      },
    });
  });

export function enrichLmStudioSnapshot(input: {
  readonly snapshot: ServerProvider;
  readonly settings: LmStudioSettings;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<void> {
  return checkLmStudioProviderStatus(input.settings).pipe(
    Effect.map((next) => ({
      ...next,
      instanceId: input.snapshot.instanceId,
      driver: input.snapshot.driver,
    })),
    Effect.flatMap(input.publishSnapshot),
    Effect.asVoid,
  );
}
