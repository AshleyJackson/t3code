import * as NodeOS from "node:os";
import {
  ModelProvider,
  ReasoningEffort,
  type ListModelsOptions,
  type ModelInfo,
} from "@factory/droid-sdk";
import { DroidSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import {
  buildDroidModelsFromSdkModels,
  discoverDroidModels,
  makePendingDroidProvider,
} from "./DroidProvider.ts";

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
      readonly execPath?: string;
      readonly cwd?: string;
      readonly env?: Record<string, string>;
    } = {};
    const models = yield* discoverDroidModels(
      settings,
      { DROID_TEST_ENV: "present" },
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
  }),
);
