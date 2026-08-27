import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "goah-pack-"));
const artifacts = join(temp, "artifacts");
const app = join(temp, "app");
const scriptlessApp = join(temp, "scriptless-app");
mkdirSync(artifacts); mkdirSync(app); mkdirSync(scriptlessApp);

const pack = () => JSON.parse(execFileSync("npm", ["pack", "--workspace", "packages/cli", "--pack-destination", artifacts, "--json"], { cwd: root, encoding: "utf8" }));
pack(); // The release pipeline packs twice (pack:smoke, then publish); the second tarball is what ships.
const packed = pack();
const tarball = join(artifacts, packed[0].filename);
if ((packed[0].bundled?.length ?? 0) !== 0) throw new Error(`single distribution still declares bundled modules: ${JSON.stringify(packed[0].bundled)}`);

const unpacked = join(temp, "unpacked");
mkdirSync(unpacked);
execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
const shipped = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8"));
const files = packed[0].files.map((file) => file.path);
const nested = files.filter((file) => file.startsWith("node_modules/"));
const required = [
  "dist/console/index.html", "dist/THIRD-PARTY-NOTICES.md",
  "dist/index.d.ts", "dist/cli.d.ts", "dist/kernel.d.ts", "dist/transcript.d.ts", "dist/execution.d.ts",
  "dist/sqlite.d.ts", "dist/supervisor.d.ts", "dist/runner-pi.d.ts", "dist/testkit.d.ts",
  "dist/pi-worker.js", "dist/verification-worker.js", "dist/faux-runner-worker.js",
];
const missing = required.filter((file) => !files.includes(file));
if (Object.keys(shipped.dependencies ?? {}).length !== 0 || shipped.bundledDependencies || shipped.bundleDependencies || nested.length !== 0 || missing.length !== 0) {
  throw new Error(`single distribution is not self-contained: deps=${Object.keys(shipped.dependencies ?? {}).length} bundled=${JSON.stringify(shipped.bundledDependencies ?? null)} nested=${nested.length} missing=${missing.join(",")}`);
}
const notices = readFileSync(join(unpacked, "package", "dist", "THIRD-PARTY-NOTICES.md"), "utf8");
if (/License: unknown|license text not shipped/i.test(notices)) throw new Error("third-party notices contain unresolved license text");

writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "goah-install-smoke", private: true, version: "1.0.0" }, null, 2)}\n`);
execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: app, stdio: "pipe" });
writeFileSync(join(scriptlessApp, "package.json"), `${JSON.stringify({ name: "goah-scriptless-install-smoke", private: true, version: "1.0.0" }, null, 2)}\n`);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: scriptlessApp, stdio: "pipe" });
execFileSync(process.execPath, ["--input-type=module", "-e", `
  const modules = await Promise.all([
    import('@goah/cli/kernel'), import('@goah/cli/transcript'), import('@goah/cli/execution'),
    import('@goah/cli/sqlite'), import('@goah/cli/supervisor'), import('@goah/cli/runner-pi'), import('@goah/cli/testkit'), import('@goah/cli')
  ]);
  const names = ['controlStream','replayTranscript','assertHandoff','SqliteLedger','Supervisor','ProcessRunner','SimulatedClock','controlEndpoint'];
  for (let index = 0; index < names.length; index += 1) if (typeof modules[index][names[index]] !== 'function') throw new Error('missing public subpath export: '+names[index]);
  const paths = [modules[5].piWorkerPath(), modules[5].verificationWorkerPath(), modules[6].fauxRunnerWorkerPath()];
  const { existsSync } = await import('node:fs');
  for (const path of paths) if (!existsSync(path)) throw new Error('public worker path does not exist: '+path);
