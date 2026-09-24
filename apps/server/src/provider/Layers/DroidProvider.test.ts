import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ModelProvider,
  ReasoningEffort,
  type ListModelsOptions,
  type ModelInfo,
} from "@factory/droid-sdk";
import { DroidSettings, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  buildDroidModelsFromSdkModels,
  checkDroidProviderStatus,
  discoverDroidModels,
  makePendingDroidProvider,
} from "./DroidProvider.ts";
import { DroidModelCatalogError } from "../droid/DroidModelCatalog.ts";

const decodeDroidSettings = Schema.decodeSync(DroidSettings);

const model = (input: Partial<ModelInfo> = {}): ModelInfo => ({
  id: "factory-default",
  displayName: "Factory Default",
  shortDisplayName: "Default",
  modelProvider: ModelProvider.FACTORY,
  supportedReasoningEfforts: [ReasoningEffort.Low, ReasoningEffort.High],
  defaultReasoningEffort: ReasoningEffort.High,
  isCustom: false,
  ...input,
});

it.effect("reports a disabled Droid provider without probing the CLI", () =>
  Effect.gen(function* () {
    const settings = decodeDroidSettings({
      enabled: false,
      binaryPath: "fake-droid",
    });
    const provider = yield* makePendingDroidProvider(settings);

    assert.equal(provider.enabled, false);
    assert.equal(provider.status, "disabled");
    assert.equal(provider.installed, false);
    assert.equal(provider.message, "Droid is disabled in T3 Code settings.");
  }),
);

it("maps, filters, and deduplicates SDK model catalog entries", () => {
  const models = buildDroidModelsFromSdkModels([
    model(),
    model({
      id: "custom:proxy",
      displayName: "Proxy Model",
      shortDisplayName: "Proxy",
      modelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
      supportedReasoningEfforts: [ReasoningEffort.None],
      defaultReasoningEffort: ReasoningEffort.None,
      isCustom: true,
    }),
    model({ id: "factory-default", displayName: "Duplicate" }),
    {
      ...model({ id: "disabled-model" }),
      disabled: true,
      disabledReason: "Unavailable",
    },
  ]);

  assert.deepStrictEqual(
    models.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      isCustom: entry.isCustom,
      subProvider: entry.subProvider,
    })),
    [
      {
        slug: "factory-default",
        name: "Factory Default",
        isCustom: false,
        subProvider: "Factory",
      },
      {
        slug: "custom:proxy",
        name: "Proxy Model",
        isCustom: true,
        subProvider: "Custom",
      },
    ],
  );
  assert.deepStrictEqual(models[0]?.capabilities?.optionDescriptors?.[0], {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ],
    currentValue: "high",
  });
});

it.effect("passes the configured executable and environment to SDK discovery", () =>
  Effect.gen(function* () {
    const settings = decodeDroidSettings({
      enabled: true,
      binaryPath: "custom-droid",
    });
    let receivedOptions: ListModelsOptions & {
      readonly apiKey?: string;
      readonly execPath?: string;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    } = {};
    const models = yield* discoverDroidModels(
      settings,
      { DROID_TEST_ENV: "present", FACTORY_API_KEY: "test-api-key" },
      {
        sdk: {
          listModels: async (options) => {
            receivedOptions = options ?? {};
            return [model({ id: "discovered-model" })];
          },
        },
      },
    );

    assert.deepStrictEqual(
      models.map((entry) => entry.slug),
      ["discovered-model"],
    );
    assert.equal(receivedOptions.execPath, "custom-droid");
    assert.equal(receivedOptions.cwd, NodeOS.tmpdir());
    assert.equal(receivedOptions.env?.DROID_TEST_ENV, "present");
    assert.equal(receivedOptions.env?.FACTORY_API_KEY, "test-api-key");
    assert.equal(receivedOptions.apiKey, "test-api-key");
  }),
);

it.layer(NodeServices.layer)("checkDroidProviderStatus", (it) => {
  it.effect("uses the catalog when the CLI lacks the model discovery RPC", () =>
    Effect.gen(function* () {
      const settings = decodeDroidSettings({
        enabled: true,
        binaryPath: process.execPath,
      });
      const catalogModels: ReadonlyArray<ServerProviderModel> = [
        {
          slug: "catalog-model",
          name: "Catalog Model",
          isCustom: false,
          capabilities: null,
        },
      ];
      const snapshot = yield* checkDroidProviderStatus(
        settings,
        {},
        {
          sdk: {
            listModels: async () => {
              throw new Error("Unknown method: droid.list_models");
            },
          },
          catalog: {
            models: Effect.succeed(catalogModels),
            blacklistModel: () => undefined,
          },
        },
      );

      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.message, undefined);
      assert.deepStrictEqual(
        snapshot.models.map((entry) => entry.slug),
        ["catalog-model"],
      );
    }),
  );

  it.effect("reports catalog discovery failures instead of claiming readiness", () =>
    Effect.gen(function* () {
      const settings = decodeDroidSettings({
        enabled: true,
        binaryPath: process.execPath,
      });
      const snapshot = yield* checkDroidProviderStatus(
        settings,
        {},
        {
          catalog: {
            models: Effect.fail(
              new DroidModelCatalogError({
                message: "Authentication error",
              }),
            ),
            blacklistModel: () => undefined,
          },
        },
      );

      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.message, "Droid model discovery failed: Authentication error");
      assert.deepStrictEqual(
        snapshot.models.map((entry) => entry.slug),
        ["default"],
      );
    }),
  );
});
