import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function restoreSinglePackageState(root) {
  const cli = join(root, "packages", "cli");
  const modules = join(cli, "node_modules");
  const manifestBackup = join(modules, ".publish-manifest.json");
  const originalDist = join(modules, ".dist-original");

  if (existsSync(manifestBackup)) {
    writeFileSync(join(cli, "package.json"), readFileSync(manifestBackup));
    rmSync(manifestBackup, { force: true });
  }
  if (existsSync(originalDist)) {
    rmSync(join(cli, "dist"), { recursive: true, force: true });
    renameSync(originalDist, join(cli, "dist"));
  }

  rmSync(join(modules, ".bundle-stage"), { recursive: true, force: true });
  for (const name of ["goah-ledger-contract", "goah-ledger-sqlite", "goah-runner-pi", "goah-supervisor", "goah-testkit"]) {
    rmSync(join(modules, name), { recursive: true, force: true });
  }
}
