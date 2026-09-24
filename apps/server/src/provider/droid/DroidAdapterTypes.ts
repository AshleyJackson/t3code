import type {
  AskUserRequestParams,
  AskUserResult,
  CreateSessionOptions,
  DroidSession,
  RequestPermissionHandlerResult,
  ResumeSessionOptions,
} from "@factory/droid-sdk/node";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  type CanonicalRequestType,
  type ProviderInstanceId,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

export const DROID_PROVIDER = ProviderDriverKind.make("droid");

export interface PendingDroidPermission {
  readonly requestType: CanonicalRequestType;
  readonly resolve: (result: RequestPermissionHandlerResult) => void;
}

export interface PendingDroidUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly droidQuestions: AskUserRequestParams["questions"];
  readonly resolve: (result: AskUserResult) => void;
}

export interface DroidContext {
  session: ProviderSession;
  droid: DroidSession;
  notificationCleanup: (() => void) | undefined;
  readonly pendingPermissions: Map<ApprovalRequestId, PendingDroidPermission>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingDroidUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeAbort: AbortController | undefined;
  activeAssistantItems: Map<string, string>;
  activeThinkingItems: Map<string, string>;
  activeCompletedAssistantItems: Set<string>;
  activeCompletedAssistantContents: Set<string>;
  activeCompletedThinkingItems: Set<string>;
  activeCompletedThinkingContents: Set<string>;
  activeStartedToolIds: Set<string>;
  activeToolInputs: Map<string, unknown>;
  activeToolOutputs: Map<string, string>;
  activeToolInputFingerprints: Map<string, string>;
  activePlanFingerprint: string | undefined;
  activeTurnError: string | undefined;
  activeTurnState: "completed" | "interrupted" | "failed" | undefined;
  activeTokenUsage: ThreadTokenUsageSnapshot | undefined;
  activeTokenUsageBaseline: ThreadTokenUsageSnapshot | undefined;
  cumulativeTokenUsage: ThreadTokenUsageSnapshot | undefined;
  activeHookIds: Set<string>;
  completedHookIds: Set<string>;
  compactionInProgress: boolean;
  pendingCompactionNotification: Record<string, unknown> | undefined;
}

export interface DroidAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly sdk?: {
    readonly createSession: (options?: CreateSessionOptions) => Promise<DroidSession>;
    readonly resumeSession: (
      sessionId: string,
      options?: ResumeSessionOptions,
    ) => Promise<DroidSession>;
  };
}

export type DroidAdapterShape = ProviderAdapterShape<ProviderAdapterError>;
