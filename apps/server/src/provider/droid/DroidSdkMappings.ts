import {
  AutonomyLevel,
  type AskUserRequestParams,
  type AskUserResult,
  type ContentBlock,
  type ContextStats,
  DroidInteractionMode,
  ReasoningEffort,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
  type TokenUsage,
  type TokenUsageUpdate,
} from "@factory/droid-sdk";
import type {
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderSessionStartInput,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
  UserInputQuestion,
} from "@t3tools/contracts";

export { DroidInteractionMode };

// Labels the model selector shows for each `reasoningEffort` value.
export const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  [ReasoningEffort.None]: "None",
  [ReasoningEffort.Dynamic]: "Dynamic",
  [ReasoningEffort.Off]: "Off",
  [ReasoningEffort.Minimal]: "Minimal",
  [ReasoningEffort.Low]: "Low",
  [ReasoningEffort.Medium]: "Medium",
  [ReasoningEffort.High]: "High",
  [ReasoningEffort.ExtraHigh]: "Extra High",
  [ReasoningEffort.Max]: "Max",
};

export function toModelId(model: string | undefined): string | undefined {
  return !model || model === "default" ? undefined : model;
}

export function toReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  switch (value) {
    case "none":
      return ReasoningEffort.None;
    case "dynamic":
      return ReasoningEffort.Dynamic;
    case "off":
      return ReasoningEffort.Off;
    case "minimal":
      return ReasoningEffort.Minimal;
    case "low":
      return ReasoningEffort.Low;
    case "medium":
      return ReasoningEffort.Medium;
    case "high":
      return ReasoningEffort.High;
    case "xhigh":
      return ReasoningEffort.ExtraHigh;
    case "max":
      return ReasoningEffort.Max;
    default:
      return undefined;
  }
}

export function toAutonomyLevelForRuntimeMode(runtimeMode: RuntimeMode): AutonomyLevel {
  switch (runtimeMode) {
    case "approval-required":
      return AutonomyLevel.Off;
    case "auto-accept-edits":
      return AutonomyLevel.Low;
    case "auto":
    case "medium-access":
      return AutonomyLevel.Medium;
    case "full-access":
      return AutonomyLevel.High;
  }
}

export function toAutonomyLevel(input: ProviderSessionStartInput): AutonomyLevel {
  return toAutonomyLevelForRuntimeMode(input.runtimeMode);
}

export function contentBlockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  return "";
}

export function toRequestType(params: RequestPermissionRequestParams): CanonicalRequestType {
  switch (params.toolUses[0]?.confirmationType) {
    case ToolConfirmationType.Execute:
      return "command_execution_approval";
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
      return "file_change_approval";
    case ToolConfirmationType.ApplyPatch:
      return "apply_patch_approval";
    case ToolConfirmationType.McpTool:
      return "dynamic_tool_call";
    case ToolConfirmationType.AskUser:
      return "tool_user_input";
    default:
      return "unknown";
  }
}

export function toToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (/(?:todo|plan)/u.test(normalized)) return "dynamic_tool_call";
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("exec") ||
    normalized.includes("bash") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

export function isDroidPlanTool(toolName: string): boolean {
  return /(?:todo|plan)/iu.test(toolName);
}

export type DroidPlanStep = {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseDroidTodoText(input: string): ReadonlyArray<Record<string, unknown>> {
  const lines = input
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line) => {
    const statusMatch =
      /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[(completed|in_progress|pending|cancelled|canceled)\]\s*(.*)$/iu.exec(
        line,
      );
    if (statusMatch) {
      return {
        content: statusMatch[2]?.trim() || "(no description)",
        status: statusMatch[1]?.toLowerCase() ?? "pending",
      };
    }

    const checkedMatch = /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[[xX]\]\s*(.*)$/u.exec(line);
    if (checkedMatch) {
      return {
        content: checkedMatch[1]?.trim() || "(no description)",
        status: "completed",
      };
    }

    const uncheckedMatch = /^(?:(?:\d+[.)]\s*)|(?:[-*]\s+))?\[\s*\]\s*(.*)$/u.exec(line);
    if (uncheckedMatch) {
      return {
        content: uncheckedMatch[1]?.trim() || "(no description)",
        status: "pending",
      };
    }

    const numberedMatch = /^\d+[.)]\s+(.+)$/u.exec(line);
    const bulletMatch = /^[-*]\s+(.+)$/u.exec(line);
    return {
      content: (numberedMatch?.[1] ?? bulletMatch?.[1] ?? line).trim(),
      status: "pending",
    };
  });
}

function parseDroidTodoValue(value: unknown): ReadonlyArray<unknown> | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 && typeof value[0] === "string"
      ? parseDroidTodoText(value.join("\n"))
      : value;
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.length > 0 && typeof parsed[0] === "string"
          ? parseDroidTodoText(parsed.join("\n"))
          : parsed;
      }
    } catch {
      // Droid falls back to line-based parsing when the JSON form is invalid.
    }
  }
  return parseDroidTodoText(trimmed);
}

