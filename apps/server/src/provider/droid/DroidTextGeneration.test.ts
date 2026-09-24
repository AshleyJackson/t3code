import { describe, expect, it } from "vite-plus/test";

import {
  collectDroidResponseText,
  parseDroidBranchName,
  parseDroidCommitMessage,
  parseDroidPrContent,
  parseDroidThreadTitle,
} from "./DroidTextGeneration.ts";

describe("parseDroidThreadTitle", () => {
  it("prefers the complete result text over partial assistant deltas", () => {
    expect(
      collectDroidResponseText([
        { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: '{"title":"' },
        { type: "assistant_text_delta", messageId: "m1", blockIndex: 0, text: "incomplete" },
        {
          type: "result",
          subtype: "success",
          sessionId: "s1",
          durationMs: 1,
          tokenUsage: null,
          messages: [],
          text: '{"title":"Complete title","needsRefinement":false}',
          turnCount: 1,
          success: true,
          interrupted: false,
          error: null,
        },
      ]),
    ).toBe('{"title":"Complete title","needsRefinement":false}');
  });

  it("parses JSON and removes a markdown code fence", () => {
    expect(
      parseDroidThreadTitle(
        '```json\n{"title":"Fix title regeneration","needsRefinement":false}\n```',
      ),
    ).toEqual({
      title: "Fix title regeneration",
      needsRefinement: false,
    });
  });

  it("recovers a title when the JSON response is truncated", () => {
    expect(parseDroidThreadTitle('{"title":"Recoverable title","needsRefinement":false')).toEqual({
      title: "Recoverable title",
      needsRefinement: false,
    });
  });

  it("parses and sanitizes a commit message with a branch", () => {
    expect(
      parseDroidCommitMessage(
        '```json\n{"subject":" Fix commit. ","body":"  Explain the change.  ","branch":"Add UI Fix"}\n```',
        true,
      ),
    ).toEqual({
      subject: "Fix commit",
      body: "Explain the change.",
      branch: "feature/add-ui-fix",
    });
  });

  it("parses and sanitizes pull-request content", () => {
    expect(
      parseDroidPrContent('{"title":" Improve Droid PR ","body":"\\n## Summary\\n- Fixed it\\n"}'),
    ).toEqual({
      title: "Improve Droid PR",
      body: "## Summary\n- Fixed it",
    });
  });

  it("parses and sanitizes a branch name", () => {
    expect(parseDroidBranchName('{"branch":" Fix/Title Generation "}')).toEqual({
      branch: "fix/title-generation",
    });
  });
});
