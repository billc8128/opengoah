import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  assertActionRequest,
  assertActionTransition,
  assertGoalSnapshot,
  assertGoalTransition,
  type ActionSnapshot,
  type ActionStatus,
  type AuditAdvice,
  type Clock,
  controlStream,
  type DelegationRequest,
  type DelegationResult,
  type EventInput,
  type EventRecord,
  goalStream,
  type GoalChangeAuthority,
  type GoalChangedData,
  type GoalChangeMetadata,
  type GoalSnapshot,
  type GoalCompletionRequest,
  type HandoffCommit,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  type MetricSample,
  type ReassignmentRequest,
  type ReassignmentResult,
  type ScheduleSnapshot,
  type ThreadSnapshot,
  type TurnSnapshot,
  type TurnItemSnapshot,
  type WakeSnapshot,
  wakeStream,
  type WorkRecordSnapshot,
  type WorkRecordDiff,
  type WorkRecordUpdateRequest,
  workRecordStream,
} from "goah-ledger-contract";

type FaultPoint = "after_event_before_projection" | "after_delegation_event" | "after_reassignment_event";
type FaultInjector = (point: FaultPoint) => void;
type Row = Record<string, unknown>;
type ProjectionName = "threads" | "turns" | "turn_items" | "goals" | "schedule" | "wakes" | "mailbox" | "actions" | "work_records";

export const SQLITE_SCHEMA_VERSION = 15;

const createThreads = `CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  parent_thread_id TEXT REFERENCES threads(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent)
) STRICT;`;

const createTurns = `CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('human','goal','system')),
  goal_id TEXT REFERENCES goals(id),
  goal_revision INTEGER CHECK(goal_revision IS NULL OR goal_revision >= 0),
  status TEXT NOT NULL CHECK(status IN ('in_progress','completed','failed','interrupted')),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  error TEXT CHECK(error IS NULL OR json_valid(error)),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  lease_until TEXT,
  lease_token TEXT,
  runner_pid INTEGER,
  runner_profile_id TEXT,
  CHECK((goal_id IS NULL) = (goal_revision IS NULL)),
  CHECK((status='in_progress' AND ended_at IS NULL AND lease_until IS NOT NULL AND lease_token IS NOT NULL) OR (status<>'in_progress' AND ended_at IS NOT NULL AND lease_until IS NULL AND lease_token IS NULL AND runner_pid IS NULL))
) STRICT;`;

const createTurnItems = `CREATE TABLE IF NOT EXISTS turn_items (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  type TEXT NOT NULL CHECK(type IN ('user_message','assistant_message','reasoning','tool_call','tool_result','plan','handoff')),
  status TEXT NOT NULL CHECK(status IN ('in_progress','completed','failed')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(turn_id, ordinal),
  CHECK((status='in_progress' AND completed_at IS NULL) OR (status<>'in_progress' AND completed_at IS NOT NULL))
) STRICT;`;

const createGoals = `CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES goals(id),
  objective TEXT NOT NULL,
  observation_method TEXT CHECK(observation_method IS NULL OR length(trim(observation_method)) > 0),
  verification_method TEXT CHECK(verification_method IS NULL OR length(trim(verification_method)) > 0),
  owner TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('active','paused','blocked','complete')),
  revision INTEGER NOT NULL CHECK(revision >= 0)
) STRICT;`;

const createWorkRecords = `CREATE TABLE IF NOT EXISTS work_records (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  record_revision INTEGER NOT NULL CHECK(record_revision >= 0),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 0),
  content TEXT NOT NULL CHECK(length(trim(content)) > 0),
  updated_by TEXT NOT NULL,
  updated_in_turn TEXT NOT NULL,
  source_wake_id TEXT,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  last_event_seq INTEGER NOT NULL REFERENCES events(seq)
) STRICT;`;

const createWakes = `CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  trigger_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','consumed','cancelled')),
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  enqueued_seq INTEGER NOT NULL CHECK(enqueued_seq > 0),
  claimed_at TEXT,
  consumed_at TEXT,
  turn_id TEXT REFERENCES turns(id),
  goal_id TEXT REFERENCES goals(id),
  goal_revision INTEGER CHECK(goal_revision IS NULL OR goal_revision >= 0),
  UNIQUE(agent, trigger_ref),
  CHECK((status='claimed' AND claimed_at IS NOT NULL) OR status<>'claimed'),
  CHECK((status='consumed' AND consumed_at IS NOT NULL AND turn_id IS NOT NULL) OR status<>'consumed'),
  CHECK((goal_id IS NULL) = (goal_revision IS NULL))
) STRICT;`;

const createActions = `CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  created_in_turn TEXT NOT NULL REFERENCES turns(id),
  kind TEXT NOT NULL,
  connector TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_array_length(evidence) > 0),
  gated INTEGER NOT NULL CHECK(gated IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('requested','approved','dispatching','confirmed','failed','unknown')),
  reconciled_at TEXT,
  external_ref TEXT,
  audit_advice TEXT CHECK(audit_advice IS NULL OR json_valid(audit_advice)),
  advice_acked INTEGER NOT NULL CHECK(advice_acked IN (0,1)),
  CHECK(reconciled_at IS NULL OR status IN ('confirmed','failed'))
) STRICT;`;

const indexesAndTriggers = `
CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_thread ON turns(thread_id) WHERE status='in_progress';
CREATE INDEX IF NOT EXISTS turns_thread_started ON turns(thread_id,started_at,id);
CREATE INDEX IF NOT EXISTS turn_items_turn_ordinal ON turn_items(turn_id,ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS wakes_one_claimed_agent ON wakes(agent) WHERE status='claimed';
CREATE INDEX IF NOT EXISTS wakes_queue_order ON wakes(status, enqueued_seq);
CREATE INDEX IF NOT EXISTS schedule_due ON schedule(next_wake_at);
CREATE INDEX IF NOT EXISTS events_actor_type_seq ON events(actor, type, seq DESC);
CREATE INDEX IF NOT EXISTS events_stream_seq ON events(stream_id, stream_seq);
CREATE INDEX IF NOT EXISTS events_coalesced_trigger ON events(json_extract(data,'$.triggerRef'), stream_id) WHERE type='wake.trigger_coalesced';
CREATE INDEX IF NOT EXISTS actions_agent_status ON actions(agent, status);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(actor, type, data, content='events', content_rowid='seq');

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events
BEGIN INSERT INTO events_fts(rowid,actor,type,data) VALUES (new.seq,new.actor,new.type,new.data); END;

CREATE TRIGGER IF NOT EXISTS wakes_valid_transition BEFORE UPDATE OF status ON wakes
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('claimed','cancelled')) OR
  (OLD.status = 'claimed' AND NEW.status IN ('queued','consumed','cancelled'))
)
BEGIN SELECT RAISE(ABORT, 'invalid wake transition'); END;

CREATE TRIGGER IF NOT EXISTS actions_valid_transition BEFORE UPDATE OF status ON actions
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'requested' AND NEW.status IN ('approved','failed')) OR
  (OLD.status = 'approved' AND NEW.status IN ('dispatching','failed')) OR
  (OLD.status = 'dispatching' AND NEW.status IN ('confirmed','failed','unknown')) OR
  (OLD.status = 'unknown' AND NEW.status IN ('dispatching','confirmed','failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid action transition'); END;

CREATE TRIGGER IF NOT EXISTS goals_valid_transition BEFORE UPDATE OF phase ON goals
WHEN OLD.phase <> NEW.phase AND NOT (
  (OLD.phase = 'active' AND NEW.phase IN ('paused','blocked','complete')) OR
  (OLD.phase = 'paused' AND NEW.phase IN ('active','complete')) OR
  (OLD.phase = 'blocked' AND NEW.phase IN ('active','complete'))
)
BEGIN SELECT RAISE(ABORT, 'invalid goal transition'); END;
`;

