// @effect-diagnostics nodeBuiltinImport:off
// The tests exercise the real transcript files on disk through temp directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vite-plus/test";

import type { DroidContext, DroidTaskState } from "./DroidAdapterTypes.ts";
import {
  droidTaskStatusForOutcomeReason,
  findDroidChildTranscriptPath,
  parseDroidChildOutcomeFromTranscriptTail,
  readDroidChildTaskOutcome,
  reconcileDroidChildTasks,
  type DroidTaskReconciliationDeps,
} from "./DroidTaskReconciliation.ts";
import type { DroidEventBase } from "./DroidRuntimeEvents.ts";

const TRANSCRIPT_TAIL = [
  JSON.stringify({ type: "session_start", id: "child-1", title: "Worker" }),
  JSON.stringify({ type: "message", role: "user", timestamp: "2026-09-27T08:07:41.914Z" }),
  JSON.stringify({
    type: "agent_turn_outcome",
    turnId: "turn-9",
    reason: "completed",
    resultKind: "text",
  }),
].join("\n");

function task(overrides: Partial<DroidTaskState> = {}): DroidTaskState {
  return {
    taskId: "child-1",
    description: "Describe the screenshot",
    taskType: "worker",
    toolUseId: "tool-1",
    status: "running",
    ...overrides,
  };
}

function context(tasks: Record<string, DroidTaskState>, cwd?: string): DroidContext {
  return {
    session: { cwd },
    activeDroidTasks: new Map(Object.entries(tasks)),
  } as unknown as DroidContext;
}

function deps(
  contexts: DroidContext[],
  options: {
    readonly events?: unknown[];
    readonly readOutcome?: DroidTaskReconciliationDeps["readOutcome"];
    readonly sessionsRoot?: string;
  } = {},
): DroidTaskReconciliationDeps {
  const eventBase = ((_context: unknown, input?: { itemId?: string }) => ({
    eventId: "event-1",
    itemId: input?.itemId,
  })) as unknown as DroidEventBase;
  return {
    contexts,
    isCurrentContext: () => true,
    eventBase,
    emitNow: (event) => {
      options.events?.push(event);
      return Promise.resolve();
    },
    sessionsRoot: options.sessionsRoot ?? NodePath.join(NodeOS.tmpdir(), "droid-reconcile-absent"),
    ...(options.readOutcome ? { readOutcome: options.readOutcome } : {}),
  };
}

let sessionsRoot: string;

beforeAll(async () => {
  sessionsRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-reconcile-"));
});

afterAll(async () => {
  await NodeFSP.rm(sessionsRoot, { recursive: true, force: true });
});

describe("droid task outcome mapping", () => {
  it.each([
    ["completed", "completed"],
    ["spec_handoff", "completed"],
    ["cancelled", "stopped"],
    ["process_exit", "stopped"],
    ["error", "failed"],
    ["model_rate_limited", "failed"],
    ["something_new", "failed"],
  ])("maps outcome reason %s to %s", (reason, expected) => {
    expect(droidTaskStatusForOutcomeReason(reason)).toBe(expected);
  });
});

describe("parseDroidChildOutcomeFromTranscriptTail", () => {
  it("reads the terminal outcome record", () => {
    expect(parseDroidChildOutcomeFromTranscriptTail(TRANSCRIPT_TAIL)).toEqual({
      status: "completed",
      reason: "completed",
    });
  });

  it("prefers the last outcome record", () => {
    const tail = `${TRANSCRIPT_TAIL}\n${JSON.stringify({
      type: "agent_turn_outcome",
      turnId: "turn-10",
      reason: "error",
      resultKind: "text",
    })}`;
    expect(parseDroidChildOutcomeFromTranscriptTail(tail)).toEqual({
      status: "failed",
      reason: "error",
    });
  });

  it("ignores malformed lines and transcripts without an outcome", () => {
    expect(parseDroidChildOutcomeFromTranscriptTail("{broken json\n")).toBeUndefined();
    expect(
      parseDroidChildOutcomeFromTranscriptTail(
        `${JSON.stringify({ type: "message", role: "user" })}\n`,
      ),
    ).toBeUndefined();
  });
});

