import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";

import { droidTurnErrorMessage, isDroidUsageLimitError } from "./DroidDebug.ts";

it("recognizes Droid model usage exhaustion and gives an actionable message", () => {
  NodeAssert.equal(
    isDroidUsageLimitError({
      message: "Agent turn ended: model_usage_exhausted",
      errorType: "model_usage_exhausted",
    }),
    true,
  );
  NodeAssert.equal(
    droidTurnErrorMessage({ message: "Agent turn ended: model_usage_exhausted" }),
    "Droid usage limit reached. Send the message again once the limit resets.",
  );
});

it("leaves unrelated Droid errors intact", () => {
  NodeAssert.equal(
    droidTurnErrorMessage({ message: "The model is unavailable." }),
    "The model is unavailable.",
  );
});
