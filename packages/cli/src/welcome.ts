/**
 * Startup snapshot: compact organization summary plus resumable conversation Items.
 *
 * Zero daemon dependency: the workspace Ledger is opened read-only before the
 * live Turn subscription begins.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerDisplay } from "./live-config.js";
import { tuiTheme } from "./tui-theme.js";

export interface WelcomeSnapshot {
  root: { id: string; objective: string; phase: string } | null;
  team: Array<{ agent: string }>;
  handoffs: Array<{ agent: string; result: string }>;
  conversation: Array<{ speaker: string; text: string }>;
  runner: string;
  target: string;
}

export const WELCOME_TEAM_SLOTS = 3;
export const WELCOME_HANDOFF_SLOTS = 2;
export const WELCOME_CONVERSATION_SLOTS = 240;
export const GOAH_TERMINAL_MARK = [
  "        ▄▄",
  "      ▄▀▀  █▄",
  "   ▄▄██▀█▀▀ █",
  "  █▀ █ ████ █ ▄█",
  "   ▀▀██▄█▀▄█▀▀▀",
  "      ▀▄▄▄▀▀",
];

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
    const childGoals = goals.filter((goal) => goal.parent_id !== null);
    const owners = [...new Set(childGoals.map((goal) => goal.owner))];
    const team = owners.map((agent) => ({ agent })).slice(0, WELCOME_TEAM_SLOTS);
    const handoffRows = (db.prepare("SELECT actor, data FROM events WHERE type='handoff.recorded' ORDER BY seq DESC LIMIT ?").all(WELCOME_HANDOFF_SLOTS) as unknown as HandoffRow[]).reverse();
    const handoffs = handoffRows.flatMap((row) => {
      try {
        const data = JSON.parse(row.data) as { outcome?: unknown };
        const result = typeof data.outcome === "string" ? data.outcome.replaceAll("_", " ") : "";
        return [{ agent: row.actor, result }];
      } catch { return [{ agent: row.actor, result: "" }]; }
    });
    const itemRows = db.prepare("SELECT i.type,i.data FROM turn_items i JOIN turns t ON t.id=i.turn_id JOIN threads th ON th.id=t.thread_id WHERE th.agent='ceo' AND t.source='human' AND t.status<>'in_progress' AND i.status='completed' AND i.type IN ('user_message','assistant_message') AND (i.type='user_message' OR t.binding_kind='human' OR EXISTS (SELECT 1 FROM events e WHERE e.stream_id='turn:'||t.id AND e.type='response.committed' AND json_extract(e.data,'$.messageItemId')=i.id)) ORDER BY i.rowid DESC LIMIT ?").all(WELCOME_CONVERSATION_SLOTS) as unknown as Array<{ type: string; data: string }>;
    const conversation = itemRows.reverse().flatMap((row) => { try { const data = JSON.parse(row.data) as { text?: unknown }; return typeof data.text === "string" ? [{ speaker: row.type === "user_message" ? "You" : "Goah", text: data.text }] : []; } catch { return []; } });
    return { root: root ? { id: root.id, objective: root.objective, phase: root.phase } : null, team, handoffs, conversation, runner: runner.runner, target: runner.target };
  } finally { db.close(); }
}

/** Render only meaningful state; empty workspaces stay compact. */
export function renderWelcome(snapshot: WelcomeSnapshot, hasHistory: boolean): string[] {
  const lines = ["", ...GOAH_TERMINAL_MARK.map((line) => tuiTheme.accent(line)), "", `  ${tuiTheme.strong(hasHistory ? "Welcome back." : "Ready when you are.")}`, `  ${tuiTheme.accent(snapshot.target)} ${tuiTheme.muted(`· ${snapshot.runner}`)}`];
  if (!snapshot.root) lines.push(`  ${tuiTheme.muted("Chat normally · /goal for durable work · /help")}`);
  if (snapshot.team.length) lines.push(`  ${tuiTheme.muted(`${snapshot.team.length} Goal Agent${snapshot.team.length === 1 ? "" : "s"} in the organization`)}`);
  lines.push("");
  return lines;
}
