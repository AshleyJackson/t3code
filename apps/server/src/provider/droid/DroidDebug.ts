// @effect-diagnostics nodeBuiltinImport:off - Temporary synchronous debug-file sink.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type DebugRecord = Record<string, unknown>;
const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|password|secret|token/iu;

const DROID_DEBUG_LOG_PATH = NodePath.join(NodeOS.tmpdir(), "droid-test.log");

const isRecord = (value: unknown): value is DebugRecord =>
  typeof value === "object" && value !== null;

const summarizeErrorValue = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") {
    return value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => summarizeErrorValue(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : summarizeErrorValue(item, depth + 1),
      ]),
  );
};

export function droidErrorDetails(error: unknown): DebugRecord {
  if (!isRecord(error)) return { error: String(error) };
  const metadata = isRecord(error.metadata) ? summarizeErrorValue(error.metadata) : undefined;
  return {
    errorName: typeof error.name === "string" ? error.name : undefined,
    errorMessage: typeof error.message === "string" ? error.message : String(error),
    ...(metadata !== undefined ? { errorMetadata: metadata } : {}),
  };
}

export function droidErrorMessage(error: unknown, fallback = "Droid request failed."): string {
  const details = droidErrorDetails(error);
  const message = typeof details.errorMessage === "string" ? details.errorMessage : fallback;
  const metadata = isRecord(details.errorMetadata) ? details.errorMetadata : undefined;
  const code = metadata?.code;
  const metadataMessage =
    typeof metadata?.message === "string" && metadata.message !== message
      ? metadata.message
      : undefined;
  const dataMessage =
    isRecord(metadata?.data) &&
    typeof metadata.data.message === "string" &&
    metadata.data.message !== metadataMessage
      ? metadata.data.message
      : undefined;
  return [
    message,
    code !== undefined ? `code ${String(code)}` : undefined,
    metadataMessage,
    dataMessage,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" — ");
}

const stringLength = (value: unknown): number | undefined =>
  typeof value === "string" ? value.length : undefined;

const summarizePayload = (payload: unknown): DebugRecord => {
  if (!isRecord(payload)) return { kind: typeof payload };

  const summary: DebugRecord = { keys: Object.keys(payload) };
  for (const key of ["state", "streamKind", "itemType", "status", "title", "class"]) {
    if (key in payload && typeof payload[key] === "string") {
      summary[key] = payload[key];
    }
  }
  for (const key of ["delta", "detail", "message", "errorMessage"]) {
    const length = stringLength(payload[key]);
    if (length !== undefined) summary[`${key}Length`] = length;
  }
  return summary;
};

export function debugDroid(label: string, details: DebugRecord = {}): void {
  if (process.env.T3_DEBUG_DROID === "0") return;
  const line = `[${new Date().toISOString()}] [droid-debug] ${label} ${JSON.stringify(details)}\n`;
  try {
    NodeFS.appendFileSync(DROID_DEBUG_LOG_PATH, line, "utf8");
  } catch {
    process.stderr.write(`[droid-debug] Could not write ${DROID_DEBUG_LOG_PATH}\n`);
  }
}

export function debugDroidSdkMessage(message: unknown): void {
  if (!isRecord(message)) {
    debugDroid("sdk.message.invalid", { kind: typeof message });
    return;
  }

  const details: DebugRecord = {
    type: message.type,
    keys: Object.keys(message),
  };
  for (const key of [
    "messageId",
    "blockIndex",
    "toolUseId",
    "toolName",
    "state",
    "success",
    "interrupted",
  ]) {
    if (key in message) details[key] = message[key];
  }
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  if (messageRecord) {
    details.messageRole = messageRecord.role;
    if (Array.isArray(messageRecord.content)) {
      details.contentTypes = messageRecord.content.map((block) =>
        isRecord(block) && typeof block.type === "string" ? block.type : typeof block,
      );
      details.contentTextLengths = messageRecord.content.map((block) => {
        if (!isRecord(block)) return undefined;
        return stringLength(block.text) ?? stringLength(block.thinking);
      });
    }
  }
  if ("text" in message) details.textLength = stringLength(message.text);
  const toolUse = isRecord(message.toolUse) ? message.toolUse : undefined;
  if (toolUse) {
    if (typeof toolUse.id === "string") details.toolUseId = toolUse.id;
    if (typeof toolUse.name === "string") details.toolName = toolUse.name;
    if (isRecord(toolUse.input)) details.toolInputKeys = Object.keys(toolUse.input);
  }
  const update = isRecord(message.update) ? message.update : undefined;
  if (update) {
    for (const key of ["type", "status", "toolName", "terminalId", "subagentSessionId"]) {
      if (typeof update[key] === "string") details[`update.${key}`] = update[key];
    }
    for (const key of ["details", "text", "fullOutput", "valueSnippet", "error"]) {
      const length = stringLength(update[key]);
      if (length !== undefined) details[`update.${key}Length`] = length;
    }
    if (isRecord(update.parameters)) {
      details.updateParameterKeys = Object.keys(update.parameters);
    }
  }
  if ("content" in message) {
    const length = stringLength(message.content);
    if (length !== undefined) details.contentLength = length;
  }
  if (isRecord(message.error)) details.errorKeys = Object.keys(message.error);
  debugDroid("sdk.message", details);
}

export function debugDroidRuntimeEvent(event: unknown): void {
  if (!isRecord(event)) {
    debugDroid("runtime.event.invalid", { kind: typeof event });
    return;
  }

  const details: DebugRecord = {
    type: event.type,
    eventId: event.eventId,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId,
    requestId: event.requestId,
    payload: summarizePayload(event.payload),
  };
  debugDroid("runtime.event", details);
}
