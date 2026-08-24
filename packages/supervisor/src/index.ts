import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  capabilityFor,
  controlStream,
  evaluateMetric,
  goalStream,
  interruptedSessionEvents,
  type ActionSnapshot,
  type AgentCapability,
  type AgentProfile,
  type AgentRole,
  type AuditAdvice,
  type Clock,
  type ConnectorDispatchResult,
  type ConnectorProcessSpec,
  type ConnectorQueryResult,
  type DelegationRequest,
  type DelegationResult,
  type GoalSnapshot,
  type GoalCompletionRequest,
  type GoalPhase,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  memoryStream,
  type MetricEvaluation,
  type MetricContract,
  type MetricProcessSpec,
  type MetricSample,
  type ReassignmentRequest,
  type ReassignmentResult,
  type Runner,
  type RunnerHandle,
  type RunnerProfile,
  type ScheduleSnapshot,
  type TeamMemberView,
  type TurnContext,
  type WakeOutput,
  type WakeSnapshot,
  wakeStream,
} from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents, selectWorkingMemory } from "./context-view.js";
import { defaultRolePrompt } from "./roles.js";

export { composeActiveContext, selectRecoveryEvents, type ActiveContextInput, type ActiveContextView } from "./context-view.js";

/** Dispatches each wake to the runner selected by its opaque Runner Profile. */
export class RunnerRouter implements Runner {
  readonly isolation = "process" as const;
  readonly #byPid = new Map<number, Runner>();
  constructor(readonly runners: ReadonlyMap<string, Runner>, readonly fallback = "default") {}
  prepare(request: Parameters<Runner["prepare"]>[0]): RunnerHandle {
    const context = request.context && typeof request.context === "object" && !Array.isArray(request.context) ? request.context as Record<string, unknown> : {};
    const profile = context.runnerProfile && typeof context.runnerProfile === "object" && !Array.isArray(context.runnerProfile) ? context.runnerProfile as Record<string, unknown> : {};
    const id = typeof profile.id === "string" ? profile.id : this.fallback;
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`runner profile is not configured: ${id}`);
    const handle = runner.prepare(request);
    if (handle.pid) this.#byPid.set(handle.pid, runner);
    void handle.result.finally(() => { if (handle.pid) this.#byPid.delete(handle.pid); });
    return handle;
  }
  async terminateProcess(pid: number): Promise<void> {
    const runner = this.#byPid.get(pid);
    if (!runner) return;
    await runner.terminateProcess(pid);
  }
}

export interface SupervisorOptions {
  leaseMs?: number;
  memoryTailChars?: number;
  allowExternalActions?: boolean;
  approvers?: string[];
  auditWriters?: string[];
  silence?: { maxSilentMs?: number; notify?: string } | null;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  profiles?: AgentProfile[];
  runnerProfiles?: RunnerProfile[];
  verifyMetricsAfterWake?: boolean;
}

interface MetricCollectorRegistration { goalId: string; contract: MetricContract; spec: MetricProcessSpec; intervalMs: number; nextAt: number }

export class Supervisor {
  readonly #leaseMs: number;
  readonly #memoryTailChars: number;
  readonly #allowExternalActions: boolean;
  readonly #approvers: Set<string>;
  readonly #auditWriters: Set<string>;
  #claimTail: Promise<void> = Promise.resolve();
  readonly #connectors = new Map<string, ConnectorProcessSpec>();
  readonly #metricCollectors = new Map<string, MetricCollectorRegistration>();
  readonly #metricContracts = new Map<string, MetricContract>();
  readonly #silence: { maxSilentMs: number; notify: string } | null;
  readonly #retryPolicy: NonNullable<SupervisorOptions["retryPolicy"]>;
  readonly #profiles: Map<string, AgentProfile>;
  readonly #runnerProfiles: Map<string, RunnerProfile>;
  readonly #handles = new Map<string, RunnerHandle>();
  readonly #verifyMetricsAfterWake: boolean;

  #runner: Runner;
  constructor(readonly ledger: Ledger, runner: Runner, readonly clock: Clock, options: SupervisorOptions = {}) {
    this.#runner = runner;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#memoryTailChars = options.memoryTailChars ?? 12_000;
    this.#allowExternalActions = options.allowExternalActions ?? false;
    this.#approvers = new Set(options.approvers ?? ["human", "ceo"]);
    this.#auditWriters = new Set(options.auditWriters ?? ["verifier", "audit"]);
    this.#silence = options.silence === null ? null : { maxSilentMs: options.silence?.maxSilentMs ?? 12 * 3_600_000, notify: options.silence?.notify ?? "ceo" };
    this.#retryPolicy = options.retryPolicy ?? { maxAttempts: 0, baseDelayMs: 1_000 };
    this.#profiles = new Map([["ceo", { agent: "ceo", role: "ceo" } satisfies AgentProfile], ...(options.profiles ?? []).map((profile) => [profile.agent, profile] as const)]);
    this.#runnerProfiles = new Map((options.runnerProfiles ?? []).map((profile) => [profile.id, profile] as const));
    this.#verifyMetricsAfterWake = options.verifyMetricsAfterWake ?? false;
  }

