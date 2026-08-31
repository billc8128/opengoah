import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planNpmUpdate, runQuiet } from "./update.js";

test("self-update preserves global and custom-prefix installation modes", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "goah-update-")));
  const globalRoot = join(directory, "global");
  const globalPackage =
    process.platform === "win32"
      ? join(globalRoot, "node_modules", "@goah", "cli")
      : join(globalRoot, "lib", "node_modules", "@goah", "cli");
  const customPackage = join(directory, "custom", "node_modules", "@goah", "cli");
  mkdirSync(globalPackage, { recursive: true });
  mkdirSync(customPackage, { recursive: true });
  assert.deepEqual(planNpmUpdate(globalPackage, globalRoot, "1.2.3", "npm"), {
    command: "npm",
    args: ["install", "--global", "@goah/cli@1.2.3"],
    mode: "global",
    prefix: globalRoot,
  });
  assert.deepEqual(planNpmUpdate(customPackage, globalRoot, "1.2.3", "npm"), {
    command: "npm",
    args: ["install", "--prefix", join(directory, "custom"), "@goah/cli@1.2.3"],
    mode: "prefix",
    prefix: join(directory, "custom"),
  });
});

test("self-update refuses source checkouts", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "goah-source-")));
  assert.throws(
    () => planNpmUpdate(directory, join(directory, "global"), "1.2.3"),
    /source checkout/,
  );
});

test("self-update keeps successful npm implementation output quiet and preserves failures", async () => {
  await runQuiet(process.execPath, [
    "-e",
    "console.log('install chatter'); console.error('npm warn chatter')",
  ]);
  await assert.rejects(
    runQuiet(process.execPath, ["-e", "console.error('useful install failure'); process.exit(1)"]),
    /useful install failure/,
  );
});
