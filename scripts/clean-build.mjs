import { rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
for (const workspace of ["apps/console", "apps/web", "examples/minimal", "examples/repo-guardian", "packages/cli", "packages/ledger-contract", "packages/ledger-sqlite", "packages/runner-pi", "packages/supervisor", "packages/testkit"]) {
  rmSync(join(root, workspace, "dist"), { recursive: true, force: true });
}
