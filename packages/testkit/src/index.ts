import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  specialistBinding,
  type AgentHandoff,
  type Clock,
  type JsonValue,
  type HandoffValidationResult,
  type Ledger,
  type RunRequest,
} from "goah-ledger-contract";
import { SqliteLedger, type SqliteLedgerOptions } from "goah-ledger-sqlite";
import type { PiDriver, PiRunnerSession } from "goah-runner-pi";

export class SimulatedClock implements Clock {
  #value: Date;
  constructor(value = "2026-08-18T00:00:00.000Z") { this.#value = new Date(value); }
  now(): Date { return new Date(this.#value); }
  advance(ms: number): void { this.#value = new Date(this.#value.getTime() + ms); }
  set(value: string): void { this.#value = new Date(value); }
}

export function createMemoryLedger(options: SqliteLedgerOptions = {}): SqliteLedger { return new SqliteLedger(":memory:", options); }

export interface FauxStep {
  advanceMs?: number;
  trace?: Array<{ type: string; data: JsonValue }>;
  response?: string;
  write?: { path: string; content: string };
  handoff?: {response:{content:string};handoff:AgentHandoff};
  stop?: boolean;
  crash?: string;
  effect?: (request: RunRequest,feedback:Exclude<HandoffValidationResult,{accepted:true}>|null) => void;
}

export class FauxPiDriver implements PiDriver {
  readonly requests: RunRequest[] = [];
  #runnerSessions: FauxStep[][];
  constructor(readonly clock: SimulatedClock, runnerSessions: FauxStep[][], readonly directory = process.cwd()) { this.#runnerSessions = runnerSessions.map((steps) => [...steps]); }
  async createRunnerSession(request: RunRequest): Promise<PiRunnerSession> {
    this.requests.push(request);
    const steps = this.#runnerSessions.shift() ?? [];let validationFeedback:Exclude<HandoffValidationResult,{accepted:true}>|null=null;
    return {
      step: async () => {
        const step = steps.shift();
        if (!step) return { stopped: true };
        if (step.advanceMs) this.clock.advance(step.advanceMs);
        if (step.write) {
          const path = join(this.directory, step.write.path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, step.write.content);
        }
        const feedback=validationFeedback;validationFeedback=null;step.effect?.(request,feedback);
        if (step.crash) throw new Error(step.crash);
        return { ...(step.trace ? { trace: step.trace } : {}), ...(step.response !== undefined ? { response: { content: step.response } } : {}), ...(step.handoff ? { handoff: step.handoff } : {}), ...(step.stop ? { stopped: true } : {}) };
      },
      feedback:async(value)=>{validationFeedback=value;},close: async () => undefined,
    };
  }
}

export function fauxRunnerWorkerPath(): string { return fileURLToPath(new URL("./faux-runner-worker.js", import.meta.url)); }

export interface LedgerConformanceFactory { (clock: Clock): Ledger }

/** Public, storage-independent contract checks for third-party Ledger implementations. */
export function assertLedgerConformance(create: LedgerConformanceFactory): void {
  const clock = new SimulatedClock("2030-01-01T00:00:00.000Z");
  const ledger = create(clock);
  const observationMethod = "Use the conformance evidence event as the completion observation.";
  ledger.putGoal({ id: "root", parentId: null, objective: "test", observationMethod, verificationMethod: observationMethod, owner: "a", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "root", parentId: null, objective: "test", observationMethod, verificationMethod: observationMethod, owner: "a", phase: "paused", revision: 1 }, "human");
  ledger.putGoal({ id: "root", parentId: null, objective: "test", observationMethod, verificationMethod: observationMethod, owner: "a", phase: "active", revision: 2 }, "human");
  const completionEvidence = ledger.appendEvent({ streamId: "conformance:goal", ts: clock.now().toISOString(), actor: "a", type: "observation.completed", data: { ok: true } });
  ledger.completeGoal({ goalId: "root", revision: 2, reason: "conformance observation passed", evidence: [completionEvidence.seq] }, "human");
  let reopened = false;
  try { ledger.putGoal({ id: "root", parentId: null, objective: "test", observationMethod, verificationMethod: observationMethod, owner: "a", phase: "active", revision: 4 }, "human"); } catch { reopened = true; }
  if (!reopened) throw new Error("ledger conformance: completed goal was reopened");
  const first = ledger.enqueueWake({ id: "z", ...specialistBinding("a","verifier"), triggerRef: "first", status: "queued", attempt: 0, enqueuedSeq: 0, claimedAt:null,consumedAt:null,turnId:null }, "supervisor");
  if(ledger.wakeTriggers("z").length!==1||ledger.wakeTriggers("z")[0]?.status!=="pending")throw new Error("ledger conformance: initial Wake trigger is missing");
  ledger.enqueueWake({ id: "a", ...specialistBinding("b","audit"), triggerRef: "second", status: "queued", attempt: 0, enqueuedSeq: 0,claimedAt:null,consumedAt:null,turnId:null }, "supervisor");
  const claimed = ledger.claimNextWake(clock.now().toISOString());
  if (claimed?.id !== "z") throw new Error("ledger conformance: wakes are not FIFO");
  ledger.putThread({id:"thread:a",agent:"a",parentThreadId:null,createdAt:clock.now().toISOString(),updatedAt:clock.now().toISOString()},"supervisor");const turn={id:"turn:a",threadId:"thread:a",source:"system" as const,bindingKind:"specialist" as const,goalId:null,goalRevision:null,specialistRole:"verifier" as const,status:"in_progress" as const,attempt:1,error:null,startedAt:clock.now().toISOString(),endedAt:null,leaseUntil:"2030-01-01T00:10:00.000Z",leaseToken:"lease",runnerPid:null};ledger.startTurnFromWake("z",turn,clock.now().toISOString());
  if(ledger.wake("z")?.turnId!==turn.id)throw new Error("ledger conformance: consumed Wake did not link its Turn");
  if(ledger.wakeTriggers("z").some((trigger)=>trigger.status!=="resolved"))throw new Error("ledger conformance: consumed Wake retained pending triggers");
  if (first.event.ts !== clock.now().toISOString()) throw new Error("ledger conformance: injected clock was ignored");
  const informational = ledger.appendEvent({ streamId: "conformance:events", ts: clock.now().toISOString(), actor: "a", type: "transcript.conformance_info", data: {}, ignorable: true });
  if (ledger.latestEvent()?.seq !== informational.seq) throw new Error("ledger conformance: latest event was not the globally last append");
  const before = JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes(),triggers:ledger.wakeTriggers("z") });
  ledger.rebuildProjections();
  if (JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes(),triggers:ledger.wakeTriggers("z") }) !== before) throw new Error("ledger conformance: projection replay changed state");
  ledger.close();
}
