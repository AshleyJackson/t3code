// Collects Factory's published model catalog (https://docs.factory.ai/models.md) so
// Droid model lists stay current even when SDK discovery is unavailable.
import { type ServerProviderModel } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { debugDroid, droidErrorDetails } from "./DroidDebug.ts";
import { REASONING_EFFORT_LABELS } from "./DroidSdkMappings.ts";

const MODELS_DOC_URL = "https://docs.factory.ai/models.md";
// Provider health checks re-run every few minutes; this TTL throttles the docs
// collection to roughly once a day.
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 15_000;

// Section headings on models.md mapped to the sub-provider label T3 Code groups models under.
const SECTION_SUB_PROVIDERS: Readonly<Record<string, string>> = {
  Anthropic: "Anthropic",
  OpenAI: "OpenAI",
  Google: "Google",
  xAI: "xAI",
  "Droid Core (Open Models)": "Factory",
};

// Trailing footnote markers are annotations, not part of the model name:
// `\*` data retention, `†` promotional pricing, `‡` deprecated.
const FOOTNOTE_MARKER_PATTERN = /(?:\\?[*†‡])+$/u;
const DEPRECATED_MARKER_PATTERN = /‡$/u;
const BACKTICK_PATTERN = /`([^`]+)`/u;
const HTML_TAG_PATTERN = /<[^>]*>/gu;

function parseReasoningEfforts(cell: string) {
  const efforts: Array<{ value: string; isDefault: boolean }> = [];
  for (const match of cell.matchAll(/`([^`]+)`(?:\s*\((default)\))?/gu)) {
    const token = match[1]!.trim();
    // The docs place "(default)" after the closing backtick (`high` (default));
    // accept it inside the backticks as well in case the format drifts.
    const marked = /^(.*?)\s*\(default\)$/u.exec(token);
    efforts.push(
      marked
        ? { value: marked[1]!.trim(), isDefault: true }
        : { value: token, isDefault: match[2] !== undefined },
    );
  }
  return efforts;
}

export function parseFactoryModelsMarkdown(markdown: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  let subProvider: string | undefined;

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.startsWith("## ")) {
      const heading = line
        .slice("## ".length)
        .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
        .replace(HTML_TAG_PATTERN, "")
        .trim();
      // Unknown sections (e.g. "Custom models") contribute no catalog entries.
      subProvider = SECTION_SUB_PROVIDERS[heading];
      continue;
    }

    if (!line.startsWith("|") || subProvider === undefined) continue;

    const cells = line
      .split("|")
      .slice(1)
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    const idMatch = BACKTICK_PATTERN.exec(cells[1] ?? "");
    if (!idMatch) continue;

    const slug = idMatch[1]!;
    const rawName = (cells[0] ?? "").replace(HTML_TAG_PATTERN, "");
    if (seen.has(slug) || DEPRECATED_MARKER_PATTERN.test(rawName)) continue;

    const name = rawName.replace(FOOTNOTE_MARKER_PATTERN, "").trim();
    if (name.length === 0) continue;

    seen.add(slug);
    const efforts = parseReasoningEfforts(cells[3] ?? "");
    models.push({
      slug,
      name,
      subProvider,
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors:
          efforts.length > 0
            ? [
                buildSelectOptionDescriptor({
                  id: "reasoningEffort",
                  label: "Reasoning",
                  options: efforts.map((effort) => ({
                    value: effort.value,
                    label: REASONING_EFFORT_LABELS[effort.value] ?? effort.value,
                    isDefault: effort.isDefault,
                  })),
                }),
              ]
            : [],
      }),
    });
  }

  return models;
}

export class DroidModelCatalogError extends Data.TaggedError("DroidModelCatalogError")<{
  readonly message: string;
}> {}

export interface DroidModelCatalog {
  /**
   * Models from https://docs.factory.ai/models.md, collected at most once per day.
   * Serves the last collected catalog when a refresh fails.
   */
  readonly models: Effect.Effect<ReadonlyArray<ServerProviderModel>, DroidModelCatalogError>;
}

const fetchModelsDoc = Effect.fn("droidModelCatalog.fetch")(function* (
  client: HttpClient.HttpClient,
) {
  const response = yield* client
    .execute(HttpClientRequest.get(MODELS_DOC_URL))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const markdown = yield* response.text;
  return parseFactoryModelsMarkdown(markdown);
});

export const makeDroidModelCatalog = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  let cache: { fetchedAtMillis: number; models: ReadonlyArray<ServerProviderModel> } | undefined;

  const models = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cache !== undefined && now - cache.fetchedAtMillis < CATALOG_TTL_MS) {
      return cache.models;
    }

    const fetched = yield* fetchModelsDoc(client).pipe(
      Effect.timeoutOption(CATALOG_FETCH_TIMEOUT_MS),
      Effect.result,
    );
    const fresh =
      Result.isSuccess(fetched) &&
      Option.isSome(fetched.success) &&
      fetched.success.value.length > 0
        ? fetched.success.value
        : undefined;
    if (Result.isSuccess(fetched) && Option.isSome(fetched.success)) {
      debugDroid("model_catalog.docs.success", {
        modelCount: fetched.success.value.length,
        selectableModelCount: fresh?.length ?? 0,
      });
    } else if (Result.isFailure(fetched)) {
      debugDroid("model_catalog.docs.failed", droidErrorDetails(fetched.failure));
    } else {
      debugDroid("model_catalog.docs.empty");
    }
    if (fresh === undefined) {
      // A failed or empty refresh must not clobber the last good catalog.
      if (cache !== undefined) return cache.models;
      return yield* new DroidModelCatalogError({
        message: "Failed to collect the Factory model catalog from docs.factory.ai.",
      });
    }

    cache = { fetchedAtMillis: now, models: fresh };
    return fresh;
  });

  return { models } satisfies DroidModelCatalog;
});
