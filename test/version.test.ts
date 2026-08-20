import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { packageVersion } from "../src/version.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-reviewer-version-"));
  roots.push(root);
  return root;
}

describe("package version", () => {
  it("reads the nearest pi-reviewer package metadata", () => {
    const root = temporaryRoot();
    const nested = join(root, "dist", "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@osolmaz/pi-reviewer", version: "1.2.3-beta.1" }),
    );

    expect(packageVersion(nested)).toBe("1.2.3-beta.1");
  });

  it("rejects package metadata for another package", () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "other", version: "1.2.3" }));

    expect(() => packageVersion(root)).toThrow("invalid name");
  });
});