  registerConnector(connector: ConnectorProcessSpec): void { this.#connectors.set(connector.manifest.connector, connector); }
  registerMetricContract(goalId: string, contract: MetricContract): void { this.#metricContracts.set(goalId, contract); }
  registerMetricCollector(goalId: string, contract: MetricContract, spec: MetricProcessSpec, intervalMs = 60_000): void {
    this.registerMetricContract(goalId, contract);
    this.#metricCollectors.set(goalId, { goalId, contract, spec, intervalMs, nextAt: 0 });
  }

  /**
   * Hot-swap the runner after a config reload. Refused while a wake is leased
   * or running: a live child must never observe its runner vanish mid-flight.
   * The next tick claims wakes through the new runner, and spawn-time env
   * resolution applies the new credentials to the next spawn.
   */
  swapRunner(runner: Runner, profiles?: RunnerProfile[]): void {
    const active = this.ledger.wakes().filter((wake) => wake.status === "leased" || wake.status === "running");
    if (active.length > 0) throw new Error("cannot swap runner while a wake is leased or running");
    this.#runner = runner;
    if (profiles) { this.#runnerProfiles.clear(); for (const profile of profiles) this.#runnerProfiles.set(profile.id, profile); }
  }
  get runner(): Runner { return this.#runner; }
  createGoal(goal: GoalSnapshot, actor = "human"): void { this.ledger.putGoal(goal, actor); }
  createRootGoal(objective: string, id: string = randomUUID()): GoalSnapshot {
    if (!objective.trim()) throw new Error("root objective is required");
    const goal: GoalSnapshot = { id, parentId: null, objective, observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 };
    this.ledger.putGoal(goal, "human");
    return this.#goal(id);
  }
  startGoal(objective: string, id: string = randomUUID()): { goal: GoalSnapshot; wake: WakeSnapshot } {
    const goal = this.createRootGoal(objective, id);
    const wake = this.#enqueueTrigger("ceo", `root:${id}:created`);
    if (!wake) throw new Error("CEO wake was not admitted for an active root goal");
    return { goal, wake };
  }
  interactWithCeo(message: string): { mail: MailSnapshot; wake: WakeSnapshot } {
    if (!message.trim()) throw new Error("message is required");
    const mail: MailSnapshot = { id: randomUUID(), to: "ceo", from: "human", level: "fyi", body: { type: "interaction", message }, readAt: null };
    this.ledger.putMail(mail, "human");
    const wake = this.#enqueueTrigger("ceo", `interaction:${mail.id}`);
    if (!wake) throw new Error("CEO interaction was not admitted");
    return { mail, wake };
  }
  sendToCeo(body: JsonValue, level: "fyi" | "decision" | "emergency" = "decision"): { mail: MailSnapshot; wake: WakeSnapshot } {
    const mail = { id: randomUUID(), to: "ceo", from: "human", level, body, readAt: null };
    this.ledger.putMail(mail, "human");
    const wake = this.#enqueueTrigger("ceo", `mail:${mail.id}`);
    if (!wake) throw new Error("CEO wake was not admitted");
    return { mail, wake };
  }
  delegate(request: DelegationRequest, actor = "ceo", wakeId?: string): DelegationResult { return this.ledger.commitDelegation(request, actor, wakeId); }
  reassignGoal(request: ReassignmentRequest, actor = "ceo", wakeId?: string): ReassignmentResult { return this.ledger.commitReassignment(request, actor, wakeId); }
  teamList(now = this.#now()): TeamMemberView[] { return deriveTeam(this.ledger, now); }
  updateGoal(id: string, patch: Partial<Pick<GoalSnapshot, "objective" | "observationMethod" | "owner">>, actor = "human"): GoalSnapshot {
    if (patch.objective === undefined && patch.observationMethod === undefined && patch.owner === undefined) throw new Error("goal update requires objective, observation method, or owner");
    const current = this.#goal(id);
    if (patch.objective !== undefined && patch.objective !== current.objective && current.parentId !== null && patch.observationMethod === undefined) throw new Error("child objective revision requires a replacement observation method");
    const next = {
      ...current,
      ...patch,
      ...(patch.objective !== undefined && patch.objective !== current.objective && current.parentId === null && patch.observationMethod === undefined ? { observationMethod: null } : {}),
      revision: current.revision + 1,
    };
    this.ledger.putGoal(next, actor);
    if (next.parentId === null && next.owner === "ceo" && actor === "human") this.#enqueueTrigger("ceo", `root:${id}:revised:${next.revision}`);
    return next;
  }
  confirmObservationMethod(id: string, observationMethod: string): GoalSnapshot {
    const current = this.#goal(id);
    if (current.parentId !== null) throw new Error("human confirmation applies only to a root goal");
    return this.updateGoal(id, { observationMethod }, "human");
  }
  reviseChildGoal(id: string, objective: string, observationMethod: string, actor: string, reason: string, evidence: number[], wakeId?: string): GoalSnapshot {
    const current = this.#goal(id);
    if (current.parentId === null) throw new Error("CEO cannot revise a root goal");
    if (!reason.trim()) throw new Error("goal revision reason is required");
    for (const seq of evidence) if (!this.ledger.eventsSince(seq - 1).some((event) => event.seq === seq)) throw new Error(`evidence event does not exist: ${seq}`);
    this.ledger.appendEvent({ streamId: wakeId ? wakeStream(wakeId) : goalStream(id), ts: this.#now(), actor, type: "goal.revision_requested", data: { goalId: id, fromRevision: current.revision, objective, observationMethod, reason, evidence } });
    return this.updateGoal(id, { objective, observationMethod }, actor);
  }
  completeGoal(request: GoalCompletionRequest, actor = "human", wakeId?: string): GoalSnapshot {
    const goal = this.ledger.completeGoal(request, actor, wakeId);
    this.#suppressQueuedWake(goal.owner, `goal:${goal.id}:complete`);
    if (goal.parentId && actor !== "ceo") this.#enqueueTrigger("ceo", `goal:${goal.id}:complete:${goal.revision}`);
    return goal;
  }
  transitionGoal(id: string, phase: GoalPhase, actor = "human"): GoalSnapshot {
    const current = this.#goal(id);
    if (current.phase === phase) return current;
    if (phase === "complete") throw new Error("goal completion requires reason and evidence");
    const next = { ...current, phase, revision: current.revision + 1 };
    this.ledger.putGoal(next, actor);
    if (phase === "paused") this.#suppressQueuedWake(next.owner, `goal:${id}:${phase}`);
    if (phase === "active") this.#enqueueTrigger(next.owner, `${next.parentId ? "goal" : "root"}:${id}:resumed:${next.revision}`);
    if (next.parentId && actor !== "ceo" && phase === "blocked") this.#enqueueTrigger("ceo", `goal:${id}:${phase}:${next.revision}`);
    return next;
  }

  planWake(agent: string, at: string, reason: string, setBy = agent): WakeSnapshot | null {
    const schedule: ScheduleSnapshot = { id: `schedule:${agent}`, agent, nextWakeAt: at, reason, setBy };
    this.ledger.putSchedule(schedule, setBy);
    return at <= this.#now() ? this.#enqueueSchedule(schedule) : null;
  }

  async stopAgentWake(agent: string): Promise<WakeSnapshot | null> {
    const wake = this.ledger.wakes().find((item) => item.agent === agent && ["running", "leased", "queued"].includes(item.status));
    if (!wake) return null;
    if (wake.status === "queued") { this.#suppressQueuedWake(agent, "stopped by human"); return this.#wake(wake.id); }
    const handle = this.#handles.get(wake.id);
    if (handle) await handle.terminate(); else if (wake.runnerPid) await this.runner.terminateProcess(wake.runnerPid);
    return this.#wake(wake.id);
  }

  async recover(): Promise<void> {
    this.ledger.recoverDispatchingActions();
    for (const expired of this.ledger.expiredWakes(this.#now())) {
      if (expired.status === "running" && expired.runnerPid) await this.runner.terminateProcess(expired.runnerPid);
      this.ledger.recoverExpiredWake(expired.id, this.#now());
    }
  }
  async tick(): Promise<WakeSnapshot | null> {
    const claimed = await this.#claimNextWake();
    const wake = claimed?.wake ?? null;
    if (!wake) return null;
    const leaseToken = claimed!.leaseToken;
    let running = wake;
    let handle: RunnerHandle | null = null;
    let renewal: NodeJS.Timeout | undefined;
    try {
      running = this.ledger.markWakeRunning(wake.id, this.#now(), leaseToken);
      const turn = this.#turnContext(running);
      const context = this.#loadContext(running, turn);
      handle = this.runner.prepare({
        wake: running,
        turn,
        context,
        now: () => this.#now(),
        emit: (trace) => this.ledger.appendRunnerEvent({ streamId: wakeStream(running.id), ts: this.#now(), actor: running.agent, type: trace.type, data: trace.data }, leaseToken),
        rpc: (method, params) => this.#agentRpc(running, turn, leaseToken, method, params),
      });
      this.#handles.set(running.id, handle);
      if (handle.pid) running = this.ledger.attachWakeProcess(running.id, leaseToken, handle.pid, this.#now());
      renewal = setInterval(() => {
        try {
          const now = this.clock.now();
          this.ledger.renewWakeLease(running.id, leaseToken, new Date(now.getTime() + this.#leaseMs).toISOString(), now.toISOString());
        } catch { void handle?.terminate(); }
      }, Math.max(25, Math.floor(this.#leaseMs / 3)));
      renewal.unref();
      handle.begin();
      const result = await handle.result;
      clearInterval(renewal); renewal = undefined;
      await handle.terminate();
      this.#handles.delete(running.id);
      if (result.outcome === "abnormal") {
        await this.#markAbnormal(running, result.reason);
        return this.#wake(running.id);
      }

      if (result.outcome === "response") {
        if (turn.goalBinding) throw new Error("a Goal-bound Turn must finish with a handoff");
        const mailId = interactionMailId(running);
        if (!mailId) throw new Error("an ordinary response requires an interaction mail");
        this.ledger.commitInteraction({ agent: running.agent, wakeId: running.id, mailId, ts: this.#now(), response: result.response });
        this.ledger.finishWake(running.id, "done", this.#now());
        return this.#wake(running.id);
      }

      this.#validateCeoHandoff(running, result.output);

      const outgoingMail = result.output.mail.map((draft) => ({ id: randomUUID(), to: draft.to, from: running.agent, level: draft.level, body: draft.body, readAt: null }));
      const schedule = result.output.nextWakeAt
        ? { id: `schedule:${running.agent}`, agent: running.agent, nextWakeAt: result.output.nextWakeAt, reason: "handoff.next_steps", setBy: running.agent }
        : null;
      const handoffEvent = this.ledger.commitHandoff({ agent: running.agent, wakeId: running.id, ts: this.#now(), output: result.output, outgoingMail, schedule });
      this.ledger.finishWake(running.id, "done", this.#now());
      if (this.#role(running.agent) !== "ceo" && (result.output.handoff.material || result.output.handoff.blocker) && this.#hasActiveRoot()) {
        this.#enqueueTrigger("ceo", `child-handoff:${handoffEvent.seq}`);
      }
      if (this.#verifyMetricsAfterWake) {
        for (const goal of this.ledger.goalsForOwner(running.agent)) if (this.#metricCollectors.has(goal.id)) await this.collectMetricNow(goal.id);
      }
      return this.#wake(running.id);
    } catch (error) {
      if (renewal) clearInterval(renewal);
      if (handle) await handle.terminate();
      this.#handles.delete(running.id);
      await this.#markAbnormal(running, error instanceof Error ? error.message : String(error));
      return this.#wake(running.id);
    }
  }

  async #claimNextWake(): Promise<{ wake: WakeSnapshot; leaseToken: string } | null> {
    const previous = this.#claimTail;
    let release!: () => void;
    this.#claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      for (const schedule of this.ledger.dueSchedules(this.#now())) this.#enqueueSchedule(schedule);
      await this.#collectMetrics();
      this.#scheduleMetricAlerts();
      this.#checkSystemSilence();
      for (const mail of this.ledger.triggeringMail()) this.#enqueueTrigger(mail.to, `mail:${mail.id}`);
      const now = this.clock.now();
      const leaseToken = randomUUID();
      const wake = this.ledger.claimNextWake(now.toISOString(), new Date(now.getTime() + this.#leaseMs).toISOString(), leaseToken);
      return wake ? { wake, leaseToken } : null;
    } finally {
      release();
    }
  }

  async runAvailable(concurrency = 4, maxWakes = 100): Promise<WakeSnapshot[]> {
    const completed: WakeSnapshot[] = [];
    while (true) {
      const batch = await Promise.all(Array.from({ length: concurrency }, () => this.tick()));
      const wakes = batch.filter((wake): wake is WakeSnapshot => wake !== null);
      completed.push(...wakes);
      if (wakes.length === 0 || completed.length >= maxWakes) return completed;
    }
  }

  async submitAction(action: Omit<ActionSnapshot, "connector" | "gated" | "status" | "reconciledAt" | "externalRef">, connectorName: string, wakeId?: string): Promise<ActionSnapshot> {
    const connector = this.#connectors.get(connectorName);
    const capability = connector ? capabilityFor(connector.manifest, action.kind) : null;
    const gated = !connector || !capability || capability.risk !== "reversible"
      || (!connector.manifest.dryRun && !this.#allowExternalActions);
    if (gated && action.agent !== "ceo") this.#assertAgentGoalsCurrent(action.agent);
    const requested: ActionSnapshot = { ...action, connector: connectorName, gated, status: "requested", reconciledAt: null, externalRef: null };
    this.ledger.requestAction(requested, action.agent, wakeId);
    if (gated || !connector) return this.#action(action.id);
    this.ledger.approveAction(action.id, "supervisor", "declared reversible dry-run capability", action.evidence);
    return this.#dispatch(action.id);
  }

  async approveAction(id: string, approver: string, reason: string, evidence: number[]): Promise<ActionSnapshot> {
    if (!this.#approvers.has(approver)) throw new Error("actor is not authorized to approve actions");
    this.ledger.approveAction(id, approver, reason, evidence);
    return this.#dispatch(id);
  }

  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    if (!this.#approvers.has(approver)) throw new Error("actor is not authorized to reject actions");
    return this.ledger.rejectAction(id, approver, reason, evidence);
  }

  putAuditAdvice(id: string, advice: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot {
    const role = this.#profiles.get(advice.by)?.role;
    if (!this.#auditWriters.has(advice.by) && role !== "verifier" && role !== "audit") throw new Error("actor is not authorized to write audit advice");
    return this.ledger.putAuditAdvice(id, advice, wakeId);
  }

  ackAuditAdvice(id: string, agent: string): ActionSnapshot { return this.ledger.ackAuditAdvice(id, agent); }

  recordMetric(sample: MetricSample): MetricEvaluation {
    const goal = this.ledger.goal(sample.goalId);
    if (!goal) throw new Error(`metric goal not found: ${sample.goalId}`);
    const contract = this.#metricContracts.get(goal.id);
    if (!contract) throw new Error(`metric contract is not registered: ${goal.id}`);
    if (contract.source !== sample.source) throw new Error("metric source does not match registered contract");
    this.ledger.appendEvent({ streamId: `metric:${goal.id}`, ts: this.#now(), actor: "supervisor", type: "metric.sampled", data: sample as unknown as JsonValue });
    const evaluation = evaluateMetric(contract, this.ledger.metricSamples(goal.id), this.#now());
    this.ledger.appendEvent({ streamId: `metric:${goal.id}`, ts: this.#now(), actor: "supervisor", type: "metric.evaluated", data: evaluation as unknown as JsonValue });
    if (evaluation.shouldWakeOwner) this.#enqueueTrigger(goal.owner, `metric:${goal.id}:${sample.observedAt}`);
    return evaluation;
  }

  async collectMetricNow(goalId: string): Promise<MetricEvaluation> {
    const registration = this.#metricCollectors.get(goalId);
    if (!registration) throw new Error(`metric collector is not registered: ${goalId}`);
    registration.nextAt = this.clock.now().getTime() + registration.intervalMs;
    const sample = await runJsonProcess<MetricSample>(registration.spec, { goalId });
    return this.recordMetric({ ...sample, goalId });
  }

  async reconcileAction(id: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be reconciled");
    const connector = this.#requiredConnector(action.connector);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability || capability.query === "none") throw new Error("connector cannot reconcile this action");
    const result = await runConnector<ConnectorQueryResult>(connector, "query", action);
    if (result.status === "pending") return action;
    return this.ledger.transitionAction(id, result.status, { reconciledAt: this.#now(), ...(result.externalRef ? { externalRef: result.externalRef } : {}) });
  }

  async retryUnknownAction(id: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be retried");
    const connector = this.#requiredConnector(action.connector);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability?.nativeIdempotency || !capability.automaticRetry) throw new Error("connector manifest forbids automatic retry");
    return this.#dispatch(id);
  }

  async #dispatch(id: string): Promise<ActionSnapshot> {
    const current = this.#action(id);
    const connector = this.#requiredConnector(current.connector);
    const dispatching = this.ledger.transitionAction(id, "dispatching");
    const result = await runConnector<ConnectorDispatchResult>(connector, "dispatch", dispatching);
    return this.ledger.transitionAction(id, result.status, result.externalRef ? { externalRef: result.externalRef } : {});
  }

  async #markAbnormal(wake: WakeSnapshot, reason: string): Promise<void> {
    const current = this.#wake(wake.id);
    if (current.runnerPid) await this.runner.terminateProcess(current.runnerPid);
    this.ledger.appendEvent({ streamId: wakeStream(current.id), ts: this.#now(), actor: current.agent, type: "wake.abnormal_reason", data: { reason } });
    const repairs = interruptedSessionEvents(this.ledger.eventsForWake(current.id), this.#now(), "supervisor");
    if (repairs.length) this.ledger.appendEvents(repairs);
    if (["leased", "running", "queued"].includes(current.status)) {
      this.ledger.finishWake(current.id, "abnormal", this.#now());
      if (current.attempt < this.#retryPolicy.maxAttempts) {
        const delay = this.#retryPolicy.baseDelayMs * 2 ** Math.max(0, current.attempt - 1);
        const schedule: ScheduleSnapshot = { id: `retry:${current.id}`, agent: current.agent, nextWakeAt: new Date(this.clock.now().getTime() + delay).toISOString(), reason: `recovery:${current.id}`, setBy: "supervisor" };
        this.ledger.putSchedule(schedule, "supervisor", current.id);
      } else if (current.agent !== "ceo" && this.#hasActiveRoot()) {
        this.#enqueueTrigger("ceo", `child-retry-exhausted:${current.id}`);
      }
    }
  }

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot | null {
    return this.#enqueueTrigger(schedule.agent, `${schedule.id}@${schedule.nextWakeAt}`);
  }

  #enqueueTrigger(agent: string, triggerRef: string): WakeSnapshot | null {
    const exact = this.ledger.wakeByTrigger(agent, triggerRef);
    if (exact) return exact;
    const ownsLiveGoal = this.ledger.goalsForOwner(agent).some((goal) => goal.phase === "active" || goal.phase === "blocked");
    const ceoInterrupt = agent === "ceo" && (triggerRef.startsWith("interaction:") || triggerRef.startsWith("mail:") || triggerRef.startsWith("child-"));
    if (!ownsLiveGoal && !ceoInterrupt) return null;
    const queued = triggerRef.startsWith("interaction:") ? null : this.ledger.queuedWakeForAgent(agent);
    if (queued) {
      this.ledger.appendEvent({ streamId: wakeStream(queued.id), ts: this.#now(), actor: "supervisor", type: "wake.trigger_coalesced", data: { wakeId: queued.id, triggerRef } });
      return queued;
    }
    const wake: WakeSnapshot = { id: randomUUID(), agent, triggerRef, status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return this.#wake(wake.id);
    const existing = this.ledger.wakeByTrigger(agent, triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #suppressQueuedWake(agent: string, reason: string): void {
    const wake = this.ledger.queuedWakeForAgent(agent);
    if (!wake) return;
    this.ledger.appendEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: "supervisor", type: "wake.suppressed", data: { reason } });
    this.ledger.finishWake(wake.id, "abnormal", this.#now());
  }

  #hasActiveRoot(): boolean { return this.ledger.goals().some((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase === "active"); }
  #role(agent: string): AgentRole { return this.#profiles.get(agent)?.role ?? "child"; }

  #validateCeoHandoff(wake: WakeSnapshot, output: WakeOutput): void {
    if (this.#role(wake.agent) !== "ceo") return;
    const idle = this.teamList().filter((member) => member.agent !== "ceo" && member.status === "idle_unplanned");
    const missingObservationGoalIds = this.ledger.goals().filter((goal) => goal.parentId !== null && goal.phase !== "complete" && goal.observationMethod === null).map((goal) => goal.id);
    const activeRoot = this.#hasActiveRoot();
    const hasChildMotion = this.teamList().some((member) => member.agent !== "ceo" && !["idle_unplanned", "retired"].includes(member.status));
    const hasReview = Boolean(output.nextWakeAt);
    const hasBlocker = Boolean(output.handoff.blocker);
    const asksHuman = output.mail.some((mail) => mail.to === "human" && (mail.level === "decision" || mail.level === "emergency"))
      || this.ledger.unreadMail("human").some((mail) => mail.from === "ceo" && (mail.level === "decision" || mail.level === "emergency"));
    if (idle.length === 0 && missingObservationGoalIds.length === 0 && (!activeRoot || hasChildMotion || hasReview || hasBlocker || asksHuman)) return;
    const violation = {
      idleAgents: idle.map((member) => member.agent),
      missingObservationGoalIds,
      reason: missingObservationGoalIds.length ? "active child goal has no observation method" : idle.length ? "active child goal has no liveness route" : "active root has no motion, review, wait, blocker, or human request",
    };
    this.ledger.appendEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: "supervisor", type: "ceo.motion_invalid", data: violation });
    throw new Error(`CEO motion invalid: ${violation.reason}${violation.idleAgents.length ? ` (${violation.idleAgents.join(", ")})` : ""}`);
  }

  #turnContext(wake: WakeSnapshot): TurnContext {
    if (interactionMailId(wake)) return { source: { kind: "human" } };
    const goals = this.ledger.goalsForOwner(wake.agent).filter((goal) => goal.phase === "active");
    const goal = goals.find((candidate) => candidate.parentId === null) ?? goals[0];
    const humanMail = wake.triggerRef.startsWith("mail:") && this.ledger.mailbox().some((mail) => mail.id === wake.triggerRef.slice(5) && mail.from === "human");
    return { source: humanMail ? { kind: "human" } : { kind: "goal_driver", round: wake.attempt }, ...(goal ? { goalBinding: { goalId: goal.id, goalRevision: goal.revision } } : {}) };
  }

  #loadContext(wake: WakeSnapshot, turn: TurnContext): JsonValue {
    const profile = this.#profiles.get(wake.agent) ?? { agent: wake.agent, role: "child" as const };
    const role = profile.role;
    const capabilities = profile.capabilities ?? defaultCapabilities(role);
    const runnerProfile = this.#runnerProfiles.get(profile.runnerProfile ?? "default");
    if (!turn.goalBinding && interactionMailId(wake)) {
      const mail = this.ledger.mailbox().find((candidate) => candidate.id === interactionMailId(wake));
      const body = mail?.body && typeof mail.body === "object" && !Array.isArray(mail.body) ? mail.body as Record<string, JsonValue> : {};
      const message = typeof body.message === "string" ? body.message : "";
      const mailEvent = this.ledger.eventsSince(0, ["mail.put"]).findLast((event) => (event.data as { snapshot?: { id?: string } }).snapshot?.id === mail?.id);
      const recent = this.ledger.eventsSince(0, ["interaction.completed"]).filter((event) => event.actor === wake.agent).slice(-8).map((event) => {
        const data = event.data as { mailId?: string; response?: { content?: string } };
        const prior = this.ledger.mailbox().find((candidate) => candidate.id === data.mailId);
        const priorBody = prior?.body && typeof prior.body === "object" && !Array.isArray(prior.body) ? prior.body as Record<string, JsonValue> : {};
        return `Human: ${typeof priorBody.message === "string" ? priorBody.message : ""}\nAssistant: ${data.response?.content ?? ""}`;
      });
      return {
        text: [`# Human message\n\n${message}`, ...(recent.length ? [`# Recent conversation\n\n${recent.join("\n\n")}`] : [])].join("\n\n"),
        sourceSeqs: mailEvent ? [mailEvent.seq] : [],
        capabilities,
        systemPrompt: profile.systemPrompt ?? "You are Goah's primary Agent. Respond naturally to the Human, use tools when useful, and keep the final answer concise. Do not create or operate a Goal unless the Human expresses durable Goal intent.",
        ...(runnerProfile ? { runnerProfile } : {}),
      } as unknown as JsonValue;
    }
    const goals = role === "ceo" ? this.ledger.goals() : this.ledger.goalsForOwner(wake.agent);
    const mail = this.ledger.unreadMail(wake.agent);
    const handoff = this.ledger.lastEvent(wake.agent, "handoff.recorded");
    const recoveryId = wake.triggerRef.startsWith("recovery:")
      ? wake.triggerRef.slice("recovery:".length)
      : wake.triggerRef.startsWith("retry:") ? wake.triggerRef.slice("retry:".length).split("@")[0] : null;
    const recoveryEvents = recoveryId ? selectRecoveryEvents(this.ledger.eventsForWake(recoveryId)) : [];
    const teamHandoffs = role === "ceo"
      ? [...this.ledger.eventsSince(0, ["handoff.recorded"])].reverse().filter((event, index, all) => all.findIndex((candidate) => candidate.actor === event.actor) === index)
      : [];
    const actions = this.ledger.actions().filter((action) => action.agent === wake.agent && (action.status === "unknown" || Boolean(action.auditAdvice && !action.adviceAcked)));
    const revisionWarnings = goals.flatMap((goal) => this.#goalRevisionWarning(goal));
    const workingMemory = selectWorkingMemory(this.ledger.readStream(memoryStream(wake.agent)), this.#memoryTailChars);
    return { ...composeActiveContext({ role, capabilities, systemPrompt: profile.systemPrompt ?? defaultRolePrompt(role), wake, goals, mail, actions, lastHandoff: handoff, teamHandoffs, team: role === "ceo" ? this.teamList() : [], revisionWarnings, recoveryEvents, workingMemory }), ...(runnerProfile ? { runnerProfile } : {}) } as unknown as JsonValue;
  }

  #requiredConnector(name: string): ConnectorProcessSpec { const value = this.#connectors.get(name); if (!value) throw new Error(`connector not registered: ${name}`); return value; }
  #wake(id: string): WakeSnapshot { const value = this.ledger.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #action(id: string): ActionSnapshot { const value = this.ledger.action(id); if (!value) throw new Error(`action not found: ${id}`); return value; }
  #goal(id: string): GoalSnapshot { const value = this.ledger.goal(id); if (!value) throw new Error(`goal not found: ${id}`); return value; }
  #goalRevisionWarning(goal: GoalSnapshot): string[] {
    if (goal.parentId === null || goal.phase === "complete") return [];
    let root = this.#goal(goal.parentId);
    while (root.parentId !== null) root = this.#goal(root.parentId);
    const rootSeq = this.ledger.readStream(goalStream(root.id)).filter((event) => event.type === "goal.put").at(-1)?.seq ?? 0;
    const goalSeq = this.ledger.readStream(goalStream(goal.id)).filter((event) => event.type === "goal.put").at(-1)?.seq ?? 0;
    return rootSeq > goalSeq ? [`Goal ${goal.id} predates root revision ${root.revision}; CEO must revise its objective/observation method before new gated actions.`] : [];
  }
  #assertAgentGoalsCurrent(agent: string): void {
    const warnings = this.ledger.goalsForOwner(agent).flatMap((goal) => this.#goalRevisionWarning(goal));
    if (warnings.length) throw new Error(warnings.join(" "));
  }
  #now(): string { return this.clock.now().toISOString(); }

  async #agentRpc(wake: WakeSnapshot, turn: TurnContext, leaseToken: string, method: AgentCapability, params: JsonValue): Promise<JsonValue> {
    const current = this.ledger.wake(wake.id);
    if (!current || current.status !== "running" || current.leaseToken !== leaseToken || !current.leaseUntil || current.leaseUntil < this.#now()) throw new Error("stale runner RPC rejected");
    const profile = this.#profiles.get(wake.agent) ?? { agent: wake.agent, role: "child" as const };
    const allowed = new Set(profile.capabilities ?? defaultCapabilities(profile.role));
    if (!allowed.has(method)) throw new Error(`${profile.role} agent is not allowed to call ${method}`);
    this.ledger.appendRunnerEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: wake.agent, type: `rpc.${method}`, data: params }, leaseToken);
    const input = asRecord(params);
    if (method === "ledger.search") return this.ledger.searchEvents(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "team.list") return this.teamList() as unknown as JsonValue;
    if (method === "goal.get") return (turn.goalBinding ? this.ledger.goal(turn.goalBinding.goalId) : null) as unknown as JsonValue;
    if (method === "goal.create") {
      if (turn.source.kind !== "human" || turn.goalBinding) throw new Error("a Root Goal can only be created from an unbound Human Turn");
      if (wake.agent !== "ceo") throw new Error("only CEO may translate Human intent into a Root Goal");
      const goal = this.createRootGoal(String(input.objective), typeof input.id === "string" && input.id.trim() ? input.id : undefined);
      turn.goalBinding = { goalId: goal.id, goalRevision: goal.revision };
      this.ledger.appendRunnerEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: wake.agent, type: "turn.goal_bound", data: { goalId: goal.id, goalRevision: goal.revision, authority: "human" } }, leaseToken);
      return { goal, goalBinding: turn.goalBinding, instruction: "This Turn is now Goal-bound. Update its Work Record and finish with handoff." } as unknown as JsonValue;
    }
    if (method === "goal.work") {
      if (turn.source.kind !== "human" || turn.goalBinding) throw new Error("work_on_goal requires an unbound Human Turn");
      const goal = this.#goal(String(input.goalId));
      if (goal.owner !== wake.agent || goal.phase !== "active") throw new Error("work_on_goal requires an active Goal owned by this Agent");
      turn.goalBinding = { goalId: goal.id, goalRevision: goal.revision };
      this.ledger.appendRunnerEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: wake.agent, type: "turn.goal_bound", data: { goalId: goal.id, goalRevision: goal.revision, authority: "human" } }, leaseToken);
      return { goal, goalBinding: turn.goalBinding, instruction: "This Turn is now Goal-bound. Update its Work Record and finish with handoff." } as unknown as JsonValue;
    }
    if (method === "work_record.list") return this.ledger.workRecords() as unknown as JsonValue;
    if (method === "work_record.read") return this.ledger.workRecord(String(input.goalId ?? turn.goalBinding?.goalId ?? "")) as unknown as JsonValue;
    if (method === "work_record.history") return this.ledger.workRecordHistory(String(input.goalId ?? turn.goalBinding?.goalId ?? "")) as unknown as JsonValue;
    if (method === "work_record.search") return this.ledger.searchWorkRecords(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "work_record.update") {
      if (!turn.goalBinding) throw new Error("work_record.update requires a Goal-bound Turn");
      return this.ledger.updateWorkRecord({ goalId: turn.goalBinding.goalId, goalRevision: turn.goalBinding.goalRevision, expectedRevision: Number(input.expectedRevision), content: String(input.content), reason: String(input.reason), evidence: numberArray(input.evidence), turnId: wake.id, wakeId: wake.id }, wake.agent) as unknown as JsonValue;
    }
    if (method === "goal.delegate") return this.delegate({
      id: String(input.id),
      parentGoalId: String(input.parentGoalId),
      childGoal: asChildGoal(input.childGoal),
      brief: (input.brief ?? null) as JsonValue,
      reason: String(input.reason),
      evidence: numberArray(input.evidence),
    }, wake.agent, wake.id) as unknown as JsonValue;
    if (method === "goal.reassign") return this.reassignGoal({
      id: String(input.id),
      goalId: String(input.goalId),
      newOwner: String(input.newOwner),
      brief: (input.brief ?? null) as JsonValue,
      reason: String(input.reason),
      evidence: numberArray(input.evidence),
    }, wake.agent, wake.id) as unknown as JsonValue;
    if (method === "goal.revise") return this.reviseChildGoal(String(input.goalId), String(input.objective), String(input.observationMethod), wake.agent, String(input.reason), numberArray(input.evidence), wake.id) as unknown as JsonValue;
    if (method === "goal.pause" || method === "goal.resume") return this.transitionGoal(String(input.goalId), method === "goal.pause" ? "paused" : "active", wake.agent) as unknown as JsonValue;
    if (method === "goal.complete") return this.completeGoal({ goalId: String(input.goalId), revision: Number(input.revision), reason: String(input.reason), evidence: numberArray(input.evidence) }, wake.agent, wake.id) as unknown as JsonValue;
    if (method === "human.request") {
      const evidence = numberArray(input.evidence);
      for (const seq of evidence) if (!this.ledger.eventsSince(seq - 1).some((event) => event.seq === seq)) throw new Error(`evidence event does not exist: ${seq}`);
      const mail: MailSnapshot = { id: randomUUID(), to: "human", from: wake.agent, level: "decision", body: { type: String(input.type ?? "decision"), message: input.message ?? null, evidence }, readAt: null };
      this.ledger.putMail(mail, wake.agent, wake.id);
      this.ledger.appendRunnerEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: wake.agent, type: "ceo.human_requested", data: mail.body }, leaseToken);
      return mail as unknown as JsonValue;
    }
    if (method === "mail.send") {
      const mail = { id: randomUUID(), to: String(input.to), from: wake.agent, level: String(input.level) as "fyi" | "decision" | "emergency", body: (input.body ?? null) as JsonValue, readAt: null };
      this.ledger.putMail(mail, wake.agent, wake.id); return mail as unknown as JsonValue;
    }
    if (method === "memory.append") {
      const note = String(input.note ?? "").trim();
      if (!note) throw new Error("memory note cannot be empty");
      const record = this.ledger.appendEvent({ streamId: memoryStream(wake.agent), ts: this.#now(), actor: wake.agent, type: "memory.appended", data: { note, wakeId: wake.id } });
      return { seq: record.seq, streamSeq: record.streamSeq } as unknown as JsonValue;
    }
    if (method === "schedule.set") return (this.planWake(wake.agent, String(input.at), String(input.reason), wake.agent) ?? { scheduled: true }) as unknown as JsonValue;
    if (method === "audit.ack") return this.ackAuditAdvice(String(input.actionId), wake.agent) as unknown as JsonValue;
    if (method === "audit.write") return this.putAuditAdvice(String(input.actionId), { by: wake.agent, body: (input.body ?? null) as JsonValue, evidence: numberArray(input.evidence) }, wake.id) as unknown as JsonValue;
    if (method === "goal.put") { this.ledger.putGoal(input.goal as unknown as GoalSnapshot, wake.agent, wake.id); return input.goal as JsonValue; }
    const action = await this.submitAction({
      id: String(input.id), agent: wake.agent, kind: String(input.kind), payload: (input.payload ?? null) as JsonValue, reason: String(input.reason), evidence: numberArray(input.evidence), auditAdvice: null, adviceAcked: false,
    }, String(input.connector), wake.id);
    return action as unknown as JsonValue;
  }

  async #collectMetrics(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const registration of this.#metricCollectors.values()) {
      if (registration.nextAt > now) continue;
      registration.nextAt = now + registration.intervalMs;
      const sample = await runJsonProcess<MetricSample>(registration.spec, { goalId: registration.goalId });
      this.recordMetric({ ...sample, goalId: registration.goalId });
    }
  }

  #scheduleMetricAlerts(): void {
    for (const [goalId, contract] of this.#metricContracts) {
      const goal = this.ledger.goal(goalId);
      if (!goal) continue;
      const samples = this.ledger.metricSamples(goal.id);
      const evaluation = evaluateMetric(contract, samples, this.#now());
      if (evaluation.shouldWakeOwner) this.#enqueueTrigger(goal.owner, `metric:${goal.id}:${evaluation.status}:${samples.at(-1)?.observedAt ?? "none"}`);
    }
  }

  /** The one mechanical floor: total ledger silence. Any event from anyone resets the clock; stall policy is the CEO's business, not the supervisor's. */
  #checkSystemSilence(): void {
    if (!this.#silence) return;
    const last = this.ledger.latestEvent();
    if (!last) return;
    const silentMs = this.clock.now().getTime() - Date.parse(last.ts);
    if (silentMs <= this.#silence.maxSilentMs) return;
    const fact = { silentMs, lastEventSeq: last.seq, lastEventAt: last.ts };
    this.ledger.appendEvent({ streamId: controlStream("watchdog"), ts: this.#now(), actor: "supervisor", type: "watchdog.system_silence", data: { ...fact, notify: this.#silence.notify } });
    this.ledger.putMail({ id: `silence:${last.seq}`, to: this.#silence.notify, from: "supervisor", level: "decision", readAt: null, body: { type: "system_silence", ...fact, note: "No ledger events system-wide within the silence window. Confirm this is expected and hand off." } }, "supervisor");
  }
}

export async function runSupervisorDaemon(supervisor: Supervisor, options: { pollMs?: number; concurrency?: number; signal?: AbortSignal; onError?: (error: unknown) => void } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1_000;
  await supervisor.recover();
  while (!options.signal?.aborted) {
    try { await supervisor.runAvailable(options.concurrency ?? 4); }
    catch (error) { options.onError?.(error); }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

export function deriveTeam(ledger: Ledger, now = new Date().toISOString()): TeamMemberView[] {
  const goals = ledger.goals();
  const wakes = ledger.wakes();
  const schedules = ledger.schedules();
  const handoffs = ledger.eventsSince(0, ["handoff.recorded"]);
  const owners = [...new Set(goals.map((goal) => goal.owner))].sort();
  return owners.map((agent) => {
    const owned = goals.filter((goal) => goal.owner === agent);
    const live = owned.filter((goal) => goal.phase !== "complete");
    const agentWakes = wakes.filter((wake) => wake.agent === agent).sort((a, b) => b.enqueuedSeq - a.enqueuedSeq);
    const activeWake = agentWakes.find((wake) => ["running", "leased", "queued"].includes(wake.status));
    const nextWakeAt = schedules.filter((schedule) => schedule.agent === agent && schedule.nextWakeAt > now).map((schedule) => schedule.nextWakeAt).sort()[0] ?? null;
    const lastHandoff = [...handoffs].reverse().find((event) => event.actor === agent) ?? null;
    const blocker = lastHandoff && typeof lastHandoff.data === "object" && lastHandoff.data !== null && !Array.isArray(lastHandoff.data)
      ? (lastHandoff.data as Record<string, JsonValue>).blocker
      : null;
    let status: TeamMemberView["status"];
    if (live.length === 0) status = "retired";
    else if (activeWake?.status === "running") status = "running";
    else if (activeWake) status = "queued";
    else if (nextWakeAt) status = "scheduled";
    else if (live.every((goal) => goal.phase === "blocked")) status = "blocked";
    else if (live.every((goal) => goal.phase === "paused") || typeof blocker === "string" && blocker.length > 0) status = "waiting";
    else status = "idle_unplanned";
    return { agent, goalIds: owned.map((goal) => goal.id), status, lastHandoffSeq: lastHandoff?.seq ?? null, lastWakeStatus: agentWakes[0]?.status ?? null, nextWakeAt };
  });
}

export function renderDashboard(ledger: Ledger): string {
  const rows = (values: unknown[]) => values.map((value) => `<tr><td><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>goah status</title><style>body{font:14px ui-monospace;margin:32px;background:#101418;color:#dce3e4}section{margin:32px 0}pre{white-space:pre-wrap;border:1px solid #334;padding:12px}</style></head><body><h1>goah</h1><p>seq ${ledger.events().at(-1)?.seq ?? 0}</p><section><h2>Team</h2><table>${rows(deriveTeam(ledger))}</table></section><section><h2>Goals</h2><table>${rows(ledger.goals())}</table></section><section><h2>Wakes</h2><table>${rows(ledger.wakes())}</table></section><section><h2>Actions</h2><table>${rows(ledger.actions())}</table></section><section><h2>Mailbox</h2><table>${rows(ledger.mailbox())}</table></section></body></html>`;
}

async function runConnector<T>(spec: ConnectorProcessSpec, operation: "dispatch" | "query", action: ActionSnapshot): Promise<T> {
  return runJsonProcess<T>(spec, { operation, action });
}

async function runJsonProcess<T>(spec: MetricProcessSpec | ConnectorProcessSpec, input: unknown): Promise<T> {
  const child = spawn(spec.command, spec.args, { detached: process.platform !== "win32", env: minimalEnvironment(spec.env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const timeoutMs = spec.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => { void terminateChild(child, 500); }, timeoutMs);
  const result = await exit;
  clearTimeout(timer);
  if (result.code !== 0) throw new Error(stderr.trim() || `connector exited (${result.code ?? result.signal})`);
  return JSON.parse(stdout.trim()) as T;
}

async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalPid(child.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (child.exitCode === null && child.signalCode === null) signalPid(child.pid, "SIGKILL");
}
function signalPid(pid: number, signal: NodeJS.Signals): void { try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {} }
function minimalEnvironment(explicit: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...explicit };
}
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function interactionMailId(wake: WakeSnapshot): string | null { return wake.triggerRef.startsWith("interaction:") ? wake.triggerRef.slice("interaction:".length) : null; }
function asRecord(value: JsonValue): Record<string, JsonValue> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("RPC params must be an object"); return value; }
function numberArray(value: JsonValue | undefined): number[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) throw new Error("RPC evidence must be a number array"); return value as number[]; }
function asChildGoal(value: JsonValue | undefined): { id: string; objective: string; observationMethod: string; owner: string } {
  const input = asRecord(value ?? null);
  return { id: String(input.id), objective: String(input.objective), observationMethod: String(input.observationMethod), owner: String(input.owner) };
}
function defaultCapabilities(role: AgentRole): AgentCapability[] {
  if (role === "ceo") return ["ledger.search", "mail.send", "schedule.set", "action.submit", "audit.ack", "memory.append", "team.list", "goal.get", "goal.create", "goal.work", "goal.delegate", "goal.reassign", "goal.revise", "goal.pause", "goal.resume", "goal.complete", "human.request", "work_record.list", "work_record.read", "work_record.history", "work_record.search", "work_record.update"];
  if (role === "verifier") return ["ledger.search", "mail.send", "memory.append", "audit.write"];
  if (role === "audit") return ["ledger.search", "mail.send", "memory.append", "audit.write"];
  return ["ledger.search", "mail.send", "schedule.set", "action.submit", "audit.ack", "memory.append", "goal.get", "work_record.list", "work_record.read", "work_record.history", "work_record.search", "work_record.update"];
}

export * from "./verification.js";
export * from "./roles.js";
