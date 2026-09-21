import { describe, expect, it } from "vite-plus/test";

import { stripTerminalControl } from "./terminalOutput.js";

describe("stripTerminalControl", () => {
  it("removes SGR, OSC, and cursor escape sequences while preserving text layout", () => {
    expect(
      stripTerminalControl(
        "\u001b[1mRUN\u001b[49m \u001b]8;;https://example.com\u0007git\u001b]8;;\u0007\r\nnext",
      ),
    ).toBe("RUN git\r\nnext");
  });

  it("removes other non-printing controls but keeps tabs and newlines", () => {
    expect(stripTerminalControl("a\tb\u0007\nc\u000bd\u000ce\u001fd")).toBe("a\tb\ncded");
  });
});