function normalizeDroidPlanEntries(entries: ReadonlyArray<unknown>): ReadonlyArray<DroidPlanStep> {
  return entries
    .map((entry) => {
      const item = asRecord(entry);
      const step =
        [item?.content, item?.step, item?.title, entry]
          .map(asText)
          .find((value): value is string => value !== undefined) ?? undefined;
      if (!step) return undefined;
      const rawStatus = asText(item?.status)
        ?.toLowerCase()
        .replace(/[\s-]+/gu, "_");
      if (rawStatus === "cancelled" || rawStatus === "canceled") return undefined;
      const status =
        rawStatus === "completed" || rawStatus === "complete" || rawStatus === "done"
          ? "completed"
          : rawStatus === "in_progress" ||
              rawStatus === "active" ||
              rawStatus === "running" ||
              rawStatus === "started"
            ? "inProgress"
            : "pending";
      return { step, status } satisfies DroidPlanStep;
    })
    .filter((entry): entry is DroidPlanStep => entry !== undefined);
}

function toolResultText(content: string | readonly unknown[]): string | undefined {
  if (typeof content === "string") return asText(content);
  return asText(
    content
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .filter((entry): entry is string => entry !== undefined)
      .join("\n"),
  );
}

/**
 * Droid returns the full activation document for Skill calls. Other providers
 * keep tool results out of the lifecycle detail, so exposing that document
 * makes the work log show implementation instructions instead of the action.
 */
export function summarizeDroidToolResult(
  toolName: string,
  content: string | readonly unknown[],
): { readonly title?: string; readonly detail?: string } {
  const text = toolResultText(content);
  if (!text) return {};

  if (/^skill$/iu.test(toolName.trim())) {
    const skillName =
      /skill\s+["']([^"']+)["']\s+is\s+now\s+active/iu.exec(text)?.[1] ??
      /<skill\b[^>]*\bname=["']([^"']+)["']/iu.exec(text)?.[1];
    return skillName
      ? { title: `Skill "${skillName}" is now active.` }
      : { title: "Skill activated." };
  }

  if (/(?:edit|write|patch)/iu.test(toolName.trim())) {
    try {
      const parsed: unknown = JSON.parse(text);
      const files = asRecord(parsed)?.files;
      if (Array.isArray(files)) {
        const paths = files
          .map((file) => asText(asRecord(file)?.file_path ?? asRecord(file)?.path))
          .filter((path): path is string => path !== undefined);
        if (paths.length > 0) {
          return {
            title: "Changed files",
            detail: paths.join(", "),
          };
        }
      }
    } catch {
      // Some Droid tools return plain text. Keep the generic result handling.
    }
  }

  return {};
}

export function extractDroidPlan(input: unknown): ReadonlyArray<DroidPlanStep> | undefined {
  const record = asRecord(input);
  const arrayCandidates = [
    Array.isArray(input) ? input : undefined,
    record?.todos,
    record?.plan,
    record?.steps,
    record?.items,
  ];
  const entries = arrayCandidates.find(Array.isArray);
  if (entries) {
    const plan = normalizeDroidPlanEntries(entries);
    return plan.length > 0 ? plan : undefined;
  }

  const todoEntries = parseDroidTodoValue(
    record?.todos ?? (typeof input === "string" ? input : undefined),
  );
  if (!todoEntries) return undefined;
  const plan = normalizeDroidPlanEntries(todoEntries);
  // The Droid SDK keeps the previous list when TodoWrite receives an empty or
  // invalid snapshot. Match that behavior instead of clearing a live plan
  // before a valid tool result arrives.
  return plan.length > 0 ? plan : undefined;
}

export function droidProgressText(
  update: {
    readonly details?: string | undefined;
    readonly text?: string | undefined;
    readonly fullOutput?: string | undefined;
    readonly valueSnippet?: string | undefined;
  },
  fallback?: string,
): string | undefined {
  return (
    asText(update.fullOutput) ??
    asText(update.details) ??
    asText(update.text) ??
    asText(update.valueSnippet) ??
    asText(fallback)
  );
}

export function permissionDetail(params: RequestPermissionRequestParams): string {
  const first = params.toolUses[0];
  if (!first) return "Droid requested permission.";
  const details = first.details;
  switch (details.type) {
    case ToolConfirmationType.Execute:
      return details.fullCommand;
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
      return details.filePath;
    case ToolConfirmationType.ApplyPatch:
      return (
        details.files
          ?.map((file) => file.filePath)
          .filter((filePath): filePath is string => Boolean(filePath))
          .join(", ") || "Droid requested a patch."
      );
    case ToolConfirmationType.McpTool:
      return details.toolName;
    default:
      return first.toolUse.name;
  }
}

