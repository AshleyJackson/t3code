import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getRuntimeModeConfig,
  getRuntimeModeOptions,
  normalizeRuntimeModeForProvider,
} from "./runtimeModePresentation";

describe("runtime mode presentation", () => {
  it("shows medium access only for Droid", () => {
    expect(getRuntimeModeOptions(ProviderDriverKind.make("codex"))).not.toContain("medium-access");
    expect(getRuntimeModeOptions(ProviderDriverKind.make("droid"))).toContain("medium-access");
  });

  it("uses Droid-specific access labels", () => {
    expect(getRuntimeModeConfig(ProviderDriverKind.make("droid"))["full-access"].label).toBe(
      "High",
    );
    expect(getRuntimeModeConfig(ProviderDriverKind.make("codex"))["full-access"].label).toBe(
      "Full access",
    );
  });

  it("normalizes a Droid-only mode when switching providers", () => {
    expect(normalizeRuntimeModeForProvider(ProviderDriverKind.make("codex"), "medium-access")).toBe(
      "auto-accept-edits",
    );
    expect(normalizeRuntimeModeForProvider(ProviderDriverKind.make("droid"), "medium-access")).toBe(
      "medium-access",
    );
  });
});
