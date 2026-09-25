import { assert, it } from "@effect/vitest";
import type { DroidLogEvent, DroidMetricEvent } from "@factory/droid-sdk/node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import {
  droidSdkLogRecord,
  makeDroidObservability,
  traceparentFromSpan,
} from "./DroidObservability.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const findHistogramSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Histogram" }> =>
      snapshot.type === "Histogram" &&
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

it("sanitizes SDK log messages and unsafe event names", () => {
  const event: DroidLogEvent = {
    level: "error",
    name: "provider/tool content\nwith secrets",
    message: "raw provider content",
    attributes: { secret: "do-not-log" },
    error: { name: "Error", message: "raw error content" },
  };

  assert.deepStrictEqual(droidSdkLogRecord(event), {
    message: "Droid SDK event",
    attributes: {
      "droid.sdk.event": "unclassified",
      "droid.sdk.attribute_count": 1,
      "droid.sdk.level": "error",
      "droid.sdk.has_error": true,
    },
  });
});

it("creates W3C traceparent values from valid spans", () => {
  assert.equal(
    traceparentFromSpan({
      traceId: "A".repeat(32),
      spanId: "b".repeat(16),
      sampled: true,
    }),
    `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  );
  assert.equal(
    traceparentFromSpan({
      traceId: "not-a-trace",
      spanId: "b".repeat(16),
      sampled: false,
    }),
    undefined,
  );
});

it("injects the captured parent span into the SDK carrier", () => {
  const observability = makeDroidObservability(Context.empty(), {
    traceId: "A".repeat(32),
    spanId: "b".repeat(16),
    sampled: true,
  });
  const carrier: { traceparent?: string } = {};

  observability.tracing?.inject(carrier);

  assert.equal(carrier.traceparent, `00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
});

it.effect("forwards sanitized SDK metrics into T3 metrics", () =>
  Effect.gen(function* () {
    const observability = makeDroidObservability(Context.empty(), undefined);
    const event: DroidMetricEvent = {
      name: "droid.turn.duration",
      kind: "histogram",
      value: 42,
      unit: "ms",
      attributes: { model: "model-1" },
    };

    observability.metrics?.record(event);
    yield* Effect.yieldNow;

    const snapshots = yield* Metric.snapshot;
    assert.equal(
      hasMetricSnapshot(snapshots, "t3_droid_sdk_metric_events_total", {
        "droid.sdk.event": "droid.turn.duration",
        "droid.sdk.attribute_count": "1",
        "droid.sdk.kind": "histogram",
        "droid.sdk.unit": "ms",
      }),
      true,
    );
    const histogram = findHistogramSnapshot(snapshots, "t3_droid_sdk_metric_values", {
      "droid.sdk.event": "droid.turn.duration",
      "droid.sdk.attribute_count": "1",
      "droid.sdk.kind": "histogram",
      "droid.sdk.unit": "ms",
    });
    assert.equal(histogram?.state.count, 1);
    assert.equal(histogram?.state.sum, 42);
  }),
);

it.effect("forwards SDK log events without exposing their message", () =>
  Effect.gen(function* () {
    const observability = makeDroidObservability(Context.empty(), undefined);
    observability.logger?.log({
      level: "info",
      name: "droid.session.started",
      message: "provider content",
      attributes: {},
    });
    yield* Effect.yieldNow;

    const snapshots = yield* Metric.snapshot;
    assert.equal(
      hasMetricSnapshot(snapshots, "t3_droid_sdk_log_events_total", {
        "droid.sdk.event": "droid.session.started",
        "droid.sdk.attribute_count": "0",
        "droid.sdk.level": "info",
      }),
      true,
    );
  }),
);
