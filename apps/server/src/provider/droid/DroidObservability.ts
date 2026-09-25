import {
  type DroidLogEvent,
  type DroidMetricEvent,
  type DroidObservability,
} from "@factory/droid-sdk/node";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import type * as Context from "effect/Context";
import type * as Tracer from "effect/Tracer";

import {
  droidSdkLogEventsTotal,
  droidSdkMetricEventsTotal,
  droidSdkMetricValues,
  metricAttributes,
} from "../../observability/Metrics.ts";

const SAFE_NAME = /^[a-z0-9_.:-]{1,80}$/iu;

const safeName = (value: string): string => (SAFE_NAME.test(value) ? value : "unclassified");

const sdkEventAttributes = (
  name: string,
  attributes: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> => ({
  "droid.sdk.event": safeName(name),
  "droid.sdk.attribute_count": Object.keys(attributes ?? {}).length,
});

export const droidSdkLogRecord = (
  event: DroidLogEvent,
): {
  readonly message: string;
  readonly attributes: Readonly<Record<string, unknown>>;
} => ({
  // SDK messages and attributes can contain provider or tool content. Keep the
  // server logger on event names and bounded shape metadata only.
  message: "Droid SDK event",
  attributes: {
    ...sdkEventAttributes(event.name, event.attributes),
    "droid.sdk.level": event.level,
    ...(event.error ? { "droid.sdk.has_error": true } : {}),
  },
});

const sdkMetricAttributes = (event: DroidMetricEvent): Readonly<Record<string, unknown>> => ({
  ...sdkEventAttributes(event.name, event.attributes),
  "droid.sdk.kind": event.kind,
  "droid.sdk.unit": event.unit,
});

const traceId = /^[0-9a-f]{32}$/iu;
const spanId = /^[0-9a-f]{16}$/iu;

export const traceparentFromSpan = (
  span: Pick<Tracer.AnySpan, "traceId" | "spanId" | "sampled">,
): string | undefined => {
  if (!traceId.test(span.traceId) || !spanId.test(span.spanId)) return undefined;
  return `00-${span.traceId.toLowerCase()}-${span.spanId.toLowerCase()}-${span.sampled ? "01" : "00"}`;
};

export const makeDroidObservability = (
  runtimeContext: Context.Context<never>,
  parentSpan?: Pick<Tracer.AnySpan, "traceId" | "spanId" | "sampled">,
): DroidObservability => {
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const runSync = Effect.runSyncWith(runtimeContext);
  const updateMetric = (effect: Effect.Effect<void, never, never>): void => {
    try {
      runSync(effect);
    } catch {
      // Metrics are normally synchronous. Retain a detached fallback if a
      // custom runtime introduces an asynchronous metric implementation.
      void runPromise(effect).catch(() => undefined);
    }
  };

  return {
    logger: {
      log(event) {
        const record = droidSdkLogRecord(event);
        updateMetric(
          Metric.update(
            Metric.withAttributes(droidSdkLogEventsTotal, metricAttributes(record.attributes)),
            1,
          ),
        );
        void runPromise(
          Effect.annotateLogs(
            Effect.logWithLevel(
              event.level === "error"
                ? "Error"
                : event.level === "warn"
                  ? "Warn"
                  : event.level === "debug"
                    ? "Debug"
                    : "Info",
            )(record.message),
            record.attributes,
          ),
        ).catch(() => undefined);
      },
    },
    metrics: {
      record(event) {
        const attributes = sdkMetricAttributes(event);
        const metricEffect = Effect.andThen(
          Metric.update(
            Metric.withAttributes(droidSdkMetricEventsTotal, metricAttributes(attributes)),
            1,
          ),
          Metric.update(
            Metric.withAttributes(droidSdkMetricValues, metricAttributes(attributes)),
            Number.isFinite(event.value) ? Math.max(0, event.value) : 0,
          ),
        );
        updateMetric(metricEffect);
      },
    },
    tracing: {
      inject(carrier) {
        const traceparent = parentSpan ? traceparentFromSpan(parentSpan) : undefined;
        if (traceparent) carrier.traceparent = traceparent;
      },
    },
  };
};
