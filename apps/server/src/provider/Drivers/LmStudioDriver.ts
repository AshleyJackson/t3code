import { LmStudioSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeLmStudioTextGeneration } from "../../textGeneration/LmStudioTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeLmStudioAdapter } from "../Layers/LmStudioAdapter.ts";
import {
  buildInitialLmStudioProviderSnapshot,
  checkLmStudioProviderStatus,
} from "../Layers/LmStudioProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { haveProviderSnapshotSettingsChanged } from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("lmstudio");
const decodeSettings = Schema.decodeSync(LmStudioSettings);

export type LmStudioDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | HttpClient.HttpClient
  | ServerSettingsService;

export const LmStudioDriver: ProviderDriver<LmStudioSettings, LmStudioDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "LM Studio", supportsMultipleInstances: true },
  configSchema: LmStudioSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
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
      const effectiveConfig = { ...config, enabled } satisfies LmStudioSettings;
      const adapter = yield* makeLmStudioAdapter(effectiveConfig, { instanceId });
      const textGeneration = yield* makeLmStudioTextGeneration.pipe(
        Effect.map((make) => make(effectiveConfig)),
      );
      const source = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<LmStudioSettings>>(
        {
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER_KIND,
                packageName: null,
              }),
            ),
          getSettings: source.getSettings,
          streamSettings: source.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialLmStudioProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider: checkLmStudioProviderStatus(effectiveConfig).pipe(
            Effect.map(stampIdentity),
          ),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build LM Studio snapshot: ${cause.message ?? String(cause)}`,
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
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
