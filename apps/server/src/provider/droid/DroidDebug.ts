// @effect-diagnostics nodeBuiltinImport:off - Temporary synchronous debug-file sink.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";

type DebugRecord = Record<string, unknown>;
const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|password|secret|token/iu;

const DROID_DEBUG_LOG_PATH = NodePath.join(NodeOS.tmpdir(), "droid-test.log");

const isRecord = (value: unknown): value is DebugRecord =>
  typeof value === "object" && value !== null;

type DroidServiceErrorPayload = {
  readonly detail?: string | undefined;
  readonly message?: string | undefined;
  readonly requestId?: string | undefined;
  readonly status?: number | undefined;
};

const asDroidServiceErrorPayload = (value: unknown): DroidServiceErrorPayload | undefined => {
  if (!isRecord(value)) return undefined;
  const status =
    typeof value.status === "number"
      ? value.status
      : typeof value.statusCode === "number"
        ? value.statusCode
        : undefined;
  const detail = typeof value.detail === "string" ? value.detail : undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  const requestId =
    typeof value.requestId === "string"
      ? value.requestId
      : typeof value.request_id === "string"
        ? value.request_id
        : undefined;
  if (
    detail === undefined &&
    message === undefined &&
    requestId === undefined &&
    status === undefined
  ) {
    return undefined;
  }
  return { detail, message, requestId, status };
};

const parseDroidServiceErrorText = (value: string): DroidServiceErrorPayload | undefined => {
  const json = value.match(/\{[\s\S]*\}/u)?.[0];
  if (!json) return undefined;
  try {
    return asDroidServiceErrorPayload(JSON.parse(json));
  } catch {
    return undefined;
  }
};

const droidServiceErrorPayload = (error: unknown): DroidServiceErrorPayload => {
  const record = isRecord(error) ? error : undefined;
  const metadata = record && isRecord(record.metadata) ? record.metadata : undefined;
  const data = record && isRecord(record.data) ? record.data : undefined;
  const message = record && typeof record.message === "string" ? record.message : undefined;
  const parsed = message ? parseDroidServiceErrorText(message) : undefined;
  const payloads = [
    parsed,
    asDroidServiceErrorPayload(record),
    asDroidServiceErrorPayload(metadata),
    asDroidServiceErrorPayload(data),
  ];
  return payloads.reduce<DroidServiceErrorPayload>(
    (result, candidate) => ({
      detail: result.detail ?? candidate?.detail,
      message: result.message ?? candidate?.message,
      requestId: result.requestId ?? candidate?.requestId,
      status: result.status ?? candidate?.status,
    }),
    {},
  );
};

const droidRequestReference = (requestId: string | undefined): string =>
  requestId ? ` Reference: ${requestId}.` : "";

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
  const serviceError = droidServiceErrorPayload(error);
  const rawMessage = typeof details.errorMessage === "string" ? details.errorMessage : fallback;
  const serviceDetail = serviceError.detail ?? serviceError.message;
  const status =
    serviceError.status ??
    (/^\s*(\d{3})\b/u.exec(rawMessage)?.[1] !== undefined
      ? Number(/^\s*(\d{3})\b/u.exec(rawMessage)?.[1])
      : undefined);
  const regionUnavailable = /\bprovider\s+not\s+available\s+in\s+this\s+region\b/iu.test(
    serviceDetail ?? rawMessage,
  );
  if (regionUnavailable) {
    return `Droid is not available in this region. Try a different provider, or contact Factory support if this is unexpected.${droidRequestReference(serviceError.requestId)}`;
  }
  if (
    status === 401 ||
    /\b(?:unauthorized|authentication failed|not authenticated)\b/iu.test(rawMessage)
  ) {
    return `Droid authentication failed. Reconnect Droid in Settings → Providers, then try again.${droidRequestReference(serviceError.requestId)}`;
  }
  if (status === 403 || /\b(?:forbidden|access denied|not permitted)\b/iu.test(rawMessage)) {
    return `Droid denied this request. Check your account and provider permissions, then try again.${droidRequestReference(serviceError.requestId)}`;
  }
  if (status === 429 || /\b(?:rate limit|too many requests)\b/iu.test(rawMessage)) {
    return `Droid is temporarily rate-limited. Wait a moment and try again.${droidRequestReference(serviceError.requestId)}`;
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return `The Droid service is temporarily unavailable. Try again in a moment.${droidRequestReference(serviceError.requestId)}`;
  }
  const message = serviceDetail ?? rawMessage;
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

function droidErrorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (!isRecord(error)) return "";
  return [
    error.name,
    error.message,
    error.errorType,
    isRecord(error.metadata) ? error.metadata.code : undefined,
    isRecord(error.metadata) ? error.metadata.message : undefined,
  ]
    .filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    )
    .join(" ");
}

export function isDroidUsageLimitError(error: unknown): boolean {
  return /\b(?:model_)?usage_exhausted\b/iu.test(droidErrorText(error));
}

export function droidTurnErrorMessage(error: unknown): string {
  return isDroidUsageLimitError(error)
    ? "Droid usage limit reached. Send the message again once the limit resets."
    : droidErrorMessage(error, "Droid turn failed.");
}

/**
 * Resume recovery is intentionally limited to errors that identify a missing
 * persisted session or invalid session settings. Transport and auth failures
 * must remain visible instead of silently creating a new conversation.
 */
export function isDroidSessionNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const metadata = isRecord(error.metadata) ? error.metadata : undefined;
  return metadata?.code === -32004 || error.name === "SessionNotFoundError";
}

export function isDroidRecoverableResumeSettingsError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const metadata = isRecord(error.metadata) ? error.metadata : undefined;
  // Droid's update-session-settings endpoint reports invalid persisted
  // settings as JSON-RPC INVALID_PARAMS. The caller only uses this predicate
  // around that endpoint, so the structured code is sufficient here.
  return metadata?.code === -32602;
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
  const line = `[${DateTime.formatIso(DateTime.nowUnsafe())}] [droid-debug] ${label} ${JSON.stringify(details)}\n`;
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
  if (message.type === "assistant_text_delta" || message.type === "thinking_text_delta") return;

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
  if (event.type === "content.delta") return;

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
