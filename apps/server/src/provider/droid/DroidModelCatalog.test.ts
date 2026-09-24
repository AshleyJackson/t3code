import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeDroidModelCatalog, parseFactoryModelsMarkdown } from "./DroidModelCatalog.ts";

const DOCS_MARKDOWN = [
  "# Available Models",
  "",
  "## ![Anthropic logo](https://docs.factory.ai/icon.png)Anthropic",
  "",
  "| Model | Model ID | Multiplier | Reasoning |",
  "| --- | --- | --- | --- |",
  "| Claude Fable 5.1\\* | `claude-fable-5.1` | 4× | `off`, `low`, `medium`, `high` (default), `xhigh`, `max` |",
  "| Claude Opus 4.5 | `claude-opus-4-5-20251101` | 2× | `off` (default), `low`, `medium`, `high` |",
  "| Claude Opus 4.5 | `claude-opus-4-5-20251101` | 2× | `off` (default), `low` |",
  "",
  "## Droid Core (Open Models)",
  "",
  "| Model | Model ID | Multiplier | Reasoning |",
  "| --- | --- | --- | --- |",
  "| GLM-5.3 | `glm-5.3` | 0.56× | `low`, `high`, `max` (default) |",
  "| MiniMax M2.7‡ | `minimax-m2.7` | 0.12× | `high` (default) |",
  "",
  "## Custom models",
  "",
  "| Model | Model ID |",
  "| --- | --- |",
  "| BYOK model | `byok-model` |",
].join("\n");

it("parses sections, effort defaults, and filters deprecated models from the doc", () => {
  const models = parseFactoryModelsMarkdown(DOCS_MARKDOWN);

  assert.deepStrictEqual(
    models.map((model) => ({
      slug: model.slug,
      name: model.name,
      subProvider: model.subProvider,
    })),
    [
      { slug: "claude-fable-5.1", name: "Claude Fable 5.1", subProvider: "Anthropic" },
      { slug: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", subProvider: "Anthropic" },
      { slug: "glm-5.3", name: "GLM-5.3", subProvider: "Factory" },
    ],
  );

  assert.deepStrictEqual(models[0]?.capabilities?.optionDescriptors?.[0], {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "off", label: "Off" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    currentValue: "high",
  });
});

it("parses the HTML headings and footnote tags used by the live catalog", () => {
  const models = parseFactoryModelsMarkdown(
    [
      '## <span className="provider-heading">Anthropic</span>',
      "",
      "| Model | Model ID | Multiplier | Reasoning |",
      "| --- | --- | --- | --- |",
      "| Claude Fable 5.1<sup>\\*</sup> | `claude-fable-5.1` | 4× | `high` (default) |",
    ].join("\n"),
  );

  assert.deepStrictEqual(
    models.map((model) => ({
      slug: model.slug,
      name: model.name,
      subProvider: model.subProvider,
    })),
    [{ slug: "claude-fable-5.1", name: "Claude Fable 5.1", subProvider: "Anthropic" }],
  );
});

it.effect("collects the catalog at most once a day and keeps serving it when a refresh fails", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    let fetches = 0;
    const responses = [DOCS_MARKDOWN, "# Moved"];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        fetches += 1;
        return HttpClientResponse.fromWeb(request, new Response(responses[fetches - 1] ?? ""));
      }),
    );
    const catalog = yield* makeDroidModelCatalog().pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    const first = yield* catalog.models;
    assert.equal(fetches, 1);
    assert.deepStrictEqual(
      first.map((model) => model.slug),
      ["claude-fable-5.1", "claude-opus-4-5-20251101", "glm-5.3"],
    );

    // Inside the TTL the cached catalog is served without a second fetch.
    yield* TestClock.setTime(12 * 60 * 60 * 1000);
    assert.deepStrictEqual(yield* catalog.models, first);
    assert.equal(fetches, 1);

    // A day later the doc is re-collected; a doc that no longer parses must
    // not clobber the last good catalog.
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    const refreshed = yield* catalog.models;
    assert.equal(fetches, 2);
    assert.deepStrictEqual(
      refreshed.map((model) => model.slug),
      ["claude-fable-5.1", "claude-opus-4-5-20251101", "glm-5.3"],
    );
  }),
);

it.effect("fails when the docs endpoint is unreachable and nothing is cached", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 503 }))),
    );
    const catalog = yield* makeDroidModelCatalog().pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    const failure = yield* catalog.models.pipe(Effect.flip);
    assert.equal(failure._tag, "DroidModelCatalogError");
  }),
);
