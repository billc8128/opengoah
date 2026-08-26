import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteLedger } from "goah-ledger-sqlite";
import { piWorkerPath, ProcessRunner } from "goah-runner-pi";
import { renderDashboard, runSupervisorDaemon, Supervisor } from "goah-supervisor";
import { fauxRunnerWorkerPath } from "goah-testkit";

const repo = process.env.GOAH_GUARD_REPO ?? process.cwd();
const stateId = createHash("sha256").update(repo).digest("hex").slice(0, 16);
const stateDir = process.env.GOAH_GUARD_STATE ?? join(homedir(), ".goah", "repo-guardian", stateId);
mkdirSync(stateDir, { recursive: true });
const ledger = new SqliteLedger(join(stateDir, "guardian.sqlite"));
const model = process.env.GOAH_PI_MODEL;
const piEnv = model ? {
  GOAH_PI_MODEL: model,
  GOAH_PI_PROVIDER: process.env.GOAH_PI_PROVIDER ?? "anthropic",
  ...forwardEnv(["GOAH_PI_BASE_URL", "GOAH_PI_MODEL_CAPABILITIES", "GOAH_PI_COMPACT_AT_TOKENS", "GOAH_PI_RETAIN_CONTEXT_TOKENS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ARK_API_KEY"]),
} : null;
const runner = new ProcessRunner(model
  ? { command: process.execPath, args: [piWorkerPath()], cwd: repo, env: piEnv! }
  : { command: process.execPath, args: [fauxRunnerWorkerPath()], cwd: repo, env: { GOAH_FAUX_STEPS: JSON.stringify([{ handoff: { handoff: { observations: ["test status collected"], results: [], nextSteps: ["check again"] }, mail: [], nextWakeAt: new Date(Date.now() + 86_400_000).toISOString() } }]) } });
const supervisor = new Supervisor(ledger, runner, new class { now(): Date { return new Date(); } }(), {
  silence: { notify: "human" },
  retryPolicy: { maxAttempts: 2, baseDelayMs: 5_000 },
  profiles: [{
    agent: "guardian",
    role: "child",
    systemPrompt: "Keep this repository's tests green. Run the configured tests with bash and interpret the concrete output yourself. If they fail, diagnose from evidence, make the smallest safe code change, rerun tests, and commit verified work with Git when appropriate. Manage branches or worktrees yourself when concurrent work could conflict. Never claim a repair without command evidence.",
  }],
});

if (!ledger.goal("repo-health")) supervisor.createGoal({ id: "repo-health", parentId: null, objective: "Keep the repository tests green", observationMethod: "Run the configured repository test command with bash and inspect its fresh output.", verificationMethod: "Rerun the repository test command and cite the successful Tool Result.", owner: "guardian", phase: "active", revision: 0 });
supervisor.planWake("guardian", new Date().toISOString(), "initial repository health check", "supervisor");

if (process.argv.includes("--daemon")) {
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort()); process.on("SIGINT", () => controller.abort());
  await runSupervisorDaemon(supervisor, { signal: controller.signal });
} else {
  await supervisor.runAvailable(1, model ? 10 : 1);
  writeFileSync(join(stateDir, "status.html"), renderDashboard(ledger));
  ledger.close();
}

function forwardEnv(names: string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}
