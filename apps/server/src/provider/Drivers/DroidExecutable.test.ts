import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";

import { resolveDroidExecutablePath } from "./DroidExecutable.ts";

it("prefers a native executable over an earlier Windows shim", () => {
  const nativePath = "C:\\Users\\ashley\\bin\\droid.exe";
  NodeAssert.equal(
    resolveDroidExecutablePath(
      "droid",
      { PATH: "C:\\nvm4w\\nodejs;C:\\Users\\ashley\\bin" },
      "win32",
    ),
    nativePath,
  );
});

it("leaves non-Windows and explicit paths unchanged", () => {
  NodeAssert.equal(
    resolveDroidExecutablePath("droid", { PATH: "/usr/local/bin" }, "linux"),
    "droid",
  );
  NodeAssert.equal(
    resolveDroidExecutablePath("C:\\tools\\droid.cmd", { PATH: "C:\\tools" }, "win32"),
    "C:\\tools\\droid.cmd",
  );
});
