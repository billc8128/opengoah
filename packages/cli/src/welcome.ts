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
import type { RunnerDisplay } from "./live-config.js";
import { tuiTheme } from "./tui-theme.js";

export interface WelcomeSnapshot {
  root: { id: string; objective: string; phase: string } | null;
  team: Array<{ agent: string; status: string }>;
  handoffs: Array<{ agent: string; result: string }>;
  conversation: Array<{ speaker: string; text: string }>;
  runner: string;
  target: string;
}

export const WELCOME_TEAM_SLOTS = 3;
export const WELCOME_HANDOFF_SLOTS = 2;
export const WELCOME_CONVERSATION_SLOTS = 4;

interface GoalRow { id: string; objective: string; phase: string; parent_id: string | null; owner: string }
interface HandoffRow { actor: string; data: string }

/** Read workspace facts from the ledger file; a missing or unreadable ledger yields an empty snapshot. */
export function welcomeSnapshot(stateDir: string, runner: RunnerDisplay): WelcomeSnapshot {
  const database = join(stateDir, "ledger.sqlite");
  if (!existsSync(database)) return { root: null, team: [], handoffs: [], conversation: [], runner: runner.runner, target: runner.target };
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const goals = db.prepare("SELECT id, objective, phase, parent_id, owner FROM goals").all() as unknown as GoalRow[];
    const root = goals.find((goal) => goal.parent_id === null && goal.owner === "ceo" && goal.phase !== "complete") ?? goals.find((goal) => goal.parent_id === null) ?? null;
    const wakeRows = db.prepare("SELECT agent, status FROM wakes ORDER BY enqueued_seq DESC").all() as unknown as Array<{ agent: string; status: string }>;
    const childGoals = goals.filter((goal) => goal.parent_id !== null);
    const owners = [...new Set(childGoals.map((goal) => goal.owner))];
    const team = owners.map((agent) => ({ agent, status: wakeRows.find((wake) => wake.agent === agent && ["running", "leased", "queued"].includes(wake.status))?.status ?? childGoals.find((goal) => goal.owner === agent)?.phase ?? "idle" })).slice(0, WELCOME_TEAM_SLOTS);
    const handoffRows = (db.prepare("SELECT actor, data FROM events WHERE type='handoff.recorded' ORDER BY seq DESC LIMIT ?").all(WELCOME_HANDOFF_SLOTS) as unknown as HandoffRow[]).reverse();
    const handoffs = handoffRows.flatMap((row) => {
      try {
        const data = JSON.parse(row.data) as { results?: unknown[] };
        const result = Array.isArray(data.results) && typeof data.results[0] === "string" ? data.results[0] : "";
        return [{ agent: row.actor, result }];
      } catch { return [{ agent: row.actor, result: "" }]; }
    });
    const conversationRows = db.prepare("SELECT actor, type, data FROM events WHERE type IN ('mail.put','handoff.recorded') ORDER BY seq DESC LIMIT 30").all() as unknown as Array<{ actor: string; type: string; data: string }>;
    const conversation = conversationRows.reverse().flatMap((row) => conversationLine(row)).slice(-WELCOME_CONVERSATION_SLOTS);
    return { root: root ? { id: root.id, objective: root.objective, phase: root.phase } : null, team, handoffs, conversation, runner: runner.runner, target: runner.target };
  } finally { db.close(); }
}

/** Render only meaningful state; empty workspaces stay compact. */
export function renderWelcome(snapshot: WelcomeSnapshot, hasHistory: boolean): string[] {
  const lines = ["", `  ${tuiTheme.strong(hasHistory ? "Welcome back." : "Ready when you are.")}`];
  if (!snapshot.root) lines.push(`  ${tuiTheme.muted("Chat normally, or use /goal for durable work.")}`);
  if (snapshot.team.length) lines.push(`  ${tuiTheme.muted(`${snapshot.team.length} Goal Agent${snapshot.team.length === 1 ? "" : "s"} in the organization`)}`);
  lines.push("");
  return lines;
}

function conversationLine(row: { actor: string; type: string; data: string }): Array<{ speaker: string; text: string }> {
  try {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (row.type === "mail.put") {
      const snapshot = data.snapshot && typeof data.snapshot === "object" ? data.snapshot as Record<string, unknown> : {};
      if (snapshot.from !== "human" || snapshot.to !== "ceo") return [];
      const body = snapshot.body && typeof snapshot.body === "object" ? snapshot.body as Record<string, unknown> : {};
      const text = typeof body.message === "string" ? body.message : typeof snapshot.body === "string" ? snapshot.body : "";
      return text ? [{ speaker: "You", text: shorten(text) }] : [];
    }
    if (row.actor !== "ceo") return [];
    const results = Array.isArray(data.results) ? data.results.filter((item): item is string => typeof item === "string") : [];
    const observations = Array.isArray(data.observations) ? data.observations.filter((item): item is string => typeof item === "string") : [];
    const text = results[0] ?? observations[0] ?? "";
    return text ? [{ speaker: "CEO", text: shorten(text) }] : [];
  } catch { return []; }
}
function shorten(value: string): string { return value.length > 120 ? `${value.slice(0, 117)}…` : value; }