const schema = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  stream_seq INTEGER NOT NULL CHECK(stream_seq > 0),
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  ignorable INTEGER CHECK(ignorable IS NULL OR ignorable = 1),
  UNIQUE(stream_id, stream_seq)
) STRICT;
${createGoals}
${createWorkRecords}
${createThreads}
${createTurns}
${createTurnItems}
CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  next_wake_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  set_by TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  goal_revision INTEGER CHECK(goal_revision IS NULL OR goal_revision >= 0),
  CHECK((goal_id IS NULL) = (goal_revision IS NULL))
) STRICT;
${createWakes}
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('fyi','decision','emergency')),
  body TEXT NOT NULL CHECK(json_valid(body)),
  read_at TEXT
) STRICT;
${createActions}
${indexesAndTriggers}`;

class SystemClock implements Clock { now(): Date { return new Date(); } }

export interface SqliteLedgerOptions {
  faultInjector?: FaultInjector;
  clock?: Clock;
  busyTimeoutMs?: number;
}

export class SqliteLedger implements Ledger {
  readonly db: DatabaseSync;
  readonly #faultInjector: FaultInjector | undefined;
  readonly #clock: Clock;

  constructor(path = ":memory:", options: SqliteLedgerOptions = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000};`);
    this.#faultInjector = options.faultInjector;
    this.#clock = options.clock ?? new SystemClock();
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SQLITE_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`ledger schema ${version} is newer than supported schema ${SQLITE_SCHEMA_VERSION}`);
    }
    if (version > 0 && version < SQLITE_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`ledger schema ${version} predates Turn-owned execution; recreate this development workspace`);
    }
    if (version === 0) {
      this.db.exec(schema);
      this.db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    } else {
      this.db.exec(schema);
    }
  }

  close(): void { this.db.close(); }
  appendEvent(input: EventInput): EventRecord { this.#assertRawEvent(input);return this.#transaction(() => this.#insertEvent(input)); }
  appendEvents(inputs: EventInput[]): EventRecord[] { for(const input of inputs)this.#assertRawEvent(input);return this.#transaction(() => inputs.map((input) => this.#insertEvent(input))); }
  readStream(streamId: string, fromStreamSeq = 1): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events WHERE stream_id=? AND stream_seq>=? ORDER BY stream_seq").all(streamId, fromStreamSeq) as Row[]).map(mapEvent);
  }

  putThread(thread: ThreadSnapshot, actor: string): EventRecord {
    if (!thread.id.trim() || !thread.agent.trim()) throw new Error("thread id and agent are required");
    const current = this.thread(thread.id);
    const agentThread=this.threads().find((candidate)=>candidate.agent===thread.agent);if(agentThread&&agentThread.id!==thread.id)throw new Error("agent already owns a Thread");
    if (current && (current.agent !== thread.agent || current.parentThreadId !== thread.parentThreadId || current.createdAt !== thread.createdAt)) throw new Error("thread identity cannot change");
    return this.#project("threads", thread, actor, "thread.put", undefined, thread.updatedAt, `thread:${thread.id}`);
  }

  putTurn(turn: TurnSnapshot, actor: string): EventRecord {
    if (!turn.id.trim() || !turn.threadId.trim()) throw new Error("turn id and thread are required");
    if(turn.status==="in_progress"&&(!turn.leaseUntil||!turn.leaseToken)||turn.status!=="in_progress"&&(turn.leaseUntil!==null||turn.leaseToken!==null||turn.runnerPid!==null))throw new Error("Turn execution ownership does not match status");
    const current = this.turn(turn.id);
    if (current) {
      if(turn.status!=="in_progress")throw new Error("terminal Turn state must be committed through finishTurn or commitHandoff");
      if (current.threadId !== turn.threadId || current.source !== turn.source) throw new Error("turn identity cannot change");
      if(current.runnerProfileId!==turn.runnerProfileId)throw new Error("turn Runner Profile cannot change");
      if (current.status !== "in_progress") throw new Error("terminal turn cannot change");
      if (current.goalId !== null && (current.goalId !== turn.goalId || current.goalRevision !== turn.goalRevision)) throw new Error("turn Goal binding cannot change");
      if (turn.attempt !== current.attempt && turn.attempt !== current.attempt + 1) throw new Error("turn attempt must stay current or increment by one");
      if (turn.status === "in_progress" && turn.endedAt !== null || turn.status !== "in_progress" && turn.endedAt === null) throw new Error("turn terminal time does not match status");
    } else if (turn.status !== "in_progress" || turn.attempt !== 1) throw new Error("new turn must start in progress at attempt one");
    return this.#project("turns", turn, actor, current ? `turn.${turn.status}` : "turn.started", undefined, undefined, `turn:${turn.id}`);
  }

  putTurnItem(item: TurnItemSnapshot, actor: string): EventRecord {
    if (!item.id.trim() || !item.turnId.trim()) throw new Error("turn item id and turn are required");
    const turn = this.turn(item.turnId); if (!turn) throw new Error("turn item turn does not exist");
    if (turn.status !== "in_progress") throw new Error("terminal turn cannot accept items");
    if (item.status === "in_progress" && item.completedAt !== null || item.status !== "in_progress" && item.completedAt === null) throw new Error("turn item terminal time does not match status");
    const current = this.db.prepare("SELECT * FROM turn_items WHERE id=?").get(item.id) as Row | undefined;
    if (current && (String(current.turn_id) !== item.turnId || String(current.type) !== item.type || String(current.status) !== "in_progress")) throw new Error("turn item identity or terminal state cannot change");
    return this.#project("turn_items", item, actor, current ? `item.${item.type}.${item.status}` : `item.${item.type}.started`, undefined, item.completedAt ?? item.createdAt, `turn:${item.turnId}`);
  }

  thread(id: string): ThreadSnapshot | null { const row = this.db.prepare("SELECT * FROM threads WHERE id=?").get(id) as Row | undefined; return row ? mapThread(row) : null; }
  threads(): ThreadSnapshot[] { return (this.db.prepare("SELECT * FROM threads ORDER BY created_at,id").all() as Row[]).map(mapThread); }
  turn(id: string): TurnSnapshot | null { const row = this.db.prepare("SELECT * FROM turns WHERE id=?").get(id) as Row | undefined; return row ? mapTurn(row) : null; }
  turns(threadId?: string): TurnSnapshot[] { return (threadId ? this.db.prepare("SELECT * FROM turns WHERE thread_id=? ORDER BY rowid").all(threadId) : this.db.prepare("SELECT * FROM turns ORDER BY rowid").all() as Row[]).map(mapTurn); }
  turnItems(turnId: string): TurnItemSnapshot[] { return (this.db.prepare("SELECT * FROM turn_items WHERE turn_id=? ORDER BY ordinal").all(turnId) as Row[]).map(mapTurnItem); }
  activeTurn(threadId: string): TurnSnapshot | null { const row = this.db.prepare("SELECT * FROM turns WHERE thread_id=? AND status='in_progress'").get(threadId) as Row | undefined; return row ? mapTurn(row) : null; }

  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string,change?:GoalChangeMetadata): EventRecord {
    const normalized = normalizeGoal(goal);
    assertGoalSnapshot(normalized);
    if(change?.idempotencyKey){const row=this.db.prepare("SELECT * FROM events WHERE type='goal.changed' AND actor=? AND json_extract(data,'$.idempotencyKey')=? ORDER BY seq LIMIT 1").get(actor,change.idempotencyKey) as Row|undefined;if(row){const event=mapEvent(row);const data=event.data as unknown as GoalChangedData;const same=isDeepStrictEqual(data.snapshot,normalized)&&data.operation===change.operation&&data.reason===change.reason.trim()&&isDeepStrictEqual(data.evidence,change.evidence)&&(!change.authority||isDeepStrictEqual(data.authority,change.authority));if(!same)throw new Error("Goal idempotency key was reused with a different mutation");return event;}}
    const current = this.#getGoal(normalized.id);
    if (current) {
      if (normalized.revision !== current.revision + 1) throw new Error("goal revision CAS failed");
      if (current.phase === "complete") throw new Error("completed goal cannot be modified");
      if (normalized.parentId !== current.parentId) throw new Error("goal reparenting is not supported");
      if (normalized.phase === "complete") throw new Error("goal completion requires reason and evidence");
      const definitionChanged=normalized.objective!==current.objective||normalized.observationMethod!==current.observationMethod||normalized.verificationMethod!==current.verificationMethod;if(current.phase!==normalized.phase&&(current.owner!==normalized.owner||definitionChanged)||current.owner!==normalized.owner&&definitionChanged)throw new Error("Goal mutation must express exactly one lifecycle operation");
      if (normalized.objective !== current.objective && ((current.observationMethod !== null && normalized.observationMethod === current.observationMethod) || (current.verificationMethod !== null && normalized.verificationMethod === current.verificationMethod))) throw new Error("objective revision must replace or invalidate observation and verification methods");
      assertGoalTransition(current.phase, normalized.phase);
      this.#assertGoalAuthority(current.parentId, actor);
    } else {
      if (normalized.revision !== 0) throw new Error("new goal revision must be 0");
      this.#assertGoalAuthority(normalized.parentId, actor);
    }
    return this.#transaction(() => {
      const event = this.#recordGoalChange(normalized,current,actor,wakeId,change);
      if (!current) this.#createWorkRecord(normalized, actor, wakeId ?? `goal:create:${normalized.id}`, wakeId);
      return event;
    });
  }

  updateWorkRecord(request: WorkRecordUpdateRequest, actor: string): WorkRecordSnapshot {
    if (!request.turnId.trim() || !request.reason.trim() || !request.content.trim()) throw new Error("work record turn, reason and content are required");
    this.#assertEvidenceExists(request.evidence);
    const goal = this.#getGoal(request.goalId);
    if (!goal) throw new Error("work record goal does not exist");
    if (goal.revision !== request.goalRevision) throw new Error("work record goal revision is stale");
    this.#assertWorkRecordAuthority(goal, actor);
    const turn = this.turn(request.turnId); if (!turn || turn.status !== "in_progress" || turn.goalId !== goal.id || turn.goalRevision !== request.goalRevision) throw new Error("work record update does not match an active Goal-bound Turn");
    const current = this.workRecord(goal.id);
    if (!current) throw new Error("work record does not exist");
    if (current.recordRevision !== request.expectedRevision) throw new Error("work record revision CAS failed");
    if (current.content === request.content) throw new Error("work record content is unchanged");
    return this.#transaction(() => this.#recordWorkRecord({
      ...current,
      recordRevision: current.recordRevision + 1,
      goalRevision: goal.revision,
      content: request.content,
      updatedBy: actor,
      updatedInTurn: request.turnId,
      sourceWakeId: request.sourceWakeId ?? null,
      updatedAt: this.#now(),
      reason: request.reason,
      evidence: request.evidence,
    }, "work_record.updated"));
  }

  commitDelegation(request: DelegationRequest, actor: string, wakeId?: string): DelegationResult {
    const existing = this.#delegationResult(request.id);
    if (existing) {
      const event=this.events().find((candidate)=>candidate.type==="delegation.created"&&(candidate.data as {delegationId?:unknown}).delegationId===request.id);const prior=(event?.data as {request?:unknown}|undefined)?.request;
      if(event?.actor!==actor||!isDeepStrictEqual(prior,withoutSourceTurn(request)))throw new Error("delegation id was reused with a different request");
      return existing;
    }
    if (!request.id.trim() || !request.reason.trim()) throw new Error("delegation id and reason are required");
    if (request.childGoal.owner === actor) throw new Error("delegate to a distinct worker agent; use goal.put for self-owned subgoals");
    if (!request.childGoal.id.trim() || !request.childGoal.objective.trim() || !request.childGoal.observationMethod.trim() || !request.childGoal.verificationMethod.trim() || !request.childGoal.owner.trim()) throw new Error("delegation child goal is incomplete");
    this.#assertEvidenceExists(request.evidence);
    const parent = this.#getGoal(request.parentGoalId);
    if (!parent) throw new Error("delegation parent goal does not exist");
    if(parent.revision!==request.expectedParentRevision)throw new Error("delegation parent Goal revision is stale");
    if (parent.owner !== actor) throw new Error("only the parent goal owner may delegate");
    if (parent.phase !== "active") throw new Error("delegation parent goal must be active");
    if (this.#getGoal(request.childGoal.id)) throw new Error("delegation child goal already exists");

    return this.#transaction(() => {
      const goal = normalizeGoal({ ...request.childGoal, parentId: request.parentGoalId, phase: "active", revision: 0 });
      const mail: MailSnapshot = {
        id: `delegation-mail:${request.id}`,
        to: goal.owner,
        from: actor,
        level: "decision",
        body: { type: "delegation", delegationId: request.id, goalId: goal.id, parentGoalId: request.parentGoalId, objective: goal.objective, observationMethod: goal.observationMethod, verificationMethod: goal.verificationMethod ?? null, brief: request.brief, reason: request.reason, evidence: request.evidence },
        readAt: null,
      };
      const wakeBase: WakeSnapshot = {
        id: `delegation-wake:${request.id}`,
        agent: goal.owner,
        triggerRef: `delegation:${request.id}`,
        status: "queued",
        attempt: 0,
        enqueuedSeq: 0,
        claimedAt: null,
        consumedAt: null,
        turnId: null,
        goalId:goal.id,
        goalRevision:goal.revision,
      };
      this.#insertEvent({
        streamId: wakeId ? wakeStream(wakeId) : controlStream("delegations"),
        ts: this.#now(),
        actor,
        type: "delegation.created",
        data: { delegationId: request.id, parentGoalId: request.parentGoalId, goalId: goal.id, mailId: mail.id, wakeId: wakeBase.id, reason: request.reason, evidence: request.evidence,request:withoutSourceTurn(request) as unknown as JsonValue },
      });
      this.#faultInjector?.("after_delegation_event");
      this.#recordGoalChange(goal,null,actor,wakeId,{operation:"create",reason:request.reason,evidence:request.evidence,authority:{kind:"parent_goal",goalId:parent.id,goalRevision:parent.revision},...(request.sourceTurnId?{sourceTurnId:request.sourceTurnId}:{}),...(wakeId?{sourceWakeId:wakeId}:{}),idempotencyKey:request.id});
      this.#createWorkRecord(goal, actor, wakeId ?? `delegation:${request.id}`, wakeId);
      this.#recordProjection("mailbox", mail, actor, "mail.put", wakeId);
      const wake = { ...wakeBase, enqueuedSeq: this.#nextEventSeq() };
      this.#recordProjection("wakes", wake, "supervisor", "wake.enqueued", wake.id, undefined, wake.enqueuedSeq);
      return { delegationId: request.id, goal, mail, wake };
    });
  }

  commitReassignment(request: ReassignmentRequest, actor: string, wakeId?: string): ReassignmentResult {
    const existing = this.#reassignmentResult(request.id);
    if (existing) {
      const event=this.events().find((candidate)=>candidate.type==="goal.reassigned"&&(candidate.data as {reassignmentId?:unknown}).reassignmentId===request.id);const prior=(event?.data as {request?:unknown}|undefined)?.request;
      if(event?.actor!==actor||!isDeepStrictEqual(prior,withoutSourceTurn(request)))throw new Error("reassignment id was reused with a different request");
      return existing;
    }
    if (!request.id.trim() || !request.newOwner.trim() || !request.reason.trim()) throw new Error("reassignment id, owner and reason are required");
    this.#assertEvidenceExists(request.evidence);
    const current = this.#getGoal(request.goalId);
    if (!current) throw new Error("reassignment goal does not exist");
    if(current.revision!==request.expectedGoalRevision)throw new Error("reassignment Goal revision is stale");
    if (!current.parentId) throw new Error("root goals cannot be reassigned by CEO");
    this.#assertGoalAuthority(current.parentId, actor);
    if (current.phase === "complete") throw new Error("completed goals cannot be reassigned");
    if (current.owner === request.newOwner) throw new Error("reassignment owner is unchanged");

    return this.#transaction(() => {
      const goal: GoalSnapshot = { ...current, owner: request.newOwner, revision: current.revision + 1 };
      const mail: MailSnapshot[] = [
        { id: `reassignment-old-mail:${request.id}`, to: current.owner, from: actor, level: "fyi", body: { type: "reassignment", reassignmentId: request.id, goalId: goal.id, role: "previous_owner", reason: request.reason, evidence: request.evidence }, readAt: null },
        { id: `reassignment-new-mail:${request.id}`, to: goal.owner, from: actor, level: "decision", body: { type: "reassignment", reassignmentId: request.id, goalId: goal.id, role: "new_owner", brief: request.brief, reason: request.reason, evidence: request.evidence }, readAt: null },
      ];
      const wakeBase: WakeSnapshot = { id: `reassignment-wake:${request.id}`, agent: goal.owner, triggerRef: `reassignment:${request.id}`, status: "queued", attempt: 0, enqueuedSeq: 0, claimedAt: null, consumedAt: null, turnId: null,goalId:goal.id,goalRevision:goal.revision };
      this.#insertEvent({ streamId: wakeId ? wakeStream(wakeId) : controlStream("reassignments"), ts: this.#now(), actor, type: "goal.reassigned", data: { reassignmentId: request.id, goalId: goal.id, oldOwner: current.owner, newOwner: goal.owner, mailIds: mail.map((item) => item.id), wakeId: wakeBase.id, reason: request.reason, evidence: request.evidence,request:withoutSourceTurn(request) as unknown as JsonValue } });
      this.#faultInjector?.("after_reassignment_event");
      this.#recordGoalChange(goal,current,actor,wakeId,{operation:"reassign",reason:request.reason,evidence:request.evidence,authority:{kind:"parent_goal",goalId:current.parentId!,goalRevision:this.#getGoal(current.parentId!)!.revision},...(request.sourceTurnId?{sourceTurnId:request.sourceTurnId}:{}),...(wakeId?{sourceWakeId:wakeId}:{}),idempotencyKey:request.id});
      for(const oldWake of this.wakes().filter((candidate)=>candidate.agent===current.owner&&candidate.goalId===current.id&&(candidate.status==="queued"||candidate.status==="claimed")))this.#recordProjection("wakes", { ...oldWake, status: "cancelled", consumedAt: this.#now() }, "supervisor", "wake.cancelled", oldWake.id);
      for (const item of mail) this.#recordProjection("mailbox", item, actor, "mail.put", wakeId);
      const wake = { ...wakeBase, enqueuedSeq: this.#nextEventSeq() };
      this.#recordProjection("wakes", wake, "supervisor", "wake.enqueued", wake.id, undefined, wake.enqueuedSeq);
      return { reassignmentId: request.id, goal, mail, wake };
    });
  }

  completeGoal(request: GoalCompletionRequest, actor: string, wakeId?: string): GoalSnapshot {
    if (!request.reason.trim()) throw new Error("goal completion reason is required");
    this.#assertEvidenceExists(request.evidence);
    const current = this.#getGoal(request.goalId);
    if (!current) throw new Error("goal does not exist");
    if(current.phase==="complete"){const decision=this.readStream(goalStream(current.id)).findLast((event)=>event.type==="goal.completion_decided");const data=decision?.data as {revision?:unknown;reason?:unknown;evidence?:unknown};if(decision?.actor===actor&&data.revision===request.revision&&data.reason===request.reason&&JSON.stringify(data.evidence)===JSON.stringify(request.evidence))return current;throw new Error("completed goal cannot accept a different completion decision");}
    if (request.revision !== current.revision) throw new Error("goal completion revision is stale");
    if (current.observationMethod === null) throw new Error("goal completion requires an observation method");
    if (current.verificationMethod === null || current.verificationMethod === undefined) throw new Error("goal completion requires a verification method");
    this.#assertGoalAuthority(current.parentId, actor);
    if (current.parentId === null && this.#hasNonCompleteDescendant(current.id)) throw new Error("root goal cannot complete while descendants remain non-complete");
    const source = this.db.prepare("SELECT seq FROM events WHERE stream_id=? AND type='goal.changed' AND json_extract(data,'$.snapshot.revision')=? ORDER BY seq DESC LIMIT 1").get(goalStream(current.id), current.revision) as { seq: number } | undefined;
    if (!source) throw new Error("goal revision has no source event");
    if (request.evidence.some((seq) => seq <= source.seq)) throw new Error("goal completion evidence predates the current revision");
    return this.#transaction(() => {
      this.#insertEvent({ streamId: goalStream(current.id), ts: this.#now(), actor, type: "goal.completion_decided", data: { goalId: current.id, revision: current.revision, observationMethod: current.observationMethod, verificationMethod: current.verificationMethod ?? null, reason: request.reason, evidence: request.evidence } });
      const next: GoalSnapshot = { ...current, phase: "complete", revision: current.revision + 1 };
      this.#recordGoalChange(next,current,actor,wakeId,{operation:"complete",reason:request.reason,evidence:request.evidence,authority:this.#goalAuthority(current.parentId,actor),...(request.sourceTurnId?{sourceTurnId:request.sourceTurnId}:{}),...(wakeId?{sourceWakeId:wakeId}:{})});
      return next;
    });
  }

  putSchedule(value: ScheduleSnapshot, actor: string, wakeId?: string): EventRecord {
    if (actor !== "supervisor" && actor !== value.agent) throw new Error("schedule may only be set by its agent or supervisor");
    if(!value.reason.trim()||!Number.isFinite(Date.parse(value.nextWakeAt)))throw new Error("schedule requires a valid time and reason");
    if((value.goalId===undefined)!==(value.goalRevision===undefined))throw new Error("schedule Goal target is incomplete");
    return this.#project("schedule", value, actor, "schedule.put", wakeId);
  }

  enqueueWake(input: WakeSnapshot, actor: string): { event: EventRecord; created: boolean } {
    if (actor !== "supervisor") throw new Error("only supervisor may enqueue wakes");
    if (input.status !== "queued" || input.attempt !== 0 || input.claimedAt || input.consumedAt || input.turnId) {
      throw new Error("new wake must be pristine and queued");
    }
    if((input.goalId===undefined)!==(input.goalRevision===undefined))throw new Error("Wake Goal target is incomplete");
    const duplicate = this.wakeByTrigger(input.agent, input.triggerRef);
    if (duplicate) {
      const row = this.db.prepare("SELECT * FROM events WHERE type='wake.enqueued' AND json_extract(data, '$.snapshot.id')=? ORDER BY seq DESC LIMIT 1").get(duplicate.id) as Row | undefined;
      if (!row) throw new Error("wake projection has no source event");
      return { event: mapEvent(row), created: false };
    }
    return this.#transaction(() => {
      const enqueuedSeq = this.#nextEventSeq();
      const wake = { ...input, enqueuedSeq };
      const event = this.#recordProjection("wakes", wake, actor, "wake.enqueued", wake.id, undefined, enqueuedSeq);
      return { event, created: true };
    });
  }

  claimNextWake(now: string): WakeSnapshot | null {
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT * FROM wakes w WHERE status='queued' AND NOT EXISTS (
        SELECT 1 FROM wakes active WHERE active.agent=w.agent AND active.status='claimed'
      ) AND NOT EXISTS (
        SELECT 1 FROM turns WHERE source='human' AND status='in_progress'
      ) AND NOT EXISTS (
        SELECT 1 FROM turns t JOIN threads th ON th.id=t.thread_id WHERE th.agent=w.agent AND t.status='in_progress'
      ) ORDER BY enqueued_seq LIMIT 1`).get() as Row | undefined;
      if (!row) return null;
      const current = mapWake(row);
      const next: WakeSnapshot = { ...current, status: "claimed", claimedAt: now, attempt: current.attempt + 1 };
      this.#recordProjection("wakes", next, "supervisor", "wake.claimed", next.id, now);
      return next;
    });
  }

  startTurnFromWake(id:string,turn:TurnSnapshot,now:string):WakeSnapshot{const wake=this.#requiredWake(id);if(wake.status!=="claimed")throw new Error("only a claimed Wake may start a Turn");if(this.turn(turn.id))throw new Error("Wake Turn already exists");if(turn.status!=="in_progress"||turn.attempt!==1||!turn.leaseUntil||!turn.leaseToken)throw new Error("Wake must start an owned Turn at attempt one");const thread=this.thread(turn.threadId);if(!thread||thread.agent!==wake.agent)throw new Error("Wake Turn agent does not match");if((wake.goalId??null)!==turn.goalId||(wake.goalRevision??null)!==turn.goalRevision)throw new Error("Wake Turn Goal target does not match");return this.#transaction(()=>{if(this.db.prepare("SELECT 1 FROM turns WHERE source='human' AND status='in_progress' LIMIT 1").get())throw new Error("automatic Wake cannot start while a Human Turn is in progress");this.#recordProjection("turns",turn,"supervisor","turn.started",undefined,now,undefined,`turn:${turn.id}`);const next:WakeSnapshot={...wake,status:"consumed",consumedAt:now,turnId:turn.id};this.#recordProjection("wakes",next,"supervisor","wake.consumed",id,now);return next;});}

  consumeWake(id: string, turnId: string, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    if (current.status !== "claimed") throw new Error("only a claimed Wake may be consumed");
    const turn = this.turn(turnId); if (!turn) throw new Error("consumed Wake Turn does not exist");
    const thread = this.thread(turn.threadId); if (!thread || thread.agent !== current.agent) throw new Error("consumed Wake Turn agent does not match");
    if((current.goalId??null)!==turn.goalId||(current.goalRevision??null)!==turn.goalRevision)throw new Error("consumed Wake Turn Goal target does not match");
    const next: WakeSnapshot = { ...current, status: "consumed", consumedAt: now, turnId };
    this.#project("wakes", next, "supervisor", "wake.consumed", id, now);
    return next;
  }

  releaseWake(id: string, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    if (current.status !== "claimed") throw new Error("only a claimed Wake may be released");
    const next: WakeSnapshot = { ...current, status: "queued", claimedAt: null };
    this.#project("wakes", next, "supervisor", "wake.released", id, now);
    return next;
  }

  cancelWake(id: string, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    if (current.status !== "queued" && current.status !== "claimed") throw new Error("only a pending Wake may be cancelled");
    const next: WakeSnapshot = { ...current, status: "cancelled", consumedAt: now };
    this.#project("wakes", next, "supervisor", "wake.cancelled", id, now);
    return next;
  }

  attachTurnProcess(id: string, leaseToken: string, pid: number): TurnSnapshot {
    const current = this.#requiredTurn(id); this.#assertTurnLease(current, leaseToken);
    if (current.status !== "in_progress") throw new Error("runner pid may only be attached to an active Turn");
    this.putTurn({ ...current, runnerPid: pid }, "supervisor"); return this.#requiredTurn(id);
  }

  renewTurnLease(id: string, leaseToken: string, leaseUntil: string, now: string): TurnSnapshot {
    const current = this.#requiredTurn(id); this.#assertTurnLease(current, leaseToken);
    if (current.status !== "in_progress") throw new Error("only an active Turn lease may be renewed");
    if (leaseUntil <= now) throw new Error("renewed lease must expire in the future");
    this.putTurn({ ...current, leaseUntil }, "supervisor"); return this.#requiredTurn(id);
  }

  appendTurnEvent(input: EventInput, leaseToken: string): EventRecord {
    return this.#transaction(() => {
      this.#assertRawEvent(input);
      if (!input.streamId.startsWith("turn:")) throw new Error("runner event requires a Turn stream");
      const turn = this.#requiredTurn(input.streamId.slice("turn:".length)); this.#assertTurnLease(turn, leaseToken);
      if (turn.status !== "in_progress" || !turn.leaseUntil || input.ts > turn.leaseUntil) throw new Error("stale runner event rejected");
      return this.#insertEvent(input);
    });
  }

  repairTurnAttempt(id:string,reason:string,now:string,actor:string):TurnItemSnapshot[]{const current=this.#requiredTurn(id);if(current.status!=="in_progress")throw new Error("only an active Turn attempt may be repaired");return this.#transaction(()=>this.#repairOpenTurnItems(id,reason,now,actor));}

  finishTurn(id:string,status:"completed"|"failed"|"interrupted",error:JsonValue|null,now:string,actor:string,mailIds:string[]=[]):TurnSnapshot{const current=this.#requiredTurn(id);if(current.status!=="in_progress")throw new Error("only an active Turn may finish");if(status==="completed"&&error!==null||status!=="completed"&&error===null)throw new Error("Turn terminal error does not match status");return this.#transaction(()=>{if(status!=="completed")this.#repairOpenTurnItems(id,String((error as {message?:unknown}).message??"Turn interrupted"),now,actor);else if(this.turnItems(id).some((item)=>item.status==="in_progress"))throw new Error("successful Turn cannot retain in-progress Items");const streamId=`turn:${id}`;const thread=this.thread(current.threadId);const delivered=new Set(mailIds);if(status!=="completed"&&mailIds.length)throw new Error("failed Turn cannot acknowledge Mail");if(status==="completed"&&thread)for(const mail of this.unreadMail(thread.agent).filter((candidate)=>delivered.has(candidate.id)))this.#recordProjection("mailbox",{...mail,readAt:now},"supervisor","mail.read",undefined,now,undefined,streamId);this.#insertEvent({streamId,ts:now,actor,type:status==="completed"?"transcript.completed":"transcript.interrupted",data:status==="completed"?{}:{reason:String((error as {message?:unknown}).message??"Turn interrupted")}});const next={...current,status,error,endedAt:now,leaseUntil:null,leaseToken:null,runnerPid:null};this.#recordProjection("turns",next,actor,`turn.${status}`,undefined,now,undefined,streamId);return next;});}

  requestAction(action: ActionSnapshot, actor: string, wakeId?: string): EventRecord {
    assertActionRequest(action);
    if (actor !== action.agent) throw new Error("action actor does not match action agent");
    const existing=this.action(action.id);if(existing){if(!isDeepStrictEqual(existing,action))throw new Error("action id was reused with a different request");const row=this.db.prepare("SELECT * FROM events WHERE type='action.requested' AND json_extract(data,'$.snapshot.id')=? ORDER BY seq LIMIT 1").get(action.id) as Row|undefined;if(!row)throw new Error("action projection has no source event");return mapEvent(row);}
    const turn = this.turn(action.createdInTurn); const thread = turn ? this.thread(turn.threadId) : null;
    if (!turn || turn.status !== "in_progress" || thread?.agent !== actor) throw new Error("action does not match an active Turn");
    this.#assertEvidenceExists(action.evidence);
    return this.#project("actions", action, actor, "action.requested", wakeId);
  }

  approveAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    return this.#decideAction(id, "approved", approver, reason, evidence);
  }

  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    return this.#decideAction(id, "failed", approver, reason, evidence);
  }

  transitionAction(id: string, status: ActionStatus, patch: Partial<Pick<ActionSnapshot, "externalRef" | "reconciledAt">> = {}): ActionSnapshot {
    const current = this.#requiredAction(id);
    assertActionTransition(current.status, status);
    if (current.status === "unknown" && (status === "confirmed" || status === "failed") && !patch.reconciledAt) throw new Error("unknown action requires a reconciliation timestamp");
    if (patch.reconciledAt && current.status !== "unknown") throw new Error("reconciledAt is only written after unknown is queried");
    if (patch.reconciledAt && status !== "confirmed" && status !== "failed") throw new Error("reconciliation must resolve to a final state");
    const next = { ...current, ...patch, status };
    this.#project("actions", next, "supervisor", `action.${status}`);
    return next;
  }

  recoverDispatchingActions(): ActionSnapshot[] {
    const rows = this.db.prepare("SELECT id FROM actions WHERE status='dispatching' ORDER BY id").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.transitionAction(id, "unknown"));
  }

  putAuditAdvice(id: string, input: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot {
    const advice: AuditAdvice = { ...input, at: this.#now() };
    this.#assertEvidenceExists(advice.evidence);
    const current = this.#requiredAction(id);
    const next = { ...current, auditAdvice: advice, adviceAcked: false };
    this.#project("actions", next, advice.by, "action.audit_advice", wakeId, advice.at);
    return next;
  }

  ackAuditAdvice(id: string, agent: string): ActionSnapshot {
    const current = this.#requiredAction(id);
    if (current.agent !== agent) throw new Error("only the action owner may acknowledge audit advice");
    if (!current.auditAdvice) throw new Error("action has no audit advice");
    const next = { ...current, adviceAcked: true };
    this.#project("actions", next, agent, "action.audit_advice_acked");
    return next;
  }

  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord {
    if (mail.from !== actor && actor !== "supervisor") throw new Error("mail sender does not match actor");
    return this.#project("mailbox", mail, actor, "mail.put", wakeId);
  }

  commitHandoff(commit: HandoffCommit): EventRecord {
    return this.#transaction(() => {
      const turn = this.#requiredTurn(commit.turnId);
      const thread = this.thread(turn.threadId);
      if (turn.status !== "in_progress" || thread?.agent !== commit.agent) throw new Error("handoff does not match an active Turn");
      if(commit.item.turnId!==turn.id||commit.item.type!=="handoff"||commit.item.status!=="completed"||commit.item.completedAt===null||commit.item.ordinal!==this.turnItems(turn.id).length+1)throw new Error("handoff Item does not match active Turn");
      if (commit.sourceWakeId) { const wake = this.#requiredWake(commit.sourceWakeId); if (wake.status !== "consumed" || wake.turnId !== turn.id) throw new Error("handoff source Wake does not match Turn"); }
      const streamId = `turn:${commit.turnId}`;
      const event = this.#insertEvent({ streamId, ts: commit.ts, actor: commit.agent, type: "handoff.recorded", data: commit.output.handoff as unknown as JsonValue });
      this.#recordProjection("turn_items", commit.item, commit.agent, "item.handoff.completed", undefined, commit.ts, undefined, streamId);
      const delivered = new Set(commit.mailIds);
      for (const mail of this.unreadMail(commit.agent).filter((candidate) => delivered.has(candidate.id))) {
        this.#recordProjection("mailbox", { ...mail, readAt: commit.ts }, "supervisor", "mail.read", undefined, commit.ts, undefined, streamId);
      }
      for (const mail of commit.outgoingMail) {
        if (mail.from !== commit.agent) throw new Error("handoff mail sender does not match agent");
        this.#recordProjection("mailbox", mail, commit.agent, "mail.put", undefined, commit.ts, undefined, streamId);
      }
      if (commit.schedule) {
        if (commit.schedule.agent !== commit.agent || commit.schedule.setBy !== commit.agent) throw new Error("handoff schedule does not match agent");
        this.#recordProjection("schedule", commit.schedule, commit.agent, "schedule.put", undefined, commit.ts, undefined, streamId);
      }
      if(this.turnItems(turn.id).some((item)=>item.status==="in_progress"))throw new Error("successful Turn cannot retain in-progress Items");
      this.#insertEvent({streamId,ts:commit.ts,actor:"supervisor",type:"transcript.completed",data:{}});this.#recordProjection("turns",{...turn,status:"completed",error:null,endedAt:commit.ts,leaseUntil:null,leaseToken:null,runnerPid:null},"supervisor","turn.completed",undefined,commit.ts,undefined,streamId);
      return event;
    });
  }


  dueSchedules(now: string): ScheduleSnapshot[] { return (this.db.prepare("SELECT * FROM schedule WHERE next_wake_at <= ? ORDER BY next_wake_at,id").all(now) as Row[]).map(mapSchedule); }
  unreadMail(agent: string): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox WHERE to_agent=? AND read_at IS NULL ORDER BY rowid").all(agent) as Row[]).map(mapMail); }
  unackedAuditAdvice(agent: string): ActionSnapshot[] { return (this.db.prepare("SELECT * FROM actions WHERE agent=? AND audit_advice IS NOT NULL AND advice_acked=0 ORDER BY rowid").all(agent) as Row[]).map(mapAction); }
  lastEvent(actor: string, type: string): EventRecord | null { const row = this.db.prepare("SELECT * FROM events WHERE actor=? AND type=? ORDER BY seq DESC LIMIT 1").get(actor, type) as Row | undefined; return row ? mapEvent(row) : null; }
  latestEvent(): EventRecord | null { const row = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get() as Row | undefined; return row ? mapEvent(row) : null; }
  eventsForWake(wakeId: string): EventRecord[] { return this.readStream(wakeStream(wakeId)); }
  wake(id: string): WakeSnapshot | null { const row = this.db.prepare("SELECT * FROM wakes WHERE id=?").get(id) as Row | undefined; return row ? mapWake(row) : null; }
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null {
    const direct = this.db.prepare("SELECT * FROM wakes WHERE agent=? AND trigger_ref=?").get(agent, triggerRef) as Row | undefined;
    if (direct) return mapWake(direct);
    const coalesced = this.db.prepare(`SELECT w.* FROM events e JOIN wakes w ON e.stream_id='wake:'||w.id
      WHERE e.type='wake.trigger_coalesced' AND json_extract(e.data,'$.triggerRef')=? AND w.agent=? LIMIT 1`).get(triggerRef, agent) as Row | undefined;
    return coalesced ? mapWake(coalesced) : null;
  }
  queuedWakeForAgent(agent: string): WakeSnapshot | null { const row = this.db.prepare("SELECT * FROM wakes WHERE agent=? AND status='queued' ORDER BY enqueued_seq LIMIT 1").get(agent) as Row | undefined; return row ? mapWake(row) : null; }
  action(id: string): ActionSnapshot | null { const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Row | undefined; return row ? mapAction(row) : null; }
  goalsForOwner(owner: string): GoalSnapshot[] { return (this.db.prepare("SELECT * FROM goals WHERE owner=? ORDER BY id").all(owner) as Row[]).map(mapGoal); }
  goal(id: string): GoalSnapshot | null { return this.#getGoal(id); }
  workRecord(goalId: string): WorkRecordSnapshot | null { const row = this.db.prepare("SELECT * FROM work_records WHERE goal_id=?").get(goalId) as Row | undefined; return row ? mapWorkRecord(row) : null; }
  workRecordHistory(goalId: string): WorkRecordSnapshot[] {
    return this.readStream(workRecordStream(goalId)).filter((event) => event.type === "work_record.created" || event.type === "work_record.updated").map((event) => mapWorkRecordEvent(event));
  }
  workRecordDiff(goalId: string, fromRevision: number, toRevision: number): WorkRecordDiff {
    const history = this.workRecordHistory(goalId);
    const from = history.find((record) => record.recordRevision === fromRevision);
    const to = history.find((record) => record.recordRevision === toRevision);
    if (!from || !to) throw new Error("work record diff revision does not exist");
    return { goalId, fromRevision, toRevision, text: lineDiff(from.content, to.content) };
  }
  searchWorkRecords(query: string, limit = 50): WorkRecordSnapshot[] {
    return (this.db.prepare(`SELECT e.* FROM events_fts f JOIN events e ON e.seq=f.rowid
      WHERE events_fts MATCH ? AND e.type IN ('work_record.created','work_record.updated') ORDER BY rank LIMIT ?`).all(query, limit) as Row[]).map((row) => mapWorkRecordEvent(mapEvent(row)));
  }
  triggeringMail(): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox WHERE read_at IS NULL AND level IN ('decision','emergency') ORDER BY rowid").all() as Row[]).map(mapMail); }
  eventsSince(seq: number, types?: string[]): EventRecord[] {
    const events = (this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq").all(seq) as Row[]).map(mapEvent);
    return types?.length ? events.filter((event) => types.includes(event.type)) : events;
  }
  searchEvents(query: string, limit = 50): EventRecord[] {
    return (this.db.prepare("SELECT e.* FROM events_fts f JOIN events e ON e.seq=f.rowid WHERE events_fts MATCH ? ORDER BY rank LIMIT ?").all(query, limit) as Row[]).map(mapEvent);
  }
  metricSamples(goalId: string): MetricSample[] {
    return (this.db.prepare("SELECT data FROM events WHERE type='metric.sampled' AND json_extract(data,'$.goalId')=? ORDER BY seq").all(goalId) as Array<{ data: string }>).map((row) => JSON.parse(row.data) as MetricSample);
  }
  events(): EventRecord[] { return (this.db.prepare("SELECT * FROM events ORDER BY seq").all() as Row[]).map(mapEvent); }
  goals(): GoalSnapshot[] { return (this.db.prepare("SELECT * FROM goals ORDER BY id").all() as Row[]).map(mapGoal); }
  workRecords(): WorkRecordSnapshot[] { return (this.db.prepare("SELECT * FROM work_records ORDER BY goal_id").all() as Row[]).map(mapWorkRecord); }
  schedules(): ScheduleSnapshot[] { return (this.db.prepare("SELECT * FROM schedule ORDER BY id").all() as Row[]).map(mapSchedule); }
  wakes(): WakeSnapshot[] { return (this.db.prepare("SELECT * FROM wakes ORDER BY enqueued_seq").all() as Row[]).map(mapWake); }
  actions(): ActionSnapshot[] { return (this.db.prepare("SELECT * FROM actions ORDER BY id").all() as Row[]).map(mapAction); }
  mailbox(): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox ORDER BY rowid").all() as Row[]).map(mapMail); }

  rebuildProjections(): void {
    const source = this.events();
    this.#transaction(() => {
      this.db.exec("DELETE FROM actions; DELETE FROM turn_items; DELETE FROM wakes; DELETE FROM turns; DELETE FROM threads; DELETE FROM work_records; DELETE FROM mailbox; DELETE FROM schedule; DELETE FROM goals;");
      const goalKeys=new Set<string>();
      for (const event of source) {
        const data = event.data as { projection?: ProjectionName; snapshot?: unknown };
        if(!data.projection)continue;const expected=projectionForEvent(event.type);if(expected!==data.projection)throw new Error(`event ${event.seq} cannot drive ${String(data.projection)} projection`);if(!data.snapshot)throw new Error(`projection event ${event.seq} has no snapshot`);if(data.projection==="goals")this.#replayGoalChange(event,goalKeys);else this.#applyProjection(data.projection,data.snapshot,event.seq);
      }
    });
  }

  #delegationResult(id: string): DelegationResult | null {
    const row = this.db.prepare("SELECT data,actor FROM events WHERE type='delegation.created' AND json_extract(data,'$.delegationId')=? ORDER BY seq LIMIT 1").get(id) as { data: string;actor:string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.data) as { goalId: string; mailId: string; wakeId: string };
    const goal=this.#goalChangeSnapshot(id,row.actor);const mail=this.#eventSnapshot<MailSnapshot>("mail.put",data.mailId);const wake=this.#eventSnapshot<WakeSnapshot>("wake.enqueued",data.wakeId);
    if (!goal || !mail || !wake) throw new Error("committed delegation facts are incomplete");
    return { delegationId: id, goal, mail, wake };
  }

  #reassignmentResult(id: string): ReassignmentResult | null {
    const row = this.db.prepare("SELECT data,actor FROM events WHERE type='goal.reassigned' AND json_extract(data,'$.reassignmentId')=? ORDER BY seq LIMIT 1").get(id) as { data: string;actor:string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.data) as { goalId: string; mailIds: string[]; wakeId: string };
    const goal=this.#goalChangeSnapshot(id,row.actor);const mail=data.mailIds.map((mailId)=>{const value=this.#eventSnapshot<MailSnapshot>("mail.put",mailId);if(!value)throw new Error("committed reassignment mail is missing");return value;});const wake=this.#eventSnapshot<WakeSnapshot>("wake.enqueued",data.wakeId);
    if (!goal || !wake) throw new Error("committed reassignment facts are incomplete");
    return { reassignmentId: id, goal, mail, wake };
  }

  #goalChangeSnapshot(id:string,actor:string):GoalSnapshot|null{const row=this.db.prepare("SELECT data FROM events WHERE type='goal.changed' AND actor=? AND json_extract(data,'$.idempotencyKey')=? ORDER BY seq LIMIT 1").get(actor,id) as {data:string}|undefined;return row?(JSON.parse(row.data) as unknown as GoalChangedData).snapshot:null;}
  #eventSnapshot<T>(type:string,id:string):T|null{const row=this.db.prepare("SELECT data FROM events WHERE type=? AND json_extract(data,'$.snapshot.id')=? ORDER BY seq LIMIT 1").get(type,id) as {data:string}|undefined;return row?(JSON.parse(row.data) as {snapshot:T}).snapshot:null;}

  #decideAction(id: string, status: "approved" | "failed", approver: string, reason: string, evidence: number[]): ActionSnapshot {
    if (!reason.trim()) throw new Error("approval reason is required");
    this.#assertEvidenceExists(evidence);
    return this.#transaction(() => {
      const current = this.#requiredAction(id);
      assertActionTransition(current.status, status);
      this.#insertEvent({ streamId: controlStream("actions"), ts: this.#now(), actor: approver, type: `action.${status}_decision`, data: { actionId: id, reason, evidence } });
      const next = { ...current, status };
      this.#recordProjection("actions", next, approver, `action.${status}`);
      return next;
    });
  }

  #recordGoalChange(snapshot:GoalSnapshot,previous:GoalSnapshot|null,actor:string,wakeId?:string,change?:GoalChangeMetadata):EventRecord{const derivedOperation=goalOperation(previous,snapshot);if(change&&change.operation!==derivedOperation)throw new Error("Goal change operation does not match its state transition");const operation=change?.operation??derivedOperation;if(change&&!change.reason.trim())throw new Error("Goal change reason is required");const evidence=change?.evidence??[];if(evidence.length)this.#assertEvidenceExists(evidence);const expectedAuthority=this.#goalAuthority(snapshot.parentId,actor);if(change?.authority&&!isDeepStrictEqual(change.authority,expectedAuthority))throw new Error("Goal change authority does not match the authenticated actor");const authority=change?.authority??expectedAuthority;const sourceWakeId=change?.sourceWakeId??wakeId;this.#assertGoalProvenance(snapshot,actor,authority,change?.sourceTurnId,sourceWakeId);if(change?.idempotencyKey&&this.db.prepare("SELECT 1 FROM events WHERE type='goal.changed' AND actor=? AND json_extract(data,'$.idempotencyKey')=?").get(actor,change.idempotencyKey))throw new Error("Goal idempotency key is already committed");const data:GoalChangedData={version:1,projection:"goals",operation,previousRevision:previous?.revision??null,snapshot,reason:change?.reason?.trim()||defaultGoalReason(operation),evidence,authority,...(change?.sourceTurnId?{sourceTurnId:change.sourceTurnId}:{}),...(sourceWakeId?{sourceWakeId}:{}),...(change?.idempotencyKey?{idempotencyKey:change.idempotencyKey}:{})};const event=this.#insertEvent({streamId:goalStream(snapshot.id),ts:this.#now(),actor,type:"goal.changed",data:data as unknown as JsonValue});this.#faultInjector?.("after_event_before_projection");this.#applyProjection("goals",snapshot,event.seq);return event;}

  #replayGoalChange(event:EventRecord,keys:Set<string>):void{if(event.type!=="goal.changed")throw new Error(`event ${event.seq} is not an authoritative Goal change`);const data=event.data as unknown as GoalChangedData;if(data.version!==1||data.projection!=="goals")throw new Error(`goal.changed ${event.seq} has an unsupported format`);const snapshot=normalizeGoal(data.snapshot);assertGoalSnapshot(snapshot);if(event.streamId!==goalStream(snapshot.id))throw new Error(`goal.changed ${event.seq} uses the wrong stream`);const previous=this.#getGoal(snapshot.id);if(data.previousRevision!==(previous?.revision??null)||snapshot.revision!==(previous?previous.revision+1:0)||data.operation!==goalOperation(previous,snapshot))throw new Error(`goal.changed ${event.seq} breaks the Goal revision chain`);if(!data.reason.trim())throw new Error(`goal.changed ${event.seq} has no reason`);for(const seq of data.evidence)if(!Number.isInteger(seq)||seq<=0||seq>=event.seq)throw new Error(`goal.changed ${event.seq} has invalid evidence`);const expected=this.#goalAuthority(snapshot.parentId,event.actor);if(!isDeepStrictEqual(data.authority,expected))throw new Error(`goal.changed ${event.seq} has invalid authority`);this.#assertGoalProvenance(snapshot,event.actor,data.authority,data.sourceTurnId,data.sourceWakeId);if(data.idempotencyKey){const key=`${event.actor}\u0000${data.idempotencyKey}`;if(keys.has(key))throw new Error(`goal.changed ${event.seq} reuses an idempotency key`);keys.add(key);}this.#applyProjection("goals",snapshot,event.seq);}

  #assertGoalProvenance(snapshot:GoalSnapshot,actor:string,authority:GoalChangeAuthority,sourceTurnId?:string,sourceWakeId?:string):void{if(sourceWakeId&&!sourceTurnId)throw new Error("Goal change source Wake requires its source Turn");const turn=sourceTurnId?this.turn(sourceTurnId):null;if(sourceTurnId&&!turn)throw new Error("Goal change source Turn does not exist");if(turn){if(turn.status!=="in_progress")throw new Error("Goal change source Turn is not active");const thread=this.thread(turn.threadId);if(!thread)throw new Error("Goal change source Turn has no Thread");if(authority.kind==="human"){if(turn.source!=="human"||thread.agent!=="ceo"||turn.goalId!==null&&turn.goalId!==snapshot.id)throw new Error("Goal change source Turn does not carry Human authority");}else if(authority.kind==="parent_goal"){if(thread.agent!==actor||turn.goalId!==authority.goalId||turn.goalRevision!==authority.goalRevision)throw new Error("Goal change source Turn is not bound to the authorizing parent Goal");}else if(thread.agent!==actor)throw new Error("Goal change source Turn actor does not match");}if(sourceWakeId){const wake=this.wake(sourceWakeId);if(!wake)throw new Error("Goal change source Wake does not exist");if(wake.status!=="consumed"||sourceTurnId&&wake.turnId!==sourceTurnId)throw new Error("Goal change source Wake does not match its Turn");if(authority.kind==="parent_goal"&&(wake.agent!==actor||wake.goalId!==authority.goalId||wake.goalRevision!==authority.goalRevision))throw new Error("Goal change source Wake is not bound to the authorizing parent Goal");}}

  #goalAuthority(parentId:string|null,actor:string):GoalChangeAuthority{if(parentId===null)return actor==="human"?{kind:"human"}:{kind:"system",reason:`root mutation by ${actor}`};const parent=this.#getGoal(parentId);if(!parent)throw new Error("parent goal does not exist");return{kind:"parent_goal",goalId:parent.id,goalRevision:parent.revision};}

  #createWorkRecord(goal: GoalSnapshot, actor: string, turnId: string, wakeId?: string, seed?: { content: string; evidence: number[] }): WorkRecordSnapshot {
    return this.#recordWorkRecord({
      goalId: goal.id,
      recordRevision: 0,
      goalRevision: goal.revision,
      content: seed?.content ?? initialWorkRecord(),
      updatedBy: actor,
      updatedInTurn: turnId,
      sourceWakeId: wakeId ?? null,
      updatedAt: this.#now(),
      reason: "Goal created",
      evidence: seed?.evidence ?? [],
      lastEventSeq: 0,
    }, "work_record.created");
  }

  #recordWorkRecord(snapshot: WorkRecordSnapshot, type: "work_record.created" | "work_record.updated"): WorkRecordSnapshot {
    const seq = this.#nextEventSeq();
    const committed = { ...snapshot, lastEventSeq: seq };
    this.#recordProjection("work_records", committed, committed.updatedBy, type, committed.sourceWakeId ?? undefined, committed.updatedAt, seq, workRecordStream(committed.goalId));
    return committed;
  }

  #assertWorkRecordAuthority(goal: GoalSnapshot, actor: string): void {
    if (goal.owner === actor || (goal.parentId === null && actor === "human")) return;
    const parent = goal.parentId ? this.#getGoal(goal.parentId) : null;
    if (parent?.owner !== actor) throw new Error("only the goal owner or parent owner may update its work record");
  }

  #assertGoalAuthority(parentId: string | null, actor: string): void {
    if (parentId === null) { if (actor !== "human") throw new Error("only human may modify a root goal"); return; }
    const parent = this.#getGoal(parentId);
    if (!parent) throw new Error("parent goal does not exist");
    if (parent.owner !== actor) throw new Error("only the parent goal owner may modify a child goal");
  }

  #hasNonCompleteDescendant(goalId: string): boolean {
    return Boolean(this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM goals WHERE parent_id=?
      UNION ALL SELECT g.id FROM goals g JOIN descendants d ON g.parent_id=d.id
    ) SELECT 1 FROM goals WHERE id IN (SELECT id FROM descendants) AND phase<>'complete' LIMIT 1`).get(goalId));
  }

  #assertEvidenceExists(evidence: number[]): void {
    if (evidence.length === 0) throw new Error("evidence is required");
    const exists = this.db.prepare("SELECT 1 FROM events WHERE seq=?");
    for (const seq of evidence) if (!Number.isInteger(seq) || seq <= 0 || !exists.get(seq)) throw new Error(`evidence event does not exist: ${seq}`);
  }

  #assertTurnLease(turn: TurnSnapshot, leaseToken: string): void { if (turn.leaseToken !== leaseToken) throw new Error("stale Turn lease token"); }
  #assertRawEvent(input:EventInput):void{const data=input.data&&typeof input.data==="object"&&!Array.isArray(input.data)?input.data as Record<string,JsonValue>:null;if(data&&Object.hasOwn(data,"projection")||input.type==="goal.changed")throw new Error("projection-driving events must use a typed Ledger domain API");}

  #getGoal(id: string): GoalSnapshot | null { const row = this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as Row | undefined; return row ? mapGoal(row) : null; }
  #requiredTurn(id: string): TurnSnapshot { const value = this.turn(id); if (!value) throw new Error(`turn not found: ${id}`); return value; }
  #requiredWake(id: string): WakeSnapshot { const value = this.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #requiredAction(id: string): ActionSnapshot { const value = this.action(id); if (!value) throw new Error(`action not found: ${id}`); return value; }
  #repairOpenTurnItems(turnId:string,reason:string,now:string,actor:string):TurnItemSnapshot[]{const streamId=`turn:${turnId}`;const open=this.turnItems(turnId).filter((item)=>item.status==="in_progress");const repaired:TurnItemSnapshot[]=[];let ordinal=this.turnItems(turnId).length+1;for(const item of open){const failed={...item,status:"failed" as const,completedAt:now};this.#recordProjection("turn_items",failed,actor,`item.${item.type}.failed`,undefined,now,undefined,streamId);repaired.push(failed);if(item.type==="tool_call"){const callId=String((item.data as {callId?:unknown}).callId??item.id);const result:TurnItemSnapshot={id:`repair:${turnId}:${item.ordinal}`,turnId,ordinal:ordinal++,type:"tool_result",status:"completed",data:{callId,result:{outcome:"unknown",synthetic:true,reason}},createdAt:now,completedAt:now};this.#recordProjection("turn_items",result,actor,"item.tool_result.started",undefined,now,undefined,streamId);this.#insertEvent({streamId,ts:now,actor,type:"tool.completed",data:{callId,messageId:`repair:${callId}`,result:{outcome:"unknown",synthetic:true,reason},isError:true}});repaired.push(result);}}return repaired;}
  #project(projection: ProjectionName, snapshot: unknown, actor: string, type: string, wakeId?: string, ts?: string, streamId?: string): EventRecord {
    return this.#transaction(() => this.#recordProjection(projection, snapshot, actor, type, wakeId, ts, undefined, streamId));
  }

  #recordProjection(projection: ProjectionName, snapshot: unknown, actor: string, type: string, wakeId?: string, ts?: string, expectedSeq?: number, streamId?: string): EventRecord {
    const event = this.#insertEvent({ streamId: streamId ?? (wakeId ? wakeStream(wakeId) : controlStream(projection)), ts: ts ?? this.#now(), actor, type, data: { projection, snapshot } as unknown as JsonValue, ignorable: true }, expectedSeq);
    this.#faultInjector?.("after_event_before_projection");
    this.#applyProjection(projection, snapshot, event.seq);
    return event;
  }

  #insertEvent(input: EventInput, expectedSeq?: number): EventRecord {
    if (!input.streamId.trim() || !input.actor.trim() || !input.type.trim()) throw new Error("event streamId, actor and type are required");
    const streamSeq = Number((this.db.prepare("SELECT COALESCE(MAX(stream_seq),0)+1 AS next FROM events WHERE stream_id=?").get(input.streamId) as { next: number }).next);
    const result = expectedSeq === undefined
      ? this.db.prepare("INSERT INTO events(stream_id,stream_seq,ts,actor,type,data,ignorable) VALUES (?,?,?,?,?,json(?),?)").run(input.streamId, streamSeq, input.ts, input.actor, input.type, JSON.stringify(input.data), input.ignorable === true ? 1 : null)
      : this.db.prepare("INSERT INTO events(seq,stream_id,stream_seq,ts,actor,type,data,ignorable) VALUES (?,?,?,?,?,?,json(?),?)").run(expectedSeq, input.streamId, streamSeq, input.ts, input.actor, input.type, JSON.stringify(input.data), input.ignorable === true ? 1 : null);
    return { ...input, seq: Number(result.lastInsertRowid), streamSeq };
  }

  #nextEventSeq(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq: number } | undefined;
    return Number(row?.seq ?? 0) + 1;
  }

  #applyProjection(projection: ProjectionName, raw: unknown, sourceSeq: number): void {
    if (projection === "threads") {
      const v = raw as ThreadSnapshot;
      this.db.prepare(`INSERT INTO threads VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,parent_thread_id=excluded.parent_thread_id,updated_at=excluded.updated_at`).run(v.id,v.agent,v.parentThreadId,v.createdAt,v.updatedAt);
    } else if (projection === "turns") {
      const v = raw as TurnSnapshot;
      this.db.prepare(`INSERT INTO turns VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET goal_id=excluded.goal_id,goal_revision=excluded.goal_revision,status=excluded.status,attempt=excluded.attempt,error=excluded.error,ended_at=excluded.ended_at,lease_until=excluded.lease_until,lease_token=excluded.lease_token,runner_pid=excluded.runner_pid`).run(v.id,v.threadId,v.source,v.goalId,v.goalRevision,v.status,v.attempt,v.error===null?null:JSON.stringify(v.error),v.startedAt,v.endedAt,v.leaseUntil,v.leaseToken,v.runnerPid,v.runnerProfileId??null);
      this.db.prepare("UPDATE threads SET updated_at=CASE WHEN updated_at<? THEN ? ELSE updated_at END WHERE id=?").run(v.endedAt ?? v.startedAt,v.endedAt ?? v.startedAt,v.threadId);
    } else if (projection === "turn_items") {
      const v = raw as TurnItemSnapshot;
      this.db.prepare(`INSERT INTO turn_items VALUES (?,?,?,?,?,json(?),?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,completed_at=excluded.completed_at`).run(v.id,v.turnId,v.ordinal,v.type,v.status,JSON.stringify(v.data),v.createdAt,v.completedAt);
      this.db.prepare("UPDATE threads SET updated_at=CASE WHEN updated_at<? THEN ? ELSE updated_at END WHERE id=(SELECT thread_id FROM turns WHERE id=?)").run(v.completedAt ?? v.createdAt,v.completedAt ?? v.createdAt,v.turnId);
    } else if (projection === "goals") {
      const v = normalizeGoal(raw as GoalSnapshot);
      this.db.prepare(`INSERT INTO goals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,objective=excluded.objective,observation_method=excluded.observation_method,verification_method=excluded.verification_method,owner=excluded.owner,phase=excluded.phase,revision=excluded.revision`).run(v.id,v.parentId,v.objective,v.observationMethod,v.verificationMethod ?? null,v.owner,v.phase,v.revision);
    } else if (projection === "work_records") {
      const v = raw as WorkRecordSnapshot;
      this.db.prepare(`INSERT INTO work_records VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET record_revision=excluded.record_revision,goal_revision=excluded.goal_revision,content=excluded.content,updated_by=excluded.updated_by,updated_in_turn=excluded.updated_in_turn,source_wake_id=excluded.source_wake_id,updated_at=excluded.updated_at,reason=excluded.reason,evidence=excluded.evidence,last_event_seq=excluded.last_event_seq`).run(v.goalId,v.recordRevision,v.goalRevision,v.content,v.updatedBy,v.updatedInTurn,v.sourceWakeId,v.updatedAt,v.reason,JSON.stringify(v.evidence),v.lastEventSeq || sourceSeq);
    } else if (projection === "schedule") {
      const v = raw as ScheduleSnapshot;
      this.db.prepare(`INSERT INTO schedule VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,next_wake_at=excluded.next_wake_at,reason=excluded.reason,set_by=excluded.set_by,goal_id=excluded.goal_id,goal_revision=excluded.goal_revision`).run(v.id,v.agent,v.nextWakeAt,v.reason,v.setBy,v.goalId??null,v.goalRevision??null);
    } else if (projection === "wakes") {
      const v = raw as WakeSnapshot;
      this.db.prepare(`INSERT INTO wakes VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,trigger_ref=excluded.trigger_ref,status=excluded.status,attempt=excluded.attempt,enqueued_seq=excluded.enqueued_seq,claimed_at=excluded.claimed_at,consumed_at=excluded.consumed_at,turn_id=excluded.turn_id,goal_id=excluded.goal_id,goal_revision=excluded.goal_revision`).run(v.id,v.agent,v.triggerRef,v.status,v.attempt,v.enqueuedSeq || sourceSeq,v.claimedAt,v.consumedAt,v.turnId,v.goalId??null,v.goalRevision??null);
    } else if (projection === "mailbox") {
      const v = raw as MailSnapshot;
      this.db.prepare(`INSERT INTO mailbox VALUES (?,?,?,?,json(?),?) ON CONFLICT(id) DO UPDATE SET to_agent=excluded.to_agent,from_agent=excluded.from_agent,level=excluded.level,body=excluded.body,read_at=excluded.read_at`).run(v.id,v.to,v.from,v.level,JSON.stringify(v.body),v.readAt);
    } else {
      const v = raw as ActionSnapshot;
      this.db.prepare(`INSERT INTO actions VALUES (?,?,?,?,?,json(?),?,json(?),?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,created_in_turn=excluded.created_in_turn,kind=excluded.kind,connector=excluded.connector,payload=excluded.payload,reason=excluded.reason,evidence=excluded.evidence,gated=excluded.gated,status=excluded.status,reconciled_at=excluded.reconciled_at,external_ref=excluded.external_ref,audit_advice=excluded.audit_advice,advice_acked=excluded.advice_acked`).run(v.id,v.agent,v.createdInTurn,v.kind,v.connector,JSON.stringify(v.payload),v.reason,JSON.stringify(v.evidence),v.gated?1:0,v.status,v.reconciledAt,v.externalRef,v.auditAdvice===null?null:JSON.stringify(v.auditAdvice),v.adviceAcked?1:0);
    }
  }

  #transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  #now(): string { return this.#clock.now().toISOString(); }
}

