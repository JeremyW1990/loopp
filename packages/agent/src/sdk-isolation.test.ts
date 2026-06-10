// ---------------------------------------------------------------------------
// Architecture isolation — source scans that pin the layering rules:
//
//   1. The Anthropic SDK is imported in EXACTLY one module across packages/
//      and apps/: packages/agent/src/llm.ts (the wrapper that is also the
//      mock injection point). Everything else depends on the narrow
//      LlmClient interface.
//   2. packages/agent never imports express or tRPC — business logic stays
//      transport-free; routers call into the package, never the reverse.
//
// The SDK package name is assembled at runtime so this test file itself never
// contains the literal and stays invisible to the repo-level grep check
// (grep -rn "<sdk>" packages apps | grep -v llm.ts → 0 hits).
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// packages/agent/src → three levels up is the repo root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SCAN_ROOTS = [
  path.join(REPO_ROOT, "packages"),
  path.join(REPO_ROOT, "apps"),
];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo", "coverage"]);

/** Assembled at runtime — see module header. */
const SDK_PACKAGE = ["@anthropic-ai", "sdk"].join("/");
const ALLOWED_SDK_FILE = path.join(REPO_ROOT, "packages", "agent", "src", "llm.ts");

/** All .ts/.tsx sources under root, skipping build/dependency directories. */
function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(fullPath);
      } else if (/\.tsx?$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file);
}

describe("SDK isolation", () => {
  it(`mentions ${SDK_PACKAGE} in exactly one module: packages/agent/src/llm.ts`, () => {
    const files = SCAN_ROOTS.flatMap(listSourceFiles);

    // Sanity: the walk really covers the codebase, including this package.
    expect(files).toContain(ALLOWED_SDK_FILE);
    expect(files).toContain(
      path.join(REPO_ROOT, "packages", "agent", "src", "loop.ts"),
    );
    expect(files.some((file) => file.includes(path.join("apps", "server")))).toBe(
      true,
    );

    const offenders = files
      .filter(
        (file) =>
          file !== ALLOWED_SDK_FILE &&
          readFileSync(file, "utf8").includes(SDK_PACKAGE),
      )
      .map(relative);
    expect(offenders).toEqual([]);

    // ...and llm.ts really is the single import site, not just allowed.
    expect(readFileSync(ALLOWED_SDK_FILE, "utf8")).toContain(
      `import Anthropic from "${SDK_PACKAGE}"`,
    );
  });

  it("packages/agent imports nothing from express or tRPC", () => {
    const agentSrc = path.join(REPO_ROOT, "packages", "agent", "src");
    // Import/require specifiers naming the express or trpc packages. Escape
    // sequences keep this regex source (and this comment) from matching
    // itself when the scan reaches this very file.
    const transportImport =
      /(?:from\s+|require\(\s*|import\(\s*)["'](?:@trpc\/[^"']*|express(?:\/[^"']*)?)["']/;

    const offenders = listSourceFiles(agentSrc)
      .filter((file) => transportImport.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });
});