export function normalizeAskUserQuestions(
  params: AskUserRequestParams,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question, index) => ({
    id: `question-${question.index ?? index}`,
    header: question.topic || `Question ${index + 1}`,
    question: question.question,
    options: question.options.map((option) => ({
      label: option,
      description: option,
    })),
    allowCustomAnswer: true,
    ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
  }));
}

function answerString(value: unknown): string {
  if (Array.isArray(value)) return value.map(answerString).join(", ");
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

export function toAskUserResult(
  questions: AskUserRequestParams["questions"],
  answers: ProviderUserInputAnswers,
): AskUserResult {
  return {
    answers: questions.map((question, index) => ({
      index: question.index,
      question: question.question,
      answer: answerString(
        answers[`question-${question.index ?? index}`] ?? answers[question.question],
      ),
    })),
  };
}

export function toOutcome(decision: ProviderApprovalDecision): RequestPermissionHandlerResult {
  switch (decision) {
    case "accept":
      return ToolConfirmationOutcome.ProceedOnce;
    case "acceptForSession":
    case "acceptAlways":
      return ToolConfirmationOutcome.ProceedAlways;
    case "decline":
    case "cancel":
      return ToolConfirmationOutcome.Cancel;
  }
}

type DroidTokenUsage = TokenUsage | TokenUsageUpdate;

export function toTokenUsageSnapshot(
  usage: DroidTokenUsage,
  previous?: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot {
  const lastInputTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const lastOutputTokens = usage.outputTokens + usage.thinkingTokens;
  const lastCachedInputTokens = usage.cacheReadTokens;
  const lastReasoningOutputTokens = usage.thinkingTokens;
  const inputTokens = (previous?.inputTokens ?? 0) + lastInputTokens;
  const cachedInputTokens = (previous?.cachedInputTokens ?? 0) + lastCachedInputTokens;
  const outputTokens = (previous?.outputTokens ?? 0) + lastOutputTokens;
  const reasoningOutputTokens = (previous?.reasoningOutputTokens ?? 0) + lastReasoningOutputTokens;
  return {
    ...(previous?.maxTokens !== undefined ? { maxTokens: previous.maxTokens } : {}),
    ...(previous?.compactsAutomatically !== undefined
      ? { compactsAutomatically: previous.compactsAutomatically }
      : {}),
    ...(previous?.autoCompactThreshold !== undefined
      ? { autoCompactThreshold: previous.autoCompactThreshold }
      : {}),
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: lastInputTokens + lastOutputTokens,
    lastInputTokens,
    lastCachedInputTokens,
    lastOutputTokens,
    lastReasoningOutputTokens,
  };
}

export function toInclusiveTokenUsageSnapshot(
  usage: DroidTokenUsage,
  previous?: ThreadTokenUsageSnapshot,
  lastCall?: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly outputTokens?: number;
    readonly reasoningOutputTokens?: number;
  },
): ThreadTokenUsageSnapshot {
  const snapshot = toTokenUsageSnapshot(usage);
  if (!lastCall) {
    return {
      ...snapshot,
      ...(previous?.maxTokens !== undefined ? { maxTokens: previous.maxTokens } : {}),
      ...(previous?.compactsAutomatically !== undefined
        ? { compactsAutomatically: previous.compactsAutomatically }
        : {}),
      ...(previous?.autoCompactThreshold !== undefined
        ? { autoCompactThreshold: previous.autoCompactThreshold }
        : {}),
    };
  }

  const lastInputTokens = lastCall.inputTokens + lastCall.cacheReadTokens;
  const lastOutputTokens = lastCall.outputTokens ?? 0;
  return {
    ...snapshot,
    ...(previous?.maxTokens !== undefined ? { maxTokens: previous.maxTokens } : {}),
    ...(previous?.compactsAutomatically !== undefined
      ? { compactsAutomatically: previous.compactsAutomatically }
      : {}),
    ...(previous?.autoCompactThreshold !== undefined
      ? { autoCompactThreshold: previous.autoCompactThreshold }
      : {}),
    lastUsedTokens: lastInputTokens + lastOutputTokens,
    lastInputTokens,
    lastCachedInputTokens: lastCall.cacheReadTokens,
    lastOutputTokens,
    lastReasoningOutputTokens: lastCall.reasoningOutputTokens ?? 0,
  };
}

export function withDroidContextStats(
  usage: ThreadTokenUsageSnapshot | undefined,
  stats: ContextStats,
): ThreadTokenUsageSnapshot {
  const usedTokens = Math.max(0, Math.round(stats.used));
  const maxTokens = Math.max(1, Math.round(stats.limit));
  return {
    ...usage,
    usedTokens,
    maxTokens,
    compactsAutomatically: true,
  };
}