function mapEvent(r: Row): EventRecord { return { seq: Number(r.seq), streamId: String(r.stream_id), streamSeq: Number(r.stream_seq), ts: String(r.ts), actor: String(r.actor), type: String(r.type), data: JSON.parse(String(r.data)) as JsonValue, ...(Number(r.ignorable) === 1 ? { ignorable: true as const } : {}) }; }
function mapThread(r: Row): ThreadSnapshot { return { id:String(r.id),agent:String(r.agent),parentThreadId:r.parent_thread_id===null?null:String(r.parent_thread_id),createdAt:String(r.created_at),updatedAt:String(r.updated_at) }; }
function mapTurn(r: Row): TurnSnapshot { return { id:String(r.id),threadId:String(r.thread_id),source:String(r.source) as TurnSnapshot["source"],goalId:r.goal_id===null?null:String(r.goal_id),goalRevision:r.goal_revision===null?null:Number(r.goal_revision),status:String(r.status) as TurnSnapshot["status"],attempt:Number(r.attempt),error:r.error===null?null:JSON.parse(String(r.error)),startedAt:String(r.started_at),endedAt:r.ended_at===null?null:String(r.ended_at),leaseUntil:r.lease_until===null?null:String(r.lease_until),leaseToken:r.lease_token===null?null:String(r.lease_token),runnerPid:r.runner_pid===null?null:Number(r.runner_pid),...(r.runner_profile_id===null||r.runner_profile_id===undefined?{}:{runnerProfileId:String(r.runner_profile_id)}) }; }
function mapTurnItem(r: Row): TurnItemSnapshot { return { id:String(r.id),turnId:String(r.turn_id),ordinal:Number(r.ordinal),type:String(r.type) as TurnItemSnapshot["type"],status:String(r.status) as TurnItemSnapshot["status"],data:JSON.parse(String(r.data)),createdAt:String(r.created_at),completedAt:r.completed_at===null?null:String(r.completed_at) }; }
function normalizeGoal(goal: GoalSnapshot): GoalSnapshot { return { ...goal, observationMethod: goal.observationMethod ?? null, verificationMethod: goal.verificationMethod === undefined ? goal.observationMethod ?? null : goal.verificationMethod }; }
function mapGoal(r: Row): GoalSnapshot { return { id: String(r.id), parentId: r.parent_id === null ? null : String(r.parent_id), objective: String(r.objective), observationMethod: r.observation_method === null || r.observation_method === undefined ? null : String(r.observation_method), verificationMethod: r.verification_method === null || r.verification_method === undefined ? null : String(r.verification_method), owner: String(r.owner), phase: String(r.phase) as GoalSnapshot["phase"], revision: Number(r.revision) }; }
function mapWorkRecord(r: Row): WorkRecordSnapshot { return { goalId:String(r.goal_id),recordRevision:Number(r.record_revision),goalRevision:Number(r.goal_revision),content:String(r.content),updatedBy:String(r.updated_by),updatedInTurn:String(r.updated_in_turn),sourceWakeId:r.source_wake_id===null?null:String(r.source_wake_id),updatedAt:String(r.updated_at),reason:String(r.reason),evidence:JSON.parse(String(r.evidence)) as number[],lastEventSeq:Number(r.last_event_seq) }; }
function mapWorkRecordEvent(event: EventRecord): WorkRecordSnapshot { const data = event.data as { snapshot?: WorkRecordSnapshot }; if (!data.snapshot) throw new Error(`work record event ${event.seq} has no snapshot`); return { ...data.snapshot, lastEventSeq: event.seq }; }
function initialWorkRecord(): string { return "# Current State\n\nGoal created. Work has not started.\n\n# Observations\n\n# Work Completed\n\n# Decisions\n\n# Blockers\n\n# Next Steps\n"; }
function goalOperation(previous:GoalSnapshot|null,next:GoalSnapshot):GoalChangeMetadata["operation"]{if(!previous)return"create";if(previous.phase!==next.phase){if(next.phase==="paused")return"pause";if(next.phase==="active")return"resume";if(next.phase==="blocked")return"block";if(next.phase==="complete")return"complete";}return previous.owner!==next.owner?"reassign":"revise";}
function defaultGoalReason(operation:GoalChangeMetadata["operation"]):string{return `Goal ${operation}`;}
function withoutSourceTurn<T extends {sourceTurnId?:string}>(value:T):Omit<T,"sourceTurnId">{const{sourceTurnId:_,...semantic}=value;return semantic;}
function projectionForEvent(type:string):ProjectionName|null{if(type==="thread.put")return"threads";if(type.startsWith("turn."))return"turns";if(type.startsWith("item."))return"turn_items";if(type==="goal.changed")return"goals";if(type==="schedule.put")return"schedule";if(type.startsWith("wake."))return"wakes";if(type.startsWith("mail."))return"mailbox";if(type.startsWith("action."))return"actions";if(type==="work_record.created"||type==="work_record.updated")return"work_records";return null;}
function lineDiff(from: string, to: string): string {
  const before = from.split("\n"); const after = to.split("\n"); const lines: string[] = [];
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    if (before[index] === after[index]) { if (before[index] !== undefined) lines.push(` ${before[index]}`); continue; }
    if (before[index] !== undefined) lines.push(`-${before[index]}`);
    if (after[index] !== undefined) lines.push(`+${after[index]}`);
  }
  return lines.join("\n");
}
function mapSchedule(r: Row): ScheduleSnapshot { return {id:String(r.id),agent:String(r.agent),nextWakeAt:String(r.next_wake_at),reason:String(r.reason),setBy:String(r.set_by),...(r.goal_id===null||r.goal_id===undefined?{}:{goalId:String(r.goal_id),goalRevision:Number(r.goal_revision)})}; }
function mapWake(r: Row): WakeSnapshot { return {id:String(r.id),agent:String(r.agent),triggerRef:String(r.trigger_ref),status:String(r.status) as WakeSnapshot["status"],attempt:Number(r.attempt),enqueuedSeq:Number(r.enqueued_seq),claimedAt:r.claimed_at===null?null:String(r.claimed_at),consumedAt:r.consumed_at===null?null:String(r.consumed_at),turnId:r.turn_id===null?null:String(r.turn_id),...(r.goal_id===null||r.goal_id===undefined?{}:{goalId:String(r.goal_id),goalRevision:Number(r.goal_revision)})}; }
function mapMail(r: Row): MailSnapshot { return {id:String(r.id),to:String(r.to_agent),from:String(r.from_agent),level:String(r.level) as MailSnapshot["level"],body:JSON.parse(String(r.body)),readAt:r.read_at===null?null:String(r.read_at)}; }
function mapAction(r: Row): ActionSnapshot { return {id:String(r.id),agent:String(r.agent),createdInTurn:String(r.created_in_turn),kind:String(r.kind),connector:String(r.connector),payload:JSON.parse(String(r.payload)),reason:String(r.reason),evidence:JSON.parse(String(r.evidence)),gated:Boolean(r.gated),status:String(r.status) as ActionStatus,reconciledAt:r.reconciled_at===null?null:String(r.reconciled_at),externalRef:r.external_ref===null?null:String(r.external_ref),auditAdvice:r.audit_advice===null?null:JSON.parse(String(r.audit_advice)),adviceAcked:Boolean(r.advice_acked)}; }
