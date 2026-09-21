import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeRuntimeModeForProvider,
  runtimeModeChoicesForProvider,
  selectableChoices,
} from "./thread-settings-options";

const effortDescriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
    { id: "ultracode", label: "Ultracode" },
  ],
  currentValue: "high",
  promptInjectedValues: ["ultrathink"],
};

describe("selectableChoices", () => {
  it("hides prompt-injected and workflow-trigger choices, keeping declared order", () => {
    expect(selectableChoices(effortDescriptor).map((choice) => choice.id)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("runtime mode choices", () => {
  it("uses Droid access levels when the selected provider is Droid", () => {
    expect(runtimeModeChoicesForProvider("droid").map((choice) => choice.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "medium-access",
      "full-access",
    ]);
  });

  it("normalizes provider-incompatible modes to a safe fallback", () => {
    expect(normalizeRuntimeModeForProvider("droid", "auto")).toBe("auto-accept-edits");
    expect(normalizeRuntimeModeForProvider("codex", "medium-access")).toBe("auto-accept-edits");
  });
});
