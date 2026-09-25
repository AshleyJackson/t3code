// @effect-diagnostics nodeBuiltinImport:off - Executable resolution is synchronous and local.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const isFile = (path: string): boolean => {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Node's Windows child-process lookup selects the npm droid.cmd shim before
 * the native droid.exe, even when both are on PATH. The SDK cannot use the
 * shim because it spawns without a shell.
 */
export function resolveDroidExecutablePath(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32" || binaryPath.includes("\\") || binaryPath.includes("/")) {
    return binaryPath;
  }

  if (NodePath.win32.extname(binaryPath).toLowerCase() === ".exe") {
    return binaryPath;
  }

  for (const pathEntry of (environment.PATH ?? "").split(";")) {
    const directory = pathEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const nativePath = NodePath.win32.join(directory, `${binaryPath}.exe`);
    if (isFile(nativePath)) return nativePath;
  }

  return binaryPath;
}
