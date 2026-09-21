import { DroidSettings, ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDroidAdapter } from "../Layers/DroidAdapter.ts";
import { checkDroidProviderStatus, makePendingDroidProvider } from "../Layers/DroidProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeDroidModelCatalog } from "../droid/DroidModelCatalog.ts";

type TextGenerationService = TextGeneration["Service"];

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const DRIVER_KIND = ProviderDriverKind.make("droid");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

function makeUnsupportedTextGeneration(): TextGenerationService {
  const fail = (operation: TextGenerationError["operation"]) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Droid SDK text generation is not enabled in this WIP.",
      }),
    );
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
}

export type DroidDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ServerConfig
  | ServerSettingsService;

export const DroidDriver: ProviderDriver<DroidSettings, DroidDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Droid",
    supportsMultipleInstances: true,
  },
  configSchema: DroidSettings,
  defaultConfig: (): DroidSettings => decodeDroidSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies DroidSettings;
      const adapter = yield* makeDroidAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      });
      const catalog = yield* makeDroidModelCatalog;
      const checkProvider = checkDroidProviderStatus(effectiveConfig, processEnv, {
        catalog,
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshot = yield* makeManagedServerProvider<DroidSettings>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingDroidProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Droid snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
