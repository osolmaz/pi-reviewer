import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@osolmaz/pi-reviewer";
const MAX_PARENT_SEARCH = 4;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function packageVersion(startDirectory = dirname(fileURLToPath(import.meta.url))): string {
  let directory = startDirectory;
  for (let depth = 0; depth < MAX_PARENT_SEARCH; depth += 1) {
    const metadataPath = join(directory, "package.json");
    if (existsSync(metadataPath)) return readVersion(metadataPath);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Pi Reviewer package metadata was not found");
}

function readVersion(metadataPath: string): string {
  const metadata: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!isRecord(metadata) || metadata["name"] !== PACKAGE_NAME) {
    throw new Error("Pi Reviewer package metadata has an invalid name");
  }
  const version = metadata["version"];
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error("Pi Reviewer package metadata has an invalid version");
  }
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