`], { cwd: app, stdio: "pipe" });
if (existsSync(join(app, "node_modules", "@goah", "cli", "node_modules"))) throw new Error("installed CLI still nests a dependency tree");

const consumer = [
  `import { createRuntime } from "@goah/cli";`,
  `import { controlStream } from "@goah/cli/kernel";`,
  `import { replayTranscript } from "@goah/cli/transcript";`,
  `import { assertHandoff } from "@goah/cli/execution";`,
  `import { SqliteLedger } from "@goah/cli/sqlite";`,
  `import { Supervisor } from "@goah/cli/supervisor";`,
  `import { ProcessRunner } from "@goah/cli/runner-pi";`,
  `import { SimulatedClock } from "@goah/cli/testkit";`,
  `void [createRuntime, controlStream, replayTranscript, assertHandoff, SqliteLedger, Supervisor, ProcessRunner, SimulatedClock];`,
].join("\n");
writeFileSync(join(app, "consumer.ts"), `${consumer}\n`);
writeFileSync(join(app, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true, noEmit: true, skipLibCheck: false, typeRoots: [join(root, "node_modules", "@types")] }, files: ["consumer.ts"] }, null, 2)}\n`);
try {
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: app, stdio: "pipe" });
} catch (error) {
  const output = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : String(error);
  throw new Error(`packed TypeScript declarations failed consumer compilation:\n${output}`);
}

execFileSync("git", ["init", "-b", "main"], { cwd: app });
execFileSync("git", ["config", "user.email", "goah-pack@example.test"], { cwd: app });
execFileSync("git", ["config", "user.name", "GOAH Pack Test"], { cwd: app });
execFileSync("git", ["add", "package.json", "package-lock.json"], { cwd: app });
execFileSync("git", ["commit", "-m", "initial"], { cwd: app });

const bin = join(app, "node_modules", ".bin", process.platform === "win32" ? "goah.cmd" : "goah");
const scriptlessBin = join(scriptlessApp, "node_modules", ".bin", process.platform === "win32" ? "goah.cmd" : "goah");
if (!execFileSync(scriptlessBin, ["--version"], { cwd: scriptlessApp, encoding: "utf8" }).includes(shipped.version)) throw new Error("--ignore-scripts install did not produce a working CLI");
const run = (...args) => execFileSync(bin, args, { cwd: app, encoding: "utf8" });
const updateDryRun = run("update", "--dry-run", "--version", "99.0.0");
if (!updateDryRun.includes("npm install --prefix") || !updateDryRun.includes("@goah/cli@99.0.0")) throw new Error("packed CLI self-update did not preserve its prefix installation");
run("init", "--provider", "faux", "--agent", "worker");
const doctor = JSON.parse(run("doctor", "--json"));
if (!doctor.ok) throw new Error(`packed CLI doctor failed: ${JSON.stringify(doctor)}`);
run("goal-create", "--id", "pack-root", "--owner", "ceo", "--objective", "Coordinate the installed CLI smoke test");
run("goal-create", "--id", "pack-smoke", "--parent", "pack-root", "--owner", "worker", "--objective", "Prove the installed CLI works", "--observation-method", "Accept a fresh evidence-backed handoff from the installed CLI");
run("goal-pause", "pack-smoke");
run("goal-resume", "pack-smoke");
const wake = JSON.parse(run("run-once")).wake;
const status = JSON.parse(run("status"));
if (wake?.status !== "consumed" || status.wakes?.length !== 1 || status.recentHandoffs?.length !== 1) throw new Error("packed CLI did not complete the first handoff");
const threads = JSON.parse(run("thread", "list"));
const thread = threads.find((candidate) => candidate.turnCount > 0);
const detail = JSON.parse(run("thread", "show", thread.threadId));
const exported = join(app, "thread.json");
run("thread", "export", thread.threadId, "--output", exported);
if (thread.turnCount !== 1 || detail.turns?.[0]?.id !== wake.turnId || detail.turns[0].items.length === 0 || JSON.parse(readFileSync(exported, "utf8")).redacted !== true) throw new Error("packed CLI thread inspector failed");
run("goal-show", "pack-smoke");
const completedGoal = JSON.parse(run("goal-complete", "pack-smoke", "--reason", "fresh packed-runner handoff satisfies the observation method", "--evidence", String(status.recentHandoffs.at(-1).seq))).goal;
if (completedGoal.phase !== "complete" || completedGoal.revision !== 3) throw new Error("packed CLI goal lifecycle failed");

process.stdout.write(`${JSON.stringify({ ok: true, app, packages: 1, bundledModules: 0, wake: wake.id }, null, 2)}\n`);
