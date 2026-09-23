import { describe, expect, it } from "vite-plus/test";

import {
  parseDroidBranchName,
  parseDroidCommitMessage,
  parseDroidPrContent,
  parseDroidThreadTitle,
} from "./DroidTextGeneration.ts";

describe("parseDroidThreadTitle", () => {
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
