// @effect-diagnostics nodeBuiltinImport:off
// The reconciler reads CLI-managed transcript files outside the Effect runtime,
// mirroring the promise-based notification handling in the adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import type { DroidContext } from "./DroidAdapterTypes.ts";
import { emitDroidTaskCompleted, type DroidEventBase } from "./DroidRuntimeEvents.ts";

/**
 * Droid 0.9.x has no stream or notification signal when a background Task
 * (child subagent session) finishes; only `child_session_available` ever
 * reaches the parent subscription. The CLI does record the child's terminal
 * state durably, though: the child session transcript ends with an
 * `agent_turn_outcome` record (`{ type, turnId, reason, resultKind }`).
 *
 * Reconciliation reads that record for every still-running task so the agents
 * menu can settle rows the SDK never reports on. Everything here is
 * best-effort: an unreadable or moved transcript leaves the task running,
 * which matches the pre-reconciliation behavior.
 */

/** Mirror of the SDK's taskInvocationStatusForCompletionReason mapping. */
export function droidTaskStatusForOutcomeReason(
  reason: string,
): "completed" | "failed" | "stopped" {
  if (reason === "completed" || reason === "spec_handoff") return "completed";
  if (reason === "cancelled" || reason === "process_exit") return "stopped";
  return "failed";
}

export interface DroidChildTaskOutcome {
  readonly status: "completed" | "failed" | "stopped";
  readonly reason: string;
}

export function parseDroidChildOutcomeFromTranscriptTail(
  tail: string,
): DroidChildTaskOutcome | undefined {
  let outcome: DroidChildTaskOutcome | undefined;
  for (const line of tail.split(/\r?\n/u)) {
    if (!line.includes("agent_turn_outcome")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).type !== "agent_turn_outcome"
    ) {
      continue;
    }
    const reason = (parsed as Record<string, unknown>).reason;
    if (typeof reason !== "string") continue;
    outcome = { status: droidTaskStatusForOutcomeReason(reason), reason };
  }
  return outcome;
}

/** Transcript tails end with the outcome record, so reading the last chunk is enough. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export async function readDroidChildTaskOutcome(
  filePath: string,
): Promise<DroidChildTaskOutcome | undefined> {
  let handle;
  try {
    handle = await NodeFSP.open(filePath, "r");
    const size = (await handle.stat()).size;
    if (size <= 0) return undefined;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return parseDroidChildOutcomeFromTranscriptTail(buffer.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The CLI stores transcripts at `<home>/.factory/sessions/<cwd-slug>/<id>.jsonl`
 * with the slug being the cwd joined by dashes. The slug rule is an
 * implementation detail, so a miss falls back to scanning the sibling
 * project directories for the exact `<taskId>.jsonl` name.
 */
export function droidTaskTranscriptSlugPath(
  sessionsRoot: string,
  cwd: string,
  taskId: string,
): string {
  const slug = `-${cwd.replace(/[\\/:]/gu, "-")}`;
  return NodePath.join(sessionsRoot, slug, `${taskId}.jsonl`);
}

/** Default CLI transcript storage root; matches the Droid CLI's `~/.factory/sessions`. */
export function defaultDroidSessionsRoot(): string {
  return NodePath.join(NodeOS.homedir(), ".factory", "sessions");
}

export async function findDroidChildTranscriptPath(input: {
  readonly sessionsRoot: string;
  readonly cwd: string | undefined;
  readonly taskId: string;
}): Promise<string | undefined> {
  const { sessionsRoot, cwd, taskId } = input;
  const fileName = `${taskId}.jsonl`;
  if (cwd) {
    const slugPath = droidTaskTranscriptSlugPath(sessionsRoot, cwd, taskId);
    if (
      await NodeFSP.stat(slugPath).then(
        () => true,
        () => false,
      )
    )
      return slugPath;
  }
  let entries;
  try {
    entries = await NodeFSP.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = NodePath.join(sessionsRoot, entry.name, fileName);
    if (
      await NodeFSP.stat(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
}

export interface DroidTaskReconciliationDeps {
  readonly contexts: Iterable<DroidContext>;
  readonly isCurrentContext: (context: DroidContext) => boolean;
  readonly eventBase: DroidEventBase;
  readonly emitNow: (event: ProviderRuntimeEvent) => Promise<void>;
  readonly sessionsRoot: string;
  /** Outcome lookup; defaults to reading the child transcript tail from disk. */
  readonly readOutcome?: (task: {
    readonly taskId: string;
    readonly cwd: string | undefined;
  }) => Promise<DroidChildTaskOutcome | undefined>;
}

/**
 * One reconciliation pass over every live context's still-running Droid tasks.
 * Emits `task.completed` for tasks whose child transcript recorded an
 * `agent_turn_outcome`, and returns whether any task is still running so the
 * caller can decide to keep polling.
 */
export async function reconcileDroidChildTasks(
  deps: DroidTaskReconciliationDeps,
): Promise<boolean> {
  const readOutcome =
    deps.readOutcome ??
    (async (task) => {
      const transcriptPath = await findDroidChildTranscriptPath({
        sessionsRoot: deps.sessionsRoot,
        cwd: task.cwd,
        taskId: task.taskId,
      });
      if (!transcriptPath) return undefined;
      return readDroidChildTaskOutcome(transcriptPath);
    });
  let hasRunningTasks = false;
  for (const context of deps.contexts) {
    // Retired or replaced contexts never emit; their replacements are iterated
    // on their own so polling stops once no live task remains.
    if (!deps.isCurrentContext(context)) continue;
    const tasks = context.activeDroidTasks;
    if (!tasks || tasks.size === 0) continue;
    for (const task of tasks.values()) {
      if (task.status !== "running") continue;
      let outcome: DroidChildTaskOutcome | undefined;
      try {
        outcome = await readOutcome({
          taskId: task.taskId,
          cwd: task.cwd ?? context.session.cwd,
        });
      } catch {
        // A transient filesystem or provider error must not terminate the
        // reconciliation pass. The task remains running and is retried.
        hasRunningTasks = true;
        continue;
      }
      if (!deps.isCurrentContext(context)) continue;
      if (outcome) {
        try {
          await emitDroidTaskCompleted({
            context,
            taskId: task.taskId,
            description: task.description,
            taskType: task.taskType,
            ...(task.cwd ? { cwd: task.cwd } : {}),
            toolUseId: task.toolUseId,
            status: outcome.status,
            base: (itemId?: string) =>
              deps.eventBase(context, itemId !== undefined ? { itemId } : {}),
            emitNow: (event) =>
              deps.isCurrentContext(context) ? deps.emitNow(event) : Promise.resolve(),
          });
        } catch {
          // Keep the task running when projecting its terminal event fails.
          // The next pass must be able to deliver the completion.
          hasRunningTasks = true;
          continue;
        }
      }
      if (tasks.get(task.taskId)?.status === "running") hasRunningTasks = true;
    }
  }
  return hasRunningTasks;
}