describe("readDroidChildTaskOutcome", () => {
  it("reads the outcome from a transcript file on disk", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-tail-"));
    try {
      const filePath = NodePath.join(dir, "child-1.jsonl");
      await NodeFSP.writeFile(filePath, TRANSCRIPT_TAIL, "utf8");
      expect(await readDroidChildTaskOutcome(filePath)).toEqual({
        status: "completed",
        reason: "completed",
      });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing or empty transcripts", async () => {
    expect(
      await readDroidChildTaskOutcome(NodePath.join(sessionsRoot, "absent.jsonl")),
    ).toBeUndefined();
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-tail-"));
    try {
      const empty = NodePath.join(dir, "empty.jsonl");
      await NodeFSP.writeFile(empty, "", "utf8");
      expect(await readDroidChildTaskOutcome(empty)).toBeUndefined();
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findDroidChildTranscriptPath", () => {
  it("resolves the cwd slug path directly", async () => {
    const cwd = "C:\\Users\\dev\\proj";
    const dir = NodePath.join(sessionsRoot, "-C-Users-dev-proj");
    await NodeFSP.mkdir(dir, { recursive: true });
    const filePath = NodePath.join(dir, "child-slug.jsonl");
    await NodeFSP.writeFile(filePath, TRANSCRIPT_TAIL, "utf8");
    expect(await findDroidChildTranscriptPath({ sessionsRoot, cwd, taskId: "child-slug" })).toBe(
      filePath,
    );
  });

  it("falls back to scanning sibling project directories", async () => {
    const dir = NodePath.join(sessionsRoot, "-unexpected-slug");
    await NodeFSP.mkdir(dir, { recursive: true });
    const filePath = NodePath.join(dir, "child-scan.jsonl");
    await NodeFSP.writeFile(filePath, TRANSCRIPT_TAIL, "utf8");
    expect(
      await findDroidChildTranscriptPath({
        sessionsRoot,
        cwd: "C:\\Users\\dev\\other-proj",
        taskId: "child-scan",
      }),
    ).toBe(filePath);
    expect(
      await findDroidChildTranscriptPath({ sessionsRoot, cwd: undefined, taskId: "child-scan" }),
    ).toBe(filePath);
  });

  it("returns undefined when no sibling holds the transcript", async () => {
    expect(
      await findDroidChildTranscriptPath({ sessionsRoot, cwd: undefined, taskId: "child-none" }),
    ).toBeUndefined();
  });
});

describe("reconcileDroidChildTasks", () => {
  function readOutcomeFromRoot(sessionsRootForRead: string) {
    return async (task: { taskId: string; cwd: string | undefined }) => {
      const transcriptPath = await findDroidChildTranscriptPath({
        sessionsRoot: sessionsRootForRead,
        cwd: task.cwd,
        taskId: task.taskId,
      });
      if (!transcriptPath) return undefined;
      return readDroidChildTaskOutcome(transcriptPath);
    };
  }

  it("emits task.completed when the child transcript recorded an outcome", async () => {
    const cwd = "C:\\Users\\dev\\proj";
    const slugDir = NodePath.join(sessionsRoot, "-C-Users-dev-proj");
    await NodeFSP.mkdir(slugDir, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(slugDir, "child-done.jsonl"), TRANSCRIPT_TAIL, "utf8");
    const events: unknown[] = [];
    const activeContext = context({ "child-done": task({ taskId: "child-done" }) }, cwd);
    const hasRunningTasks = await reconcileDroidChildTasks({
      ...deps([activeContext], { events, sessionsRoot }),
      readOutcome: readOutcomeFromRoot(sessionsRoot),
    });
    expect(events).toHaveLength(1);
    const event = events[0] as {
      type: string;
      itemId?: string;
      payload: { taskId: string; status: string; title: string; summary: string };
    };
    expect(event.type).toBe("task.completed");
    expect(event.itemId).toBe("tool-1");
    expect(event.payload.taskId).toBe("child-done");
    expect(event.payload.status).toBe("completed");
    expect(event.payload.title).toBe("Describe the screenshot");
    expect(
      (activeContext.activeDroidTasks as Map<string, DroidTaskState>).get("child-done")?.status,
    ).toBe("completed");
    expect(hasRunningTasks).toBe(false);
  });

  it("keeps polling while the transcript has no outcome yet", async () => {
    const events: unknown[] = [];
    const hasRunningTasks = await reconcileDroidChildTasks(
      deps([context({ "child-1": task() }, "C:\\Users\\dev\\proj")], {
        events,
        readOutcome: async () => undefined,
      }),
    );
    expect(events).toEqual([]);
    expect(hasRunningTasks).toBe(true);
  });

  it("emits failed and stopped statuses from the transcript reason", async () => {
    const events: unknown[] = [];
    await reconcileDroidChildTasks(
      deps([context({ "child-f": task({ taskId: "child-f" }) })], {
        events,
        readOutcome: async () => ({ status: "failed", reason: "error" }),
      }),
    );
    await reconcileDroidChildTasks(
      deps([context({ "child-s": task({ taskId: "child-s" }) })], {
        events,
        readOutcome: async () => ({ status: "stopped", reason: "cancelled" }),
      }),
    );
    expect(
      events.map((event) => (event as { payload: { status: string } }).payload.status),
    ).toEqual(["failed", "stopped"]);
  });

  it("skips terminal tasks and non-current contexts", async () => {
    const events: unknown[] = [];
    const current = context({ done: task({ status: "completed" }) });
    const replaced = context({ running: task({ taskId: "running" }) });
    const hasRunningTasks = await reconcileDroidChildTasks({
      ...deps([current, replaced], {
        events,
        readOutcome: async () => ({ status: "completed", reason: "completed" }),
      }),
      isCurrentContext: (candidate) => candidate === current,
    });
    expect(events).toEqual([]);
    expect(hasRunningTasks).toBe(false);
  });

  it("does not emit a stale completion after the context is retired during lookup", async () => {
    const events: unknown[] = [];
    const activeContext = context({ child: task({ taskId: "child" }) });
    let releaseLookup: (() => void) | undefined;
    const lookupFinished = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let current = true;
    const reconciliation = reconcileDroidChildTasks({
      ...deps([activeContext], {
        events,
        readOutcome: async () => {
          await lookupFinished;
          return { status: "completed", reason: "completed" };
        },
      }),
      isCurrentContext: () => current,
    });

    await Promise.resolve();
    current = false;
    releaseLookup?.();

    expect(await reconciliation).toBe(false);
    expect(events).toEqual([]);
    expect(
      (activeContext.activeDroidTasks as Map<string, DroidTaskState>).get("child")?.status,
    ).toBe("running");
  });

  it("reports remaining running tasks across contexts", async () => {
    const events: unknown[] = [];
    const hasRunningTasks = await reconcileDroidChildTasks(
      deps(
        [
          context({ settled: task({ taskId: "settled" }) }),
          context({ still: task({ taskId: "still" }) }),
        ],
        {
          events,
          readOutcome: async (input) =>
            input.taskId === "settled" ? { status: "completed", reason: "completed" } : undefined,
        },
      ),
    );
    expect(events).toHaveLength(1);
    expect(hasRunningTasks).toBe(true);
  });

  it("keeps retrying when one transcript lookup throws", async () => {
    const events: unknown[] = [];
    let reads = 0;
    const activeContext = context({ child: task({ taskId: "child" }) });
    const hasRunningTasks = await reconcileDroidChildTasks({
      ...deps([activeContext], { events }),
      readOutcome: async () => {
        reads += 1;
        throw new Error("transient filesystem failure");
      },
    });

    expect(reads).toBe(1);
    expect(events).toEqual([]);
    expect(hasRunningTasks).toBe(true);
    expect(
      (activeContext.activeDroidTasks as Map<string, DroidTaskState>).get("child")?.status,
    ).toBe("running");
  });

  it("uses task cwd when locating a child transcript", async () => {
    const events: unknown[] = [];
    let requestedCwd: string | undefined;
    const activeContext = context({
      child: task({ taskId: "child", cwd: "C:\\Users\\dev\\child-worktree" }),
    });
    await reconcileDroidChildTasks({
      ...deps([activeContext], { events }),
      readOutcome: async (input) => {
        requestedCwd = input.cwd;
        return { status: "completed", reason: "completed" };
      },
    });

    expect(requestedCwd).toBe("C:\\Users\\dev\\child-worktree");
    expect(events).toHaveLength(1);
  });

  it("does not lose completion when event delivery fails", async () => {
    const activeContext = context({ child: task({ taskId: "child" }) });
    let attempts = 0;
    const events: unknown[] = [];
    const base = deps([activeContext], {
      events,
      readOutcome: async () => ({ status: "completed", reason: "completed" }),
    });
    const retryingDeps: DroidTaskReconciliationDeps = {
      ...base,
      emitNow: async (event) => {
        attempts += 1;
        if (attempts === 1) throw new Error("queue temporarily unavailable");
        events.push(event);
      },
    };

    expect(await reconcileDroidChildTasks(retryingDeps)).toBe(true);
    expect(
      (activeContext.activeDroidTasks as Map<string, DroidTaskState>).get("child")?.status,
    ).toBe("running");
    expect(await reconcileDroidChildTasks(retryingDeps)).toBe(false);
    expect(
      (activeContext.activeDroidTasks as Map<string, DroidTaskState>).get("child")?.status,
    ).toBe("completed");
    expect(events).toHaveLength(1);
  });
});
