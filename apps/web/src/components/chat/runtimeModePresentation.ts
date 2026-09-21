import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import {
  LockIcon,
  LockOpenIcon,
  type LucideIcon,
  PenLineIcon,
  ShieldIcon,
  SparklesIcon,
} from "lucide-react";
import { runtimeModeConfig } from "./runtimeModeConfig";

export interface RuntimeModePresentation {
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const DROID_RUNTIME_MODE_CONFIG: Record<RuntimeMode, RuntimeModePresentation> = {
  "approval-required": {
    label: "Off",
    description: "Droid asks before every action.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Low",
    description: "Allow file edits and read-only commands.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "An AI reviewer approves routine actions; risky ones still ask.",
    icon: SparklesIcon,
  },
  "medium-access": {
    label: "Medium",
    description: "Allow reversible commands.",
    icon: ShieldIcon,
  },
  "full-access": {
    label: "High",
    description: "Allow all Droid actions without prompts.",
    icon: LockOpenIcon,
  },
};

const BASE_RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const DROID_RUNTIME_MODE_OPTIONS: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "medium-access",
  "full-access",
];

export function getRuntimeModeConfig(
  provider: ProviderDriverKind,
): Record<RuntimeMode, RuntimeModePresentation> {
  return provider === ProviderDriverKind.make("droid")
    ? DROID_RUNTIME_MODE_CONFIG
    : runtimeModeConfig;
}

export function getRuntimeModeOptions(provider: ProviderDriverKind): ReadonlyArray<RuntimeMode> {
  return provider === ProviderDriverKind.make("droid")
    ? DROID_RUNTIME_MODE_OPTIONS
    : BASE_RUNTIME_MODE_OPTIONS;
}

export function normalizeRuntimeModeForProvider(
  provider: ProviderDriverKind,
  runtimeMode: RuntimeMode,
): RuntimeMode {
  return getRuntimeModeOptions(provider).includes(runtimeMode) ? runtimeMode : "auto-accept-edits";
}
