import os from "node:os";
import path from "node:path";

export function regularPiAgentDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent");
}

export function regularPiAuthPath(homeDir = os.homedir()): string {
  return path.join(regularPiAgentDir(homeDir), "auth.json");
}
