import { it } from "@effect/vitest";
import * as NodeAssert from "node:assert/strict";

import { droidErrorMessage, droidTurnErrorMessage, isDroidUsageLimitError } from "./DroidDebug.ts";

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

it("turns regional availability errors into an actionable message", () => {
  NodeAssert.equal(
    droidErrorMessage({
      message:
        '400 {"detail":"Provider not available in this region","status":400,"title":"Bad Request","requestId":"syd1:sfo1:qgs5p-1791086197803-8d22236c8bc6"}',
    }),
    "Droid is not available in this region. Try a different provider, or contact Factory support if this is unexpected. Reference: syd1:sfo1:qgs5p-1791086197803-8d22236c8bc6.",
  );
});

it("turns authentication errors into an actionable message", () => {
  NodeAssert.equal(
    droidErrorMessage({ message: "401 Unauthorized", metadata: { requestId: "request-1" } }),
    "Droid authentication failed. Reconnect Droid in Settings → Providers, then try again. Reference: request-1.",
  );
});
