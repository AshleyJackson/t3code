// @effect-diagnostics nodeBuiltinImport:off - Temporary synchronous debug-file sink.
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type DebugRecord = Record<string, unknown>;

const DROID_DEBUG_LOG_PATH = join(tmpdir(), "droid-test.log");

function initializeDroidDebugLog(): void {
  try {
    writeFileSync(DROID_DEBUG_LOG_PATH, "");
  } catch {
    process.stderr.write(`[droid-debug] Could not initialize ${DROID_DEBUG_LOG_PATH}\n`);
  }
}

initializeDroidDebugLog();

const isRecord = (value: unknown): value is DebugRecord =>
  typeof value === "object" && value !== null;

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
  const line = `[droid-debug] ${label} ${JSON.stringify(details)}\n`;
  try {
    appendFileSync(DROID_DEBUG_LOG_PATH, line, "utf8");
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
