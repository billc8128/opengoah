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
  turns: WelcomeTurnSnapshot[];
  runner: string;
  target: string;
}

export interface WelcomeTurnSnapshot {
  id: string;
  triggerKind: "user_message" | "wake";
  status: "in_progress" | "completed" | "failed" | "interrupted";
  users: string[];
  responses: string[];
  error: string | null;
}

export const WELCOME_TEAM_SLOTS = 3;
export const WELCOME_HANDOFF_SLOTS = 2;
export const WELCOME_TURN_SLOTS = 120;
export const GOAH_TERMINAL_MARK = [
  "⠀⠀⠀⢀⣴⠟⠛⠲⡀⠀⠀⠀",
  "⠀⠀⢀⣿⣥⠶⠶⠞⢻⠛⠒⠀",
  "⣰⠞⢻⡏⣰⣾⣶⡄⢸⡟⢳⡄",
  "⠻⣦⣸⣇⣙⣿⣟⣁⣿⣴⠾⠃",
  "⠀⠀⠉⢿⡉⠉⣉⣿⠃⠀⠀⠀",
  "⠀⠀⠀⠈⠛⠛⠋⠁⠀⠀⠀⠀",
];

interface GoalRow {
  id: string;
  objective: string;
  phase: string;
  parent_id: string | null;
  owner: string;
}
interface HandoffRow {
  actor: string;
  data: string;
}
interface ConversationTurnRow {
  id: string;
  trigger_kind: "user_message" | "wake";
  status: "in_progress" | "completed" | "failed" | "interrupted";
  error: string | null;
}

/** Read workspace facts from the ledger file; a missing or unreadable ledger yields an empty snapshot. */
export function welcomeSnapshot(stateDir: string, runner: RunnerDisplay): WelcomeSnapshot {
  const database = join(stateDir, "ledger.sqlite");
  if (!existsSync(database))
    return {
      root: null,
      team: [],
      handoffs: [],
      turns: [],
      runner: runner.runner,
      target: runner.target,
    };
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const goals = db
      .prepare("SELECT id, objective, phase, parent_id, owner FROM goals")
      .all() as unknown as GoalRow[];
    const root =
      goals.find(
        (goal) => goal.parent_id === null && goal.owner === "ceo" && goal.phase !== "complete",
      ) ??
      goals.find((goal) => goal.parent_id === null) ??
      null;
    const childGoals = goals.filter((goal) => goal.parent_id !== null);
    const owners = [...new Set(childGoals.map((goal) => goal.owner))];
    const team = owners.map((agent) => ({ agent })).slice(0, WELCOME_TEAM_SLOTS);
    const handoffRows = (
      db
        .prepare(
          "SELECT actor, data FROM events WHERE type='handoff.recorded' ORDER BY seq DESC LIMIT ?",
        )
        .all(WELCOME_HANDOFF_SLOTS) as unknown as HandoffRow[]
    ).reverse();
    const handoffs = handoffRows.flatMap((row) => {
      try {
        const data = JSON.parse(row.data) as { outcome?: unknown };
        const result = typeof data.outcome === "string" ? data.outcome.replaceAll("_", " ") : "";
        return [{ agent: row.actor, result }];
      } catch {
        return [{ agent: row.actor, result: "" }];
      }
    });
    const turnRows = (
      db
        .prepare(
          "SELECT t.id,t.trigger_kind,t.status,t.error FROM turns t JOIN threads th ON th.id=t.thread_id WHERE th.agent='ceo' AND t.status IN ('in_progress','completed','failed','interrupted') ORDER BY t.rowid DESC LIMIT ?",
        )
        .all(WELCOME_TURN_SLOTS) as unknown as ConversationTurnRow[]
    ).reverse();
    const itemStatement = db.prepare(
      "SELECT i.type,i.data FROM turn_items i WHERE i.turn_id=? AND i.status='completed' AND i.type IN ('user_message','assistant_message') AND (i.type='user_message' OR EXISTS (SELECT 1 FROM events e WHERE e.stream_id='turn:'||i.turn_id AND e.type='response.committed' AND json_extract(e.data,'$.messageItemId')=i.id)) ORDER BY i.ordinal",
    );
    const turns = turnRows.flatMap((turn): WelcomeTurnSnapshot[] => {
      const items = itemStatement.all(turn.id) as unknown as Array<{ type: string; data: string }>;
      const users: string[] = [];
      const responses: string[] = [];
      for (const item of items) {
        try {
          const data = JSON.parse(item.data) as { text?: unknown };
          if (typeof data.text !== "string") continue;
          if (item.type === "user_message" && turn.trigger_kind === "user_message")
            users.push(data.text);
          else if (item.type === "assistant_message") responses.push(data.text);
        } catch {}
      }
      const error = turnError(turn.error);
      return users.length || responses.length || error
        ? [
            {
              id: turn.id,
              triggerKind: turn.trigger_kind,
              status: turn.status,
              users,
              responses,
              error,
            },
          ]
        : [];
    });
    return {
      root: root ? { id: root.id, objective: root.objective, phase: root.phase } : null,
      team,
      handoffs,
      turns,
      runner: runner.runner,
      target: runner.target,
    };
  } finally {
    db.close();
  }
}

function turnError(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { message?: unknown };
    return typeof value.message === "string" && value.message.trim() ? value.message : null;
  } catch {
    return raw.trim() || null;
  }
}

/** Render only meaningful state; empty workspaces stay compact. */
export function renderWelcome(snapshot: WelcomeSnapshot, hasHistory: boolean): string[] {
  const lines = [
    "",
    ...GOAH_TERMINAL_MARK.map((line) => tuiTheme.accent(line)),
    "",
    `  ${tuiTheme.strong(hasHistory ? "Welcome back." : "Ready when you are.")}`,
    `  ${tuiTheme.accent(snapshot.target)} ${tuiTheme.muted(`· ${snapshot.runner}`)}`,
  ];
  if (!snapshot.root)
    lines.push(`  ${tuiTheme.muted("Chat normally · /goal for durable work · /help")}`);
  if (snapshot.team.length)
    lines.push(
      `  ${tuiTheme.muted(`${snapshot.team.length} Goal Agent${snapshot.team.length === 1 ? "" : "s"} in the organization`)}`,
    );
  lines.push("");
  return lines;
}
