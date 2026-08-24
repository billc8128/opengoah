/**
 * Welcome-panel snapshot: read-only Ledger facts rendered into fixed slots.
 *
 * Zero daemon dependency and zero blocking: the workspace ledger is a local
 * SQLite file opened read-only; a missing ledger (fresh workspace) renders
 * placeholder slots, so panel height never changes between runs (pi/omp
 * fixed-slot pattern).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WelcomeSnapshot {
  root: { id: string; objective: string; phase: string } | null;
  team: Array<{ agent: string; status: string }>;
  handoffs: Array<{ agent: string; result: string }>;
  provider: string;
  model: string;
}

export const WELCOME_TEAM_SLOTS = 3;
export const WELCOME_HANDOFF_SLOTS = 2;

interface GoalRow { id: string; objective: string; phase: string; parent_id: string | null; owner: string }
interface HandoffRow { actor: string; data: string }

/** Read workspace facts from the ledger file; a missing or unreadable ledger yields an empty snapshot. */
export function welcomeSnapshot(stateDir: string, runnerEnv: Record<string, string | undefined>): WelcomeSnapshot {
  const database = join(stateDir, "ledger.sqlite");
  if (!existsSync(database)) return { root: null, team: [], handoffs: [], provider: runnerEnv.GOAH_PI_PROVIDER ?? "", model: runnerEnv.GOAH_PI_MODEL ?? "" };
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const goals = db.prepare("SELECT id, objective, phase, parent_id, owner FROM goals").all() as unknown as GoalRow[];
    const root = goals.find((goal) => goal.parent_id === null && goal.owner === "ceo" && goal.phase !== "complete") ?? goals.find((goal) => goal.parent_id === null) ?? null;
    const team = (db.prepare("SELECT owner AS agent, phase AS status FROM goals WHERE parent_id IS NOT NULL ORDER BY id").all() as unknown as Array<{ agent: string; status: string }>).slice(0, WELCOME_TEAM_SLOTS);
    const handoffRows = (db.prepare("SELECT actor, data FROM events WHERE type='handoff.recorded' ORDER BY seq DESC LIMIT ?").all(WELCOME_HANDOFF_SLOTS) as unknown as HandoffRow[]).reverse();
    const handoffs = handoffRows.flatMap((row) => {
      try {
        const data = JSON.parse(row.data) as { results?: unknown[] };
        const result = Array.isArray(data.results) && typeof data.results[0] === "string" ? data.results[0] : "";
        return [{ agent: row.actor, result }];
      } catch { return [{ agent: row.actor, result: "" }]; }
    });
    return { root: root ? { id: root.id, objective: root.objective, phase: root.phase } : null, team, handoffs, provider: runnerEnv.GOAH_PI_PROVIDER ?? "", model: runnerEnv.GOAH_PI_MODEL ?? "" };
  } finally { db.close(); }
}

/** Render the snapshot into a fixed-height block of plain lines (fixed slots keep layout stable). */
export function renderWelcome(snapshot: WelcomeSnapshot, hasHistory: boolean): string[] {
  const lines: string[] = [];
  lines.push(`Goah — ${hasHistory ? "Welcome back!" : "Welcome!"}  ${snapshot.provider ? `${snapshot.provider}/${snapshot.model}` : "(unconfigured)"}`);
  lines.push("");
  lines.push(snapshot.root ? `Goal: ${snapshot.root.objective} [${snapshot.root.phase}]` : "Goal: none yet — type one to start");
  lines.push("");
  lines.push("Agents:");
  for (let index = 0; index < WELCOME_TEAM_SLOTS; index += 1) {
    const member = snapshot.team[index];
    lines.push(member ? `  ${member.agent} — ${member.status}` : "  ·");
  }
  lines.push("");
  lines.push("Recent work:");
  for (let index = 0; index < WELCOME_HANDOFF_SLOTS; index += 1) {
    const handoff = snapshot.handoffs[index];
    lines.push(handoff ? `  ${handoff.agent}: ${handoff.result || "(handed off)"}` : "  ·");
  }
  lines.push("");
  lines.push("Tips: type a goal · /model ID switches · /setup re-runs onboarding · /status inspects · /quit exits");
  return lines;
}
