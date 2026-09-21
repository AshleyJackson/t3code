import type { ProviderDriverKind, ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export type RuntimeModeChoice = {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
};

export const RUNTIME_MODE_CHOICES: ReadonlyArray<RuntimeModeChoice> = [
  {
    mode: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    mode: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    mode: "auto",
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
  },
  {
    mode: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

const DROID_RUNTIME_MODE_CHOICES: ReadonlyArray<RuntimeModeChoice> = [
  {
    mode: "approval-required",
    label: "Off",
    description: "Droid asks before every action.",
  },
  {
    mode: "auto-accept-edits",
    label: "Low",
    description: "Allow file edits and read-only commands.",
  },
  {
    mode: "medium-access",
    label: "Medium",
    description: "Allow reversible commands.",
  },
  {
    mode: "full-access",
    label: "High",
    description: "Allow all Droid actions without prompts.",
  },
];

export function runtimeModeChoicesForProvider(
  provider: ProviderDriverKind | string | undefined,
): ReadonlyArray<RuntimeModeChoice> {
  return provider === "droid" ? DROID_RUNTIME_MODE_CHOICES : RUNTIME_MODE_CHOICES;
}

export function normalizeRuntimeModeForProvider(
  provider: ProviderDriverKind | string | undefined,
  runtimeMode: RuntimeMode,
): RuntimeMode {
  if (provider === "droid") {
    return DROID_RUNTIME_MODE_CHOICES.some((choice) => choice.mode === runtimeMode)
      ? runtimeMode
      : "auto-accept-edits";
  }
  return RUNTIME_MODE_CHOICES.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : "auto-accept-edits";
}

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
