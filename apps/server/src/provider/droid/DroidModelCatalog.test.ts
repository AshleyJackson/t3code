import { listModels, ModelProvider, ReasoningEffort } from "@factory/droid-sdk/node";
import { DroidSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";

import { makeDroidModelCatalog, mapDroidModelInfo } from "./DroidModelCatalog.ts";

const settings = DroidSettings.make({
  enabled: true,
  binaryPath: "droid",
  customModels: [],
});

const model = {
  id: "grok-4.6",
  displayName: "Grok 4.6",
  shortDisplayName: "Grok",
  modelProvider: ModelProvider.XAI,
  supportedReasoningEfforts: [ReasoningEffort.Low, ReasoningEffort.High],
  defaultReasoningEffort: ReasoningEffort.High,
  isCustom: false,
  noImageSupport: false,
  supportsImageGeneration: false,
};

it("maps SDK model metadata into a T3 provider model", () => {
  assert.deepStrictEqual(mapDroidModelInfo(model), {
    slug: "grok-4.6",
    name: "Grok 4.6",
    subProvider: "xAI",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ],
          currentValue: "high",
        },
      ],
    },
  });
});

it.effect("caches SDK model discovery for 24 hours", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    let fetches = 0;
    const catalog = makeDroidModelCatalog({
      settings,
      environment: { FACTORY_API_KEY: "test-key" },
      listModels: (() => {
        fetches += 1;
        return Promise.resolve([model]);
      }) as typeof listModels,
    });

    const first = yield* catalog.models;
    assert.equal(fetches, 1);
    yield* TestClock.setTime(12 * 60 * 60 * 1000);
    assert.deepStrictEqual(yield* catalog.models, first);
    assert.equal(fetches, 1);
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    yield* catalog.models;
    assert.equal(fetches, 2);
    catalog.blacklistModel(model.id);
    assert.deepStrictEqual(yield* catalog.models, []);
  }),
);

it.effect("fails when SDK discovery is unavailable without a cache", () =>
  Effect.gen(function* () {
    const catalog = makeDroidModelCatalog({
      settings,
      environment: {},
      listModels: (() => Promise.reject(new Error("Authentication error"))) as typeof listModels,
    });
    const failure = yield* catalog.models.pipe(Effect.flip);
    assert.equal(failure._tag, "DroidModelCatalogError");
  }),
);

it.effect("keeps blacklisted models out of stale-cache fallbacks", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    let fetches = 0;
    const catalog = makeDroidModelCatalog({
      settings,
      environment: {},
      listModels: (() => {
        fetches += 1;
        return fetches === 1
          ? Promise.resolve([model])
          : Promise.reject(new Error("Model discovery unavailable"));
      }) as typeof listModels,
    });

    assert.deepStrictEqual(
      (yield* catalog.models).map((entry) => entry.slug),
      [model.id],
    );
    catalog.blacklistModel(model.id);
    yield* TestClock.setTime(24 * 60 * 60 * 1000);

    assert.deepStrictEqual(yield* catalog.models, []);
    assert.equal(fetches, 2);
  }),
);
