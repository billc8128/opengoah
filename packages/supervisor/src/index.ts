import { randomUUID } from "node:crypto";
import {
  goalStream,
  goalAutomaticTarget,
  goalCommitment,
  specialistAutomaticTarget,
  noGoalCommitment,
  type AgentCapability,
  type AgentProfile,
  type AgentRole,
  type Clock,
  type DelegationRequest,
  type DelegationResult,
  type EventRecord,
  type AutomaticTarget,
  type GoalSnapshot,
  type GoalCompletionRequest,
  type GoalPhase,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  normalizeAssistantText,
  type ReassignmentRequest,
  type ReassignmentResult,
  type Runner,
  type RunnerHandle,
  type RunnerLiveEvent,
  type RunnerProfile,
  type ScheduleSnapshot,
  type TeamMemberView,
  type TurnContext,
  type TurnSnapshot,
  type TurnItemSnapshot,
  type TurnLiveSnapshot,
  type TurnOutput,
  type WakeSnapshot,
  type WakeTriggerSnapshot,
  wakeStream,
} from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents, selectWorkingMemory } from "./context-view.js";
import { commitTurnGoalWork, HandoffValidator, type HandoffCommitDeps } from "./handoff.js";
import {
  mailDeliveryAttempt,
  recoveryRef,
  scheduleTurnRecovery,
  type TurnRecoveryDeps,
} from "./recovery.js";
import { dispatchAgentRpc, type AgentRpcDeps } from "./rpc-dispatch.js";
import {
  contextMail,
  goalContext,
  humanContext,
  turnContextForWake,
  type TurnContextDeps,
} from "./turn-context.js";
import { defaultTurnPrompt } from "./roles.js";

export {
  composeActiveContext,
  selectRecoveryEvents,
  type ActiveContextInput,
  type ActiveContextView,
} from "./context-view.js";
export { deriveRecoveryViews, type RecoveryView } from "./recovery.js";

/** Dispatches each wake to the runner selected by its opaque Runner Profile. */
export class RunnerRouter implements Runner {
  readonly isolation = "process" as const;
  readonly #byPid = new Map<number, Runner>();
  constructor(
    readonly runners: ReadonlyMap<string, Runner>,
    readonly fallback = "default",
  ) {}
  prepare(request: Parameters<Runner["prepare"]>[0]): RunnerHandle {
    const context =
      request.context && typeof request.context === "object" && !Array.isArray(request.context)
        ? (request.context as Record<string, unknown>)
        : {};
    const profile =
      context.runnerProfile &&
      typeof context.runnerProfile === "object" &&
      !Array.isArray(context.runnerProfile)
        ? (context.runnerProfile as Record<string, unknown>)
        : {};
    const id = typeof profile.id === "string" ? profile.id : this.fallback;
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`runner profile is not configured: ${id}`);
    const handle = runner.prepare(request);
    if (handle.pid !== null && Number.isInteger(handle.pid) && handle.pid > 0)
      this.#byPid.set(handle.pid, runner);
    void handle.result.then(
      () => {
        if (handle.pid !== null && Number.isInteger(handle.pid) && handle.pid > 0)
          this.#byPid.delete(handle.pid);
      },
      () => {
        if (handle.pid !== null && Number.isInteger(handle.pid) && handle.pid > 0)
          this.#byPid.delete(handle.pid);
      },
    );
    return handle;
  }
  async terminateProcess(pid: number, runnerProfileId?: string): Promise<void> {
    const runner = this.#byPid.get(pid) ?? this.runners.get(runnerProfileId ?? this.fallback);
    if (!runner) return;
    await runner.terminateProcess(pid);
  }
}

export interface SupervisorOptions {
  leaseMs?: number;
  memoryTailChars?: number;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  turnRetryPolicy?: { maxAttempts: number; baseDelayMs: number };
  profiles?: AgentProfile[];
  runnerProfiles?: RunnerProfile[];
}

interface LiveTurnState {
  revision: number;
  messageId: string;
  text: Map<number, string[]>;
  thinking: Map<number, string[]>;
  thinkingActive: boolean;
}

export class Supervisor {
  readonly #leaseMs: number;
  readonly #memoryTailChars: number;
  #claimTail: Promise<void> = Promise.resolve();
  #humanTail: Promise<void> = Promise.resolve();
  readonly #retryPolicy: NonNullable<SupervisorOptions["retryPolicy"]>;
  readonly #turnRetryPolicy: NonNullable<SupervisorOptions["turnRetryPolicy"]>;
  readonly #profiles: Map<string, AgentProfile>;
  readonly #runnerProfiles: Map<string, RunnerProfile>;
  readonly #handles = new Map<string, RunnerHandle>();
  readonly #executions = new Map<string, Promise<void>>();
  readonly #agentExecutions = new Map<string, Promise<void>>();
  readonly #goalExecutionBarriers = new Map<string, Promise<void>>();
  readonly #handoff = new HandoffValidator();
  #contextDeps!: TurnContextDeps;
  #recoveryDeps!: TurnRecoveryDeps;
  #rpcDeps!: AgentRpcDeps;
  #handoffCommitDeps!: HandoffCommitDeps;
  readonly #liveTurns = new Map<string, LiveTurnState>();
  readonly #requestComponents = new Map<string, Map<string, string>>();

  #runner: Runner;
  constructor(
    readonly ledger: Ledger,
    runner: Runner,
    readonly clock: Clock,
    options: SupervisorOptions = {},
  ) {
    this.#runner = runner;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#memoryTailChars = options.memoryTailChars ?? 12_000;
    this.#retryPolicy = options.retryPolicy ?? { maxAttempts: 0, baseDelayMs: 1_000 };
    this.#turnRetryPolicy = options.turnRetryPolicy ?? { maxAttempts: 3, baseDelayMs: 1_000 };
    for (const profile of options.profiles ?? []) {
      if (
        (profile.agent === "ceo" && profile.role !== "ceo") ||
        (profile.agent !== "ceo" && profile.role === "ceo")
      )
        throw new Error("exactly the ceo Agent must use the ceo role");
    }
    this.#profiles = new Map([
      ["ceo", { agent: "ceo", role: "ceo" } satisfies AgentProfile],
      ...(options.profiles ?? []).map((profile) => [profile.agent, profile] as const),
    ]);
    for (const thread of this.ledger.threads()) {
      const configured =
        this.#profiles.get(thread.agent)?.role ?? (thread.agent === "ceo" ? "ceo" : "child");
      if (configured !== thread.role)
        throw new Error(
          `Agent ${thread.agent} role conflicts with persisted Thread role ${thread.role}`,
        );
    }
    for (const goal of this.ledger.goals().filter((candidate) => candidate.phase !== "complete")) {
      if (!this.#validGoalOwner(goal.owner, goal))
        throw new Error(
          `Agent ${goal.owner} role conflicts with persisted ${goal.parentId === null ? "Root" : "Child"} Goal ${goal.id}`,
        );
    }
    this.#runnerProfiles = new Map(
      (options.runnerProfiles ?? []).map((profile) => [profile.id, profile] as const),
    );
    this.#contextDeps = {
      ledger,
      profiles: this.#profiles,
      runnerProfiles: this.#runnerProfiles,
      memoryTailChars: this.#memoryTailChars,
      role: (agent) => this.#role(agent),
      goal: (id) => this.#goal(id),
      currentRoot: () => this.currentRoot(),
      teamList: () => this.teamList(),
    };
    this.#recoveryDeps = {
      ledger,
      clock,
      now: () => this.#now(),
      role: (agent) => this.#role(agent),
      retryPolicy: this.#retryPolicy,
      enqueueTrigger: (agent, triggerRef, target) =>
        this.#enqueueTrigger(agent, triggerRef, target),
    };
    this.#handoffCommitDeps = {
      ledger,
      now: () => this.#now(),
      goal: (id) => this.#goal(id),
      validator: this.#handoff,
    };
    this.#rpcDeps = {
      ledger,
      now: () => this.#now(),
      profiles: this.#profiles,
      handoff: this.#handoff,
      role: (agent) => this.#role(agent),
      goal: (id) => this.#goal(id),
      validGoalOwner: (agent, goal) => this.#validGoalOwner(agent, goal),
      knownAgent: (agent) => this.#knownAgent(agent),
      teamList: () => this.teamList(),
      createRootGoal: (objective, id, sourceTurnId) =>
        this.createRootGoal(objective, id, sourceTurnId),
      delegate: (request, actor, wakeId) => this.delegate(request, actor, wakeId),
      reassignGoal: (request, actor, wakeId) => this.reassignGoal(request, actor, wakeId),
      reviseChildGoal: (
        id,
        objective,
        observationMethod,
        verificationMethod,
        actor,
        reason,
        evidence,
        wakeId,
        sourceTurnId,
      ) =>
        this.reviseChildGoal(
          id,
          objective,
          observationMethod,
          verificationMethod,
          actor,
          reason,
          evidence,
          wakeId,
          sourceTurnId,
        ),
      transitionGoal: (id, phase, actor, scheduleMotion, sourceTurnId) =>
        this.transitionGoal(id, phase, actor, scheduleMotion, sourceTurnId),
      completeGoal: (request, actor, wakeId) => this.completeGoal(request, actor, wakeId),
      planWake: (agent, at, reason, setBy, target) =>
        this.planWake(agent, at, reason, setBy, target),
    };
  }

  /**
   * Hot-swap the runner after a config reload. Refused while a Turn is active:
   * a live child must never observe its runner vanish mid-flight.
   * The next Turn uses the new runner, and spawn-time env
   * resolution applies the new credentials to the next spawn.
   */
  swapRunner(runner: Runner, profiles?: RunnerProfile[]): void {
    const active = this.ledger.turns().filter((turn) => turn.status === "in_progress");
    if (active.length > 0) throw new Error("cannot swap runner while a Turn is in progress");
    this.#runner = runner;
    if (profiles) {
      this.#runnerProfiles.clear();
      for (const profile of profiles) this.#runnerProfiles.set(profile.id, profile);
    }
  }
  get runner(): Runner {
    return this.#runner;
  }
  createGoal(goal: GoalSnapshot, actor = "human"): void {
    if (!this.#validGoalOwner(goal.owner, goal))
      throw new Error("Goal owner role does not match Root/Child position");
    if (
      goal.parentId === null &&
      this.ledger
        .goals()
        .some(
          (candidate) =>
            candidate.id !== goal.id &&
            candidate.parentId === null &&
            candidate.phase !== "complete",
        )
    )
      throw new Error("CEO already has an unfinished Root Goal");
    this.ledger.putGoal(goal, actor);
  }
  createRootGoal(
    objective: string,
    id: string = randomUUID(),
    sourceTurnId?: string,
  ): GoalSnapshot {
    if (!objective.trim()) throw new Error("root objective is required");
    if (
      this.ledger
        .goals()
        .some((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase !== "complete")
    )
      throw new Error("CEO already has an unfinished Root Goal; use work_on_goal");
    const goal: GoalSnapshot = {
      id,
      parentId: null,
      objective,
      observationMethod: null,
      verificationMethod: null,
      owner: "ceo",
      phase: "active",
      revision: 0,
    };
    this.ledger.putGoal(goal, "human", undefined, {
      operation: "create",
      reason: "Human established a durable Root Goal",
      evidence: [],
      authority: { kind: "human" },
      ...(sourceTurnId ? { sourceTurnId } : {}),
    });
    return this.#goal(id);
  }
  startGoal(
    objective: string,
    id: string = randomUUID(),
  ): { goal: GoalSnapshot; wake: WakeSnapshot } {
    const goal = this.createRootGoal(objective, id);
    const wake = this.#enqueueTrigger("ceo", `root:${id}:created`, { goalId: goal.id });
    if (!wake) throw new Error("CEO wake was not admitted for an active root goal");
    return { goal, wake };
  }

  threadFor(agent = "ceo"): import("goah-ledger-contract").ThreadSnapshot {
    const parentThreadId = agent === "ceo" ? null : this.threadFor("ceo").id;
    const role = this.#role(agent);
    const existing = this.ledger
      .threads()
      .find((thread) => thread.agent === agent && thread.parentThreadId === parentThreadId);
    if (existing) {
      if (existing.role !== role)
        throw new Error(`Agent ${agent} role changed from ${existing.role} to ${role}`);
      return existing;
    }
    const now = this.#now();
    const thread = {
      id: randomUUID(),
      agent,
      role,
      parentThreadId,
      createdAt: now,
      updatedAt: now,
    };
    this.ledger.putThread(thread, "supervisor");
    return thread;
  }

  async startHumanTurn(
    message: string,
  ): Promise<{ threadId: string; turnId: string; steered: boolean }> {
    const previous = this.#humanTail;
    let release!: () => void;
    this.#humanTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#startHumanTurn(message);
    } finally {
      release();
    }
  }
  async startHumanGoalTurn(
    objective: string,
    id: string = randomUUID(),
  ): Promise<{ threadId: string; turnId: string; steered: false; goal: GoalSnapshot }> {
    if (!objective.trim()) throw new Error("root objective is required");
    const previous = this.#humanTail;
    let release!: () => void;
    this.#humanTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const goal: GoalSnapshot = {
        id,
        parentId: null,
        objective,
        observationMethod: null,
        verificationMethod: null,
        owner: "ceo",
        phase: "active",
        revision: 0,
      };
      const accepted = await this.#startHumanTurn(`/goal ${objective}`, goal);
      return { ...accepted, steered: false, goal: this.#goal(id) };
    } finally {
      release();
    }
  }
  async #startHumanTurn(
    message: string,
    newRoot: GoalSnapshot | null = null,
  ): Promise<{ threadId: string; turnId: string; steered: boolean }> {
    if (!message.trim()) throw new Error("message is required");
    const existingThread = this.ledger.threads().find((candidate) => candidate.agent === "ceo");
    const now = this.#now();
    const thread = existingThread
      ? { ...existingThread, updatedAt: now }
      : {
          id: randomUUID(),
          agent: "ceo",
          role: "ceo" as const,
          parentThreadId: null,
          createdAt: now,
          updatedAt: now,
        };
    const active = existingThread ? this.ledger.activeTurn(existingThread.id) : null;
    if (active) {
      if (active.triggerKind === "user_message" && !newRoot) {
        const handle = this.#handles.get(active.id);
        if (handle?.steer) {
          const item = this.#appendTurnItem(
            active.id,
            "user_message",
            { text: message },
            "human",
            randomUUID(),
            "in_progress",
          );
          try {
            await handle.steer(message);
            const stored = this.ledger
              .turnItems(active.id)
              .find((candidate) => candidate.id === item.id);
            if (
              this.ledger.turn(active.id)?.status === "in_progress" &&
              stored?.status === "in_progress"
            ) {
              this.ledger.putTurnItem(
                { ...stored, status: "completed", completedAt: this.#now() },
                "human",
              );
              return { threadId: thread.id, turnId: active.id, steered: true };
            }
          } catch {
            const stored = this.ledger
              .turnItems(active.id)
              .find((candidate) => candidate.id === item.id);
            if (
              this.ledger.turn(active.id)?.status === "in_progress" &&
              stored?.status === "in_progress"
            )
              this.ledger.putTurnItem(
                { ...stored, status: "failed", completedAt: this.#now() },
                "human",
              );
          }
        } else if (!handle) {
          this.#appendTurnItem(active.id, "user_message", { text: message }, "human");
          return { threadId: thread.id, turnId: active.id, steered: true };
        }
      }
    }
    const replacement = this.ledger.activeTurn(thread.id);
    const turnStartedAt = this.#now();
    const turn: TurnSnapshot = {
      id: randomUUID(),
      threadId: thread.id,
      triggerKind: "user_message",
      ...(newRoot ? goalCommitment(newRoot.id, newRoot.revision) : noGoalCommitment()),
      status: "in_progress",
      attempt: 1,
      error: null,
      startedAt: turnStartedAt,
      endedAt: null,
      leaseUntil: new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(),
      leaseToken: randomUUID(),
      runnerPid: null,
      runnerProfileId: this.#runnerProfileId("ceo"),
    };
    const messageItem: TurnItemSnapshot = {
      id: randomUUID(),
      turnId: turn.id,
      ordinal: 1,
      type: "user_message",
      status: "completed",
      data: { text: message },
      createdAt: turnStartedAt,
      completedAt: turnStartedAt,
    };
    const admitted = this.ledger.admitHumanTurn({
      thread: { ...thread, updatedAt: turnStartedAt },
      turn,
      messageItem,
      replaceTurnId: replacement?.id ?? null,
      ...(newRoot ? { rootGoal: newRoot } : {}),
    });
    const interruptedGoalId = replacement?.triggerKind === "wake" ? replacement.goalId : null;
    if (interruptedGoalId) {
      const goal = this.ledger.goal(interruptedGoalId);
      if (goal?.phase === "active")
        this.#enqueueTrigger(goal.owner, `human-interrupted:${replacement!.id}`, {
          goalId: goal.id,
        });
    }
    const context: TurnContext = {
      trigger: { kind: "user_message" },
      activeGoal: newRoot ?? this.currentRoot(),
      goalCommitment: newRoot ? { goalId: newRoot.id, goalRevision: newRoot.revision } : null,
    };
    const deliveredMail = contextMail(this.#contextDeps, "ceo", newRoot?.id ?? null);
    const recordRevisionAtStart = newRoot
      ? (this.ledger.workRecord(newRoot.id)?.recordRevision ?? -1)
      : -1;
    await this.#activateAdmittedHumanTurn(
      admitted.turn,
      admitted.replacedTurn,
      context,
      deliveredMail,
      recordRevisionAtStart,
    );
    return { threadId: thread.id, turnId: turn.id, steered: false };
  }

  async interruptTurn(turnId: string): Promise<TurnSnapshot> {
    return this.#interruptTurn(turnId, "interrupted by Human", "human");
  }
  async #interruptTurn(turnId: string, reason: string, actor: string): Promise<TurnSnapshot> {
    const turn = this.ledger.turn(turnId);
    if (!turn || turn.status !== "in_progress") throw new Error("active Turn not found");
    this.#liveTurns.delete(turn.id);
    this.#handoff.clear(turn.id);
    this.ledger.finishTurn(turn.id, "interrupted", { message: reason }, this.#now(), actor);
    await this.#cleanupTerminalTurn(turn);
    return this.ledger.turn(turn.id)!;
  }

  async #executeTurn(
    initial: TurnSnapshot,
    agent: string,
    turnContext: TurnContext,
    contextFactory: () => JsonValue,
    sourceWake: WakeSnapshot | null = null,
    deliveredMailIds: string[] = [],
    recordRevisionAtStart = -1,
    sourceWakeTriggers: WakeTriggerSnapshot[] = [],
  ): Promise<void> {
    while (this.ledger.turn(initial.id)?.status === "in_progress") {
      const execution = this.ledger.turn(initial.id)!;
      const leaseToken = execution.leaseToken!;
      let handle: RunnerHandle | null = null;
      let renewal: NodeJS.Timeout | null = null;
      let processClean = true;
      try {
        handle = this.runner.prepare({
          agent,
          execution,
          ...(sourceWake ? { sourceWake, sourceWakeTriggers } : {}),
          turn: turnContext,
          context: contextFactory(),
          now: () => this.#now(),
          emit: (trace) =>
            this.#recordTurnTrace(initial.id, leaseToken, trace.type, trace.data, agent),
          emitLive: (trace) => this.#recordLiveTrace(initial.id, leaseToken, trace),
          rpc: (method, params) =>
            dispatchAgentRpc(
              this.#rpcDeps,
              initial.id,
              agent,
              turnContext,
              method,
              params,
              sourceWake?.id,
            ),
        });
        this.#handles.set(initial.id, handle);
        if (handle.pid) this.ledger.attachTurnProcess(initial.id, leaseToken, handle.pid);
        renewal = setInterval(
          () => {
            try {
              this.ledger.renewTurnLease(
                initial.id,
                leaseToken,
                new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(),
                this.#now(),
              );
            } catch {
              void this.#terminateHandle(initial.id, handle!);
            }
          },
          Math.max(25, Math.floor(this.#leaseMs / 3)),
        );
        renewal.unref();
        handle.begin();
        const result = await handle.result;
        if (renewal) clearInterval(renewal);
        renewal = null;
        processClean = await this.#terminateHandle(initial.id, handle);
        this.#handles.delete(initial.id);
        if (!processClean) throw new Error("Runner process cleanup did not complete");
        const attached = this.ledger.turn(initial.id);
        if (attached?.status === "in_progress" && attached.runnerPid !== null)
          this.ledger.releaseTurnProcess(initial.id, "supervisor");
        const current = this.ledger.turn(initial.id);
        if (!current || current.status !== "in_progress") return;
        if (current.attempt > 1)
          this.ledger.appendEvent({
            streamId: `turn:${current.id}`,
            ts: this.#now(),
            actor: "supervisor",
            type: "turn.retry_finished",
            data: { attempt: current.attempt, outcome: result.outcome },
            ignorable: true,
          });
        if (result.outcome !== "abnormal") this.#closeStreamingItems(current.id);
        if (result.outcome === "abnormal") {
          if (current.attempt < this.#turnRetryPolicy.maxAttempts) {
            this.ledger.repairTurnAttempt(current.id, result.reason, this.#now(), "supervisor");
            this.ledger.appendEvent({
              streamId: `turn:${current.id}`,
              ts: this.#now(),
              actor: "supervisor",
              type: "turn.retry_started",
              data: { attempt: current.attempt + 1, reason: result.reason },
              ignorable: true,
            });
            this.ledger.putTurn(
              {
                ...current,
                attempt: current.attempt + 1,
                leaseUntil: new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(),
                runnerPid: null,
              },
              "supervisor",
            );
            await new Promise((resolve) =>
              setTimeout(resolve, this.#turnRetryPolicy.baseDelayMs * 2 ** (current.attempt - 1)),
            );
            continue;
          }
          this.#failTurn(current.id, result.reason);
          scheduleTurnRecovery(
            this.#recoveryDeps,
            sourceWake,
            sourceWakeTriggers,
            current.id,
            agent,
          );
          return;
        }
        const responseItem = this.#finalAssistantItem(current.id, result.finalMessageId);
        if (turnContext.goalCommitment) {
          if (!result.handoff) throw new Error("committed Turn requires Handoff");
          commitTurnGoalWork(
            this.#handoffCommitDeps,
            current.id,
            agent,
            turnContext,
            responseItem,
            result.handoff,
            sourceWake?.id ?? null,
            deliveredMailIds,
            recordRevisionAtStart,
          );
          return;
        }
        if (result.handoff) throw new Error("uncommitted Turn cannot finish with Handoff");
        if (this.#assistantCommitState(current.id, responseItem.id) !== "committed")
          throw new Error("uncommitted Turn requires a committed assistant trace");
        this.ledger.commitTurnResponse(
          current.id,
          responseItem.id,
          this.#now(),
          "supervisor",
          deliveredMailIds,
        );
        return;
      } catch (error) {
        if (renewal) clearInterval(renewal);
        if (handle && processClean) processClean = await this.#terminateHandle(initial.id, handle);
        this.#handles.delete(initial.id);
        let current = this.ledger.turn(initial.id);
        if (processClean && current?.status === "in_progress" && current.runnerPid !== null) {
          this.ledger.releaseTurnProcess(initial.id, "supervisor");
          current = this.ledger.turn(initial.id);
        }
        if (current?.status === "in_progress") {
          this.#failTurn(current.id, error instanceof Error ? error.message : String(error));
          scheduleTurnRecovery(
            this.#recoveryDeps,
            sourceWake,
            sourceWakeTriggers,
            current.id,
            agent,
          );
        }
        return;
      }
    }
  }
  #trackExecution(
    initial: TurnSnapshot,
    agent: string,
    turnContext: TurnContext,
    contextFactory: () => JsonValue,
    sourceWake: WakeSnapshot | null = null,
    deliveredMailIds: string[] = [],
    recordRevisionAtStart = -1,
    sourceWakeTriggers: WakeTriggerSnapshot[] = [],
  ): Promise<void> {
    const running = this.#executeTurn(
      initial,
      agent,
      turnContext,
      contextFactory,
      sourceWake,
      deliveredMailIds,
      recordRevisionAtStart,
      sourceWakeTriggers,
    );
    this.#executions.set(initial.id, running);
    this.#agentExecutions.set(agent, running);
    void running.finally(() => {
      if (this.#executions.get(initial.id) === running) this.#executions.delete(initial.id);
      if (this.#agentExecutions.get(agent) === running) this.#agentExecutions.delete(agent);
      this.#requestComponents.delete(initial.id);
    });
    return running;
  }
  async #activateAdmittedHumanTurn(
    turn: TurnSnapshot,
    replaced: TurnSnapshot | null,
    context: TurnContext,
    mail: MailSnapshot[],
    recordRevisionAtStart: number,
  ): Promise<void> {
    if (replaced) {
      this.#handoff.clear(replaced.id);
      if (!(await this.#cleanupTerminalTurn(replaced))) {
        this.#failTurn(turn.id, "previous Runner cleanup did not complete");
        scheduleTurnRecovery(this.#recoveryDeps, null, [], turn.id, "ceo");
        return;
      }
    } else await this.#awaitAgentExecution("ceo");
    for (const fence of this.ledger
      .turns(turn.threadId)
      .filter((candidate) => candidate.status !== "in_progress" && candidate.runnerPid !== null)) {
      if (!(await this.#cleanupTerminalTurn(fence))) {
        this.#failTurn(turn.id, "previous Runner cleanup did not complete");
        scheduleTurnRecovery(this.#recoveryDeps, null, [], turn.id, "ceo");
        return;
      }
    }
    const current = this.ledger.turn(turn.id);
    if (current?.status !== "in_progress") return;
    const activated = {
      ...current,
      leaseUntil: new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(),
    };
    this.ledger.putTurn(activated, "supervisor");
    this.#trackExecution(
      activated,
      "ceo",
      context,
      () => humanContext(this.#contextDeps, turn.id, "ceo", mail),
      null,
      mail.map((item) => item.id),
      recordRevisionAtStart,
    );
  }
  async #cleanupTerminalTurn(turn: TurnSnapshot): Promise<boolean> {
    const handle = this.#handles.get(turn.id);
    let cleaned = true;
    try {
      if (handle) cleaned = await this.#terminateHandle(turn.id, handle);
      else if (turn.runnerPid)
        await this.runner.terminateProcess(turn.runnerPid, turn.runnerProfileId);
    } catch (error) {
      this.#recordCleanupFailure(turn.id, error);
      cleaned = false;
    } finally {
      this.#handles.delete(turn.id);
    }
    if (!cleaned) return false;
    await this.#executions.get(turn.id);
    const stored = this.ledger.turn(turn.id);
    if (stored && stored.status !== "in_progress" && stored.runnerPid !== null) {
      try {
        this.ledger.releaseTurnProcess(turn.id, "supervisor");
      } catch (error) {
        this.#recordCleanupFailure(turn.id, error);
        return false;
      }
    }
    return true;
  }
  async #awaitAgentExecution(agent: string): Promise<void> {
    const running = this.#agentExecutions.get(agent);
    if (running) await running;
  }

  #threadAgent(threadId: string): string {
    const thread = this.ledger.thread(threadId);
    if (!thread) throw new Error("Turn Thread not found");
    return thread.agent;
  }

  #assistantMessageEvent(turnId: string, messageItemId: string): EventRecord | undefined {
    return this.ledger.readStream(`turn:${turnId}`).findLast((candidate) => {
      if (
        candidate.type !== "message.assistant.completed" ||
        !candidate.data ||
        typeof candidate.data !== "object" ||
        Array.isArray(candidate.data)
      )
        return false;
      const message = (candidate.data as { message?: { id?: unknown } }).message;
      return message?.id === messageItemId;
    });
  }
  #assistantCommitState(turnId: string, messageItemId: string): "committed" | "provisional" | null {
    const event = this.#assistantMessageEvent(turnId, messageItemId);
    if (!event || !event.data || typeof event.data !== "object" || Array.isArray(event.data))
      return null;
    const state = (event.data as { commitState?: unknown }).commitState;
    return state === "committed" || state === "provisional" ? state : null;
  }
  #finalAssistantItem(turnId: string, messageItemId: string): TurnItemSnapshot {
    const id = messageItemId.trim();
    const item = id
      ? this.ledger.turnItems(turnId).find((candidate) => candidate.id === id)
      : undefined;
    const text =
      item && item.type === "assistant_message" && item.status === "completed"
        ? normalizeAssistantText(String((item.data as { text?: unknown }).text ?? ""))
        : "";
    const event = id ? this.#assistantMessageEvent(turnId, id) : undefined;
    const turn = this.ledger.turn(turnId);
    const retryStart =
      turn && turn.attempt > 1
        ? this.ledger
            .readStream(`turn:${turnId}`)
            .findLast(
              (candidate) =>
                candidate.type === "turn.retry_started" &&
                (candidate.data as { attempt?: unknown }).attempt === turn.attempt,
            )
        : undefined;
    if (!item || !text || !event || (retryStart && event.seq <= retryStart.seq))
      throw new Error(
        "completed Turn finalMessageId must reference a readable Assistant Item from the current attempt",
      );
    return item;
  }

  #failTurn(turnId: string, reason: string): void {
    const current = this.ledger.turn(turnId);
    if (!current || current.status !== "in_progress") return;
    this.#liveTurns.delete(turnId);
    this.#handoff.clear(turnId);
    this.ledger.finishTurn(turnId, "failed", { message: reason }, this.#now(), "supervisor");
  }
  #preemptGoalTurn(goalId: string, reason: string): void {
    const turn = this.ledger
      .turns()
      .find((candidate) => candidate.status === "in_progress" && candidate.goalId === goalId);
    if (!turn) return;
    this.#liveTurns.delete(turn.id);
    this.#handoff.clear(turn.id);
    this.ledger.finishTurn(turn.id, "interrupted", { message: reason }, this.#now(), "supervisor");
    void this.#cleanupTerminalTurn(turn);
  }
  async #terminateHandle(turnId: string, handle: RunnerHandle): Promise<boolean> {
    try {
      await handle.terminate();
      return true;
    } catch (error) {
      this.#recordCleanupFailure(turnId, error);
      const turn = this.ledger.turn(turnId);
      const persistedPid = turn?.runnerPid;
      if (persistedPid === null || persistedPid === undefined) return handle.pid === null;
      try {
        await this.runner.terminateProcess(persistedPid, turn?.runnerProfileId);
        return true;
      } catch (fallback) {
        this.#recordCleanupFailure(turnId, fallback);
        return false;
      }
    }
  }
  #recordCleanupFailure(turnId: string, error: unknown): void {
    this.ledger.appendEvent({
      streamId: `turn:${turnId}`,
      ts: this.#now(),
      actor: "supervisor",
      type: "runner.cleanup_failed",
      data: { message: error instanceof Error ? error.message : String(error) },
      ignorable: true,
    });
  }

  #closeStreamingItems(turnId: string): void {
    const open = this.ledger.turnItems(turnId).filter((item) => item.status === "in_progress");
    if (open.some((item) => item.type === "tool_call" || item.type === "user_message"))
      throw new Error("Runner returned while an input or tool call was still open");
    for (const item of open)
      this.ledger.putTurnItem(
        { ...item, status: "completed", completedAt: this.#now() },
        "supervisor",
      );
  }

  #appendTurnItem(
    turnId: string,
    type: TurnItemSnapshot["type"],
    data: JsonValue,
    actor: string,
    id: string = randomUUID(),
    status: TurnItemSnapshot["status"] = "completed",
  ): TurnItemSnapshot {
    const now = this.#now();
    const item: TurnItemSnapshot = {
      id,
      turnId,
      ordinal: this.ledger.turnItems(turnId).length + 1,
      type,
      status,
      data,
      createdAt: now,
      completedAt: status === "in_progress" ? null : now,
    };
    this.ledger.putTurnItem(item, actor);
    return item;
  }

  #recordTurnTrace(
    turnId: string,
    leaseToken: string,
    type: string,
    data: JsonValue,
    actor = "ceo",
  ): void {
    let componentToRecord: {
      components: Map<string, string>;
      hash: string;
      encoded: string;
    } | null = null;
    if (type === "message.assistant.delta") {
      this.#recordLiveTrace(turnId, leaseToken, { type, data: data as RunnerLiveEvent["data"] });
      return;
    }
    if (type === "transcript.completed" || type === "transcript.interrupted") return;
    if (
      type === "transcript.started" &&
      this.ledger.readStream(`turn:${turnId}`).some((event) => event.type === "transcript.started")
    )
      return;
    if (type === "request.component") {
      const hash =
        data && typeof data === "object" && !Array.isArray(data)
          ? String((data as { hash?: unknown }).hash ?? "")
          : "";
      if (!hash) throw new Error("request component is missing a hash");
      let components = this.#requestComponents.get(turnId);
      if (!components) {
        components = new Map(
          this.ledger
            .readStream(`turn:${turnId}`)
            .filter((event) => event.type === "request.component")
            .map((event) => [
              String((event.data as { hash?: unknown }).hash ?? ""),
              JSON.stringify(event.data),
            ]),
        );
        this.#requestComponents.set(turnId, components);
      }
      const encoded = JSON.stringify(data);
      const existing = components.get(hash);
      if (existing) {
        if (existing !== encoded) throw new Error(`request component hash collision: ${hash}`);
        return;
      }
      componentToRecord = { components, hash, encoded };
    }
    if (type === "message.assistant.completed") {
      const value =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as { commitState?: unknown })
          : {};
      if (!["committed", "provisional"].includes(String(value.commitState)))
        throw new Error("Runner assistant completion is missing normalized commit state");
      if (value.commitState === "provisional" && this.ledger.turn(turnId)?.goalId === null)
        throw new Error("uncommitted Turn cannot emit a provisional assistant response");
    }
    this.ledger.appendTurnEvent(
      { streamId: `turn:${turnId}`, ts: this.#now(), actor, type, data },
      leaseToken,
    );
    if (componentToRecord)
      componentToRecord.components.set(componentToRecord.hash, componentToRecord.encoded);
    if (type === "message.assistant.completed") {
      this.#liveTurns.delete(turnId);
      const value = data as { message?: { id?: unknown; content?: unknown } };
      const text = messageTextContent(value.message?.content);
      const reasoning = messageReasoningContent(value.message?.content);
      const id = typeof value.message?.id === "string" ? value.message.id.trim() : "";
      if ((text || reasoning) && !id)
        throw new Error("Runner assistant completion is missing a message Item id");
      if (reasoning)
        this.#appendTurnItem(turnId, "reasoning", { text: reasoning }, actor, `${id}:reasoning`);
      if (text) this.#appendTurnItem(turnId, "assistant_message", { text }, actor, id);
    } else if (type === "plan.updated") this.#appendTurnItem(turnId, "plan", data, actor);
    else if (type === "tool.called") {
      const input = data as { callId?: unknown; name?: unknown; arguments?: JsonValue };
      const turn = this.ledger.turn(turnId)!;
      const id = `${turnId}:attempt:${turn.attempt}:tool:${String(input.callId)}`;
      if (this.ledger.turnItems(turnId).some((item) => item.id === id))
        throw new Error("duplicate tool call id in Turn attempt");
      this.#appendTurnItem(
        turnId,
        "tool_call",
        {
          callId: String(input.callId),
          tool: String(input.name),
          arguments: input.arguments ?? null,
        },
        actor,
        id,
        "in_progress",
      );
    } else if (type === "tool.completed") {
      const input = data as { callId?: unknown; result?: JsonValue; isError?: unknown };
      const turn = this.ledger.turn(turnId)!;
      const id = `${turnId}:attempt:${turn.attempt}:tool:${String(input.callId)}`;
      const existing = this.ledger.turnItems(turnId).find((item) => item.id === id);
      if (!existing) throw new Error("tool result has no matching call in Turn attempt");
      this.ledger.putTurnItem(
        { ...existing, status: input.isError ? "failed" : "completed", completedAt: this.#now() },
        actor,
      );
      this.#appendTurnItem(
        turnId,
        "tool_result",
        { callId: String(input.callId), result: input.result ?? null },
        actor,
      );
    }
  }
  #recordLiveTrace(turnId: string, leaseToken: string, event: RunnerLiveEvent): void {
    const turn = this.ledger.turn(turnId);
    if (!turn || turn.status !== "in_progress" || turn.leaseToken !== leaseToken) return;
    const input = event.data;
    const delta = input.delta;
    let state = this.#liveTurns.get(turnId);
    if (!state || state.messageId !== input.messageId || delta.type === "start") {
      state = {
        revision: 0,
        messageId: input.messageId,
        text: new Map(),
        thinking: new Map(),
        thinkingActive: false,
      };
      this.#liveTurns.set(turnId, state);
    }
    const index = delta.contentIndex ?? 0;
    if (delta.type === "text_start") state.text.set(index, []);
    else if (delta.type === "text_delta") appendLiveChunk(state.text, index, delta.delta);
    else if (delta.type === "thinking_start") {
      state.thinking.set(index, []);
      state.thinkingActive = true;
    } else if (delta.type === "thinking_delta") appendLiveChunk(state.thinking, index, delta.delta);
    else if (delta.type === "thinking_end") state.thinkingActive = false;
    state.revision += 1;
  }
  liveTurnSnapshot(turnId: string, afterRevision = 0): TurnLiveSnapshot | null {
    const state = this.#liveTurns.get(turnId);
    if (!state || state.revision <= afterRevision) return null;
    return {
      revision: state.revision,
      messageId: state.messageId,
      text: joinLiveChunks(state.text),
      thinking: joinLiveChunks(state.thinking),
      thinkingActive: state.thinkingActive,
    };
  }
  async sendToCeo(
    body: JsonValue,
  ): Promise<{ threadId: string; turnId: string; steered: boolean }> {
    const value =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { message?: unknown })
        : {};
    const message = String(value.message ?? "").trim();
    if (!message) throw new Error("CEO message is required");
    const accepted = await this.startHumanTurn(message);
    await this.waitForTurn(accepted.turnId);
    return accepted;
  }
  async waitForTurn(turnId: string): Promise<void> {
    await this.#executions.get(turnId);
  }
  delegate(request: DelegationRequest, actor = "ceo", wakeId?: string): DelegationResult {
    const candidate: GoalSnapshot = {
      ...request.childGoal,
      parentId: request.parentGoalId,
      phase: "active",
      revision: 0,
    };
    if (!this.#validGoalOwner(candidate.owner, candidate))
      throw new Error("Child Goal owner must use a Child Agent profile");
    return this.ledger.commitDelegation(request, actor, wakeId);
  }
  async reassignGoal(
    request: ReassignmentRequest,
    actor = "ceo",
    wakeId?: string,
  ): Promise<ReassignmentResult> {
    const goal = this.#goal(request.goalId);
    if (!this.#validGoalOwner(request.newOwner, { ...goal, owner: request.newOwner }))
      throw new Error("Child Goal owner must use a Child Agent profile");
    const thread = this.ledger.threads().find((candidate) => candidate.agent === goal.owner);
    const active = thread ? this.ledger.activeTurn(thread.id) : null;
    const gate = active ? Promise.withResolvers<void>() : null;
    if (gate) this.#goalExecutionBarriers.set(goal.id, gate.promise);
    try {
      const result = this.ledger.commitReassignment(request, actor, wakeId);
      if (active?.goalId === goal.id && this.ledger.turn(active.id)?.status === "in_progress")
        await this.#interruptTurn(active.id, "Goal reassigned to another Agent", "supervisor");
      return result;
    } finally {
      gate?.resolve();
      if (gate && this.#goalExecutionBarriers.get(goal.id) === gate.promise)
        this.#goalExecutionBarriers.delete(goal.id);
    }
  }
  teamList(now = this.#now()): TeamMemberView[] {
    return deriveTeam(this.ledger, now);
  }
  currentRoot(): GoalSnapshot | null {
    return (
      this.ledger
        .goals()
        .find(
          (goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase !== "complete",
        ) ?? null
    );
  }
  agentRole(agent: string): AgentRole {
    return this.#role(agent);
  }
  updateGoal(
    id: string,
    patch: Partial<Pick<GoalSnapshot, "objective" | "observationMethod" | "verificationMethod">>,
    actor = "human",
    change?: { reason: string; evidence: number[]; sourceTurnId?: string; sourceWakeId?: string },
  ): GoalSnapshot {
    if (
      patch.objective === undefined &&
      patch.observationMethod === undefined &&
      patch.verificationMethod === undefined
    )
      throw new Error("goal update requires objective, observation method, or verification method");
    const current = this.#goal(id);
    this.#assertGoalMutationAuthority(current, actor);
    if (
      patch.objective !== undefined &&
      patch.objective !== current.objective &&
      current.parentId !== null &&
      (patch.observationMethod === undefined || patch.verificationMethod === undefined)
    )
      throw new Error(
        "child objective revision requires replacement observation and verification methods",
      );
    const next = {
      ...current,
      ...patch,
      ...(patch.objective !== undefined &&
      patch.objective !== current.objective &&
      current.parentId === null &&
      patch.observationMethod === undefined
        ? { observationMethod: null }
        : {}),
      ...(patch.objective !== undefined &&
      patch.objective !== current.objective &&
      current.parentId === null &&
      patch.verificationMethod === undefined
        ? { verificationMethod: null }
        : {}),
      revision: current.revision + 1,
    };
    this.ledger.putGoal(next, actor, change?.sourceWakeId, {
      operation: "revise",
      reason: change?.reason ?? "Goal definition revised",
      evidence: change?.evidence ?? [],
      ...(change?.sourceTurnId ? { sourceTurnId: change.sourceTurnId } : {}),
      ...(change?.sourceWakeId ? { sourceWakeId: change.sourceWakeId } : {}),
    });
    this.#preemptGoalTurn(current.id, "Goal definition changed");
    if (next.parentId === null && next.owner === "ceo" && actor === "human")
      this.#enqueueTrigger("ceo", `root:${id}:revised:${next.revision}`, { goalId: next.id });
    return next;
  }
  confirmObservationMethod(id: string, observationMethod: string): GoalSnapshot {
    const current = this.#goal(id);
    if (current.parentId !== null)
      throw new Error("human confirmation applies only to a root goal");
    return this.updateGoal(
      id,
      { observationMethod, verificationMethod: observationMethod },
      "human",
      { reason: "Human confirmed the Root observation and verification method", evidence: [] },
    );
  }
  reviseChildGoal(
    id: string,
    objective: string,
    observationMethod: string,
    verificationMethod: string,
    actor: string,
    reason: string,
    evidence: number[],
    wakeId?: string,
    sourceTurnId?: string,
  ): GoalSnapshot {
    const current = this.#goal(id);
    if (current.parentId === null) throw new Error("CEO cannot revise a root goal");
    if (!reason.trim()) throw new Error("goal revision reason is required");
    for (const seq of evidence)
      if (!this.ledger.eventsSince(seq - 1).some((event) => event.seq === seq))
        throw new Error(`evidence event does not exist: ${seq}`);
    this.ledger.appendEvent({
      streamId: wakeId ? wakeStream(wakeId) : goalStream(id),
      ts: this.#now(),
      actor,
      type: "goal.revision_requested",
      data: {
        goalId: id,
        fromRevision: current.revision,
        objective,
        observationMethod,
        verificationMethod,
        reason,
        evidence,
      },
    });
    return this.updateGoal(id, { objective, observationMethod, verificationMethod }, actor, {
      reason,
      evidence,
      ...(wakeId ? { sourceWakeId: wakeId } : {}),
      ...(sourceTurnId ? { sourceTurnId } : {}),
    });
  }
  completeGoal(request: GoalCompletionRequest, actor = "human", wakeId?: string): GoalSnapshot {
    const goal = this.ledger.completeGoal(request, actor, wakeId);
    this.#preemptGoalTurn(goal.id, "Goal completed");
    return goal;
  }
  transitionGoal(
    id: string,
    phase: GoalPhase,
    actor = "human",
    scheduleMotion = true,
    sourceTurnId?: string,
  ): GoalSnapshot {
    const current = this.#goal(id);
    this.#assertGoalMutationAuthority(current, actor);
    if (current.phase === phase) return current;
    if (phase === "complete") throw new Error("goal completion requires reason and evidence");
    const next = { ...current, phase, revision: current.revision + 1 };
    const operation = phase === "paused" ? "pause" : phase === "blocked" ? "block" : "resume";
    this.ledger.putGoal(next, actor, undefined, {
      operation,
      reason: `Goal ${operation} requested by ${actor}`,
      evidence: [],
      ...(sourceTurnId ? { sourceTurnId } : {}),
    });
    this.#preemptGoalTurn(current.id, `Goal ${operation}`);
    if (phase === "active" && scheduleMotion)
      this.#enqueueTrigger(
        next.owner,
        `${next.parentId ? "goal" : "root"}:${id}:resumed:${next.revision}`,
        { goalId: next.id },
      );
    return next;
  }

  planWake(
    agent: string,
    at: string,
    reason: string,
    setBy = agent,
    target?: { goalId: string },
  ): WakeSnapshot | null {
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) throw new Error("schedule time is invalid");
    const nextWakeAt = new Date(parsed).toISOString();
    const binding = target ?? this.#singleActiveGoalTarget(agent);
    const role = this.#role(agent);
    if (!binding && role !== "verifier" && role !== "audit")
      throw new Error("Goal-owning Agent schedules require an active Goal target");
    if (binding) {
      const goal = this.ledger.goal(binding.goalId);
      if (!goal || goal.phase !== "active" || !this.#validGoalOwner(agent, goal))
        throw new Error("schedule target is not an active Goal owned by this Agent");
    }
    const executionTarget = binding
      ? goalAutomaticTarget(agent, binding.goalId)
      : specialistAutomaticTarget(agent, role as "verifier" | "audit");
    const schedule: ScheduleSnapshot = {
      id: `schedule:${agent}${binding ? `:${binding.goalId}` : ""}:${randomUUID()}`,
      ...executionTarget,
      nextWakeAt,
      reason,
      setBy,
      status: "pending",
      resolvedAt: null,
    };
    this.ledger.putSchedule(schedule, setBy);
    return nextWakeAt <= this.#now() ? this.#enqueueSchedule(schedule) : null;
  }

  async stopAgentWake(agent: string, goalId?: string): Promise<WakeSnapshot | null> {
    const role = this.#role(agent);
    if (goalId) {
      const goal = this.#goal(goalId);
      if (!this.#validGoalOwner(agent, goal))
        throw new Error("Goal stop target is not owned by the Agent");
    }
    const target =
      role === "verifier" || role === "audit"
        ? null
        : goalId
          ? { goalId }
          : this.#singleActiveGoalTarget(agent);
    if (role !== "verifier" && role !== "audit" && !target)
      throw new Error("Goal stop requires an explicit Goal target");
    const wake = this.ledger
      .wakes()
      .find(
        (item) =>
          item.agent === agent &&
          (item.status === "queued" || item.status === "claimed") &&
          (target
            ? item.targetKind === "goal" && item.goalId === target.goalId
            : item.targetKind === "specialist"),
      );
    if (wake) this.ledger.cancelWake(wake.id, this.#now());
    const thread = this.ledger.threads().find((item) => item.agent === agent);
    const turn = thread ? this.ledger.activeTurn(thread.id) : null;
    if (
      turn &&
      (target ? turn.goalId === target.goalId : turn.goalId === null && turn.triggerKind === "wake")
    )
      await this.interruptTurn(turn.id);
    return wake ? this.#wake(wake.id) : null;
  }

  async recover(): Promise<void> {
    for (const wake of this.ledger.wakes().filter((candidate) => candidate.status === "claimed"))
      this.ledger.releaseWake(wake.id, this.#now());
    for (const turn of this.ledger
      .turns()
      .filter((candidate) => candidate.status !== "in_progress" && candidate.runnerPid !== null)) {
      await this.runner.terminateProcess(turn.runnerPid!, turn.runnerProfileId);
      this.ledger.releaseTurnProcess(turn.id, "supervisor");
    }
    for (const turn of this.ledger
      .turns()
      .filter(
        (candidate) => candidate.status === "in_progress" && !this.#handles.has(candidate.id),
      )) {
      if (turn.runnerPid) {
        await this.runner.terminateProcess(turn.runnerPid, turn.runnerProfileId);
        this.ledger.releaseTurnProcess(turn.id, "supervisor");
      }
      this.#failTurn(turn.id, "orphaned Runner ownership recovered after Supervisor restart");
      const thread = this.ledger.thread(turn.threadId);
      if (!thread) continue;
      if (turn.goalId) {
        const goal = this.ledger.goal(turn.goalId);
        if (goal?.phase === "active" && goal.owner === thread.agent)
          this.#enqueueTrigger(thread.agent, recoveryRef(turn.id), { goalId: goal.id });
      } else if (
        turn.triggerKind === "wake" &&
        (thread.role === "verifier" || thread.role === "audit")
      )
        this.#enqueueTrigger(thread.agent, recoveryRef(turn.id));
    }
  }
  async tick(): Promise<WakeSnapshot | null> {
    const wake = await this.#claimNextWake();
    if (!wake) return null;
    let createdTurnId: string | null = null;
    try {
      await this.#awaitAgentExecution(wake.agent);
      let currentWake = this.#wake(wake.id);
      if (currentWake.targetKind === "goal")
        await this.#goalExecutionBarriers.get(currentWake.goalId);
      currentWake = this.#wake(wake.id);
      if (currentWake.status !== "claimed") return currentWake;
      if (currentWake.targetKind === "goal") {
        const goal = this.ledger.goal(currentWake.goalId);
        if (
          !goal ||
          goal.owner !== currentWake.agent ||
          goal.phase !== "active" ||
          !this.#validGoalOwner(currentWake.agent, goal)
        ) {
          this.ledger.cancelWake(currentWake.id, this.#now());
          return this.#wake(currentWake.id);
        }
      }
      const wakeTriggers = this.ledger
        .wakeTriggers(currentWake.id)
        .filter((trigger) => trigger.status === "pending");
      const turnContext = turnContextForWake(this.#contextDeps, currentWake, wakeTriggers);
      if (!this.#validExecution(currentWake.agent, turnContext)) {
        this.ledger.cancelWake(currentWake.id, this.#now());
        return this.#wake(currentWake.id);
      }
      const thread = this.threadFor(currentWake.agent);
      const now = this.#now();
      const leaseToken = randomUUID();
      const commitment = turnContext.goalCommitment ?? noGoalCommitment();
      const execution: TurnSnapshot = {
        id: randomUUID(),
        threadId: thread.id,
        triggerKind: "wake",
        ...commitment,
        status: "in_progress",
        attempt: 1,
        error: null,
        startedAt: now,
        endedAt: null,
        leaseUntil: new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(),
        leaseToken,
        runnerPid: null,
        runnerProfileId: this.#runnerProfileId(currentWake.agent),
      };
      this.ledger.putThread({ ...thread, updatedAt: this.#now() }, "supervisor");
      this.ledger.startTurnFromWake(currentWake.id, execution, now);
      createdTurnId = execution.id;
      const deliveredMail = contextMail(
        this.#contextDeps,
        currentWake.agent,
        currentWake.targetKind === "goal" ? currentWake.goalId : null,
      );
      const deliveredMailIds = deliveredMail.map((mail) => mail.id);
      this.ledger.appendEvent({
        streamId: `turn:${execution.id}`,
        ts: now,
        actor: "supervisor",
        type: "run.admitted",
        data: { ...turnContext, wakeTriggers } as unknown as JsonValue,
        ignorable: true,
      });
      const revision = turnContext.goalCommitment
        ? (this.ledger.workRecord(turnContext.goalCommitment.goalId)?.recordRevision ?? -1)
        : -1;
      await this.#trackExecution(
        execution,
        currentWake.agent,
        turnContext,
        () =>
          goalContext(
            this.#contextDeps,
            currentWake,
            turnContext,
            execution.id,
            deliveredMail,
            wakeTriggers,
          ),
        currentWake,
        deliveredMailIds,
        revision,
        wakeTriggers,
      );
      return this.#wake(wake.id);
    } catch (error) {
      if (createdTurnId && this.ledger.turn(createdTurnId)?.status === "in_progress")
        this.#failTurn(createdTurnId, error instanceof Error ? error.message : String(error));
      const current = this.ledger.wake(wake.id);
      if (current?.status === "claimed") this.ledger.releaseWake(wake.id, this.#now());
      return this.#wake(wake.id);
    }
  }

  async #claimNextWake(): Promise<WakeSnapshot | null> {
    const previous = this.#claimTail;
    let release!: () => void;
    this.#claimTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      for (const schedule of this.ledger.dueSchedules(this.#now())) this.#enqueueSchedule(schedule);
      for (const mail of this.ledger.triggeringMail()) {
        const thread = this.ledger.threads().find((candidate) => candidate.agent === mail.to);
        if (thread && this.ledger.activeTurn(thread.id)) continue;
        const goal = mail.routeKind === "goal" ? this.ledger.goal(mail.goalId) : null;
        const target =
          goal &&
          goal.owner === mail.to &&
          goal.phase === "active" &&
          this.#validGoalOwner(mail.to, goal)
            ? { goalId: goal.id }
            : undefined;
        const specialistInteraction =
          mail.routeKind === "specialist_inbox" && this.#role(mail.to) === mail.specialistRole;
        if (!target && !specialistInteraction) continue;
        const base = `mail:${mail.id}`;
        const related = this.ledger
          .wakeTriggersForAgent(mail.to)
          .map((trigger) => ({ trigger, attempt: mailDeliveryAttempt(trigger.triggerRef, base) }))
          .filter(
            (entry): entry is { trigger: WakeTriggerSnapshot; attempt: number } =>
              entry.attempt !== null,
          );
        const pending = related
          .filter((entry) => entry.trigger.status === "pending")
          .sort((a, b) => b.attempt - a.attempt)[0];
        const next = related.reduce((highest, entry) => Math.max(highest, entry.attempt), -1) + 1;
        const trigger =
          pending?.trigger.triggerRef ?? (next === 0 ? base : `${base}@redelivery:${next}`);
        this.#enqueueTrigger(mail.to, trigger, target);
      }
      return this.ledger.claimNextWake(this.#now());
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

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot | null {
    if (schedule.status !== "pending") return null;
    if (schedule.targetKind === "goal") {
      const goal = this.ledger.goal(schedule.goalId);
      if (
        !goal ||
        goal.owner !== schedule.agent ||
        goal.phase !== "active" ||
        !this.#validGoalOwner(schedule.agent, goal)
      ) {
        this.ledger.supersedeSchedule(schedule.id, this.#now());
        return null;
      }
    } else if (!["verifier", "audit"].includes(this.#role(schedule.agent))) {
      this.ledger.cancelSchedule(schedule.id, this.#now());
      return null;
    }
    const wake: WakeSnapshot = {
      id: `wake:${schedule.id}`,
      ...(schedule.targetKind === "goal"
        ? goalAutomaticTarget(schedule.agent, schedule.goalId)
        : specialistAutomaticTarget(schedule.agent, schedule.specialistRole)),
      triggerRef: `${schedule.id}@${schedule.nextWakeAt}`,
      status: "queued",
      attempt: 0,
      enqueuedSeq: 0,
      claimedAt: null,
      consumedAt: null,
      turnId: null,
    };
    return this.ledger.consumeSchedule(schedule.id, wake, this.#now()).wake;
  }

  #enqueueTrigger(
    agent: string,
    triggerRef: string,
    target?: { goalId: string },
  ): WakeSnapshot | null {
    let binding: AutomaticTarget;
    if (target) {
      const goal = this.ledger.goal(target.goalId);
      if (
        !goal ||
        goal.owner !== agent ||
        goal.phase !== "active" ||
        !this.#validGoalOwner(agent, goal)
      )
        return null;
      binding = goalAutomaticTarget(agent, target.goalId);
    } else {
      const role = this.#role(agent);
      if (role === "verifier" || role === "audit") binding = specialistAutomaticTarget(agent, role);
      else return null;
    }
    const sameBinding = (wake: WakeSnapshot) =>
      wake.targetKind === binding.targetKind &&
      wake.goalId === binding.goalId &&
      wake.specialistRole === binding.specialistRole;
    const exact = this.ledger.wakeByTrigger(agent, triggerRef);
    if (exact) {
      if (!sameBinding(exact))
        throw new Error("Wake trigger was reused with a different automatic target");
      return exact;
    }
    const pending =
      this.ledger
        .wakes()
        .find((wake) => wake.agent === agent && wake.status === "claimed" && sameBinding(wake)) ??
      this.ledger
        .wakes()
        .find((wake) => wake.agent === agent && wake.status === "queued" && sameBinding(wake));
    if (pending) {
      this.ledger.addWakeTrigger(pending.id, triggerRef, "supervisor");
      return pending;
    }
    const wake: WakeSnapshot = {
      id: randomUUID(),
      ...binding,
      triggerRef,
      status: "queued",
      attempt: 0,
      enqueuedSeq: 0,
      claimedAt: null,
      consumedAt: null,
      turnId: null,
    };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return this.#wake(wake.id);
    const existing = this.ledger.wakeByTrigger(agent, triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #singleActiveGoalTarget(agent: string): { goalId: string } | undefined {
    const goals = this.ledger
      .goalsForOwner(agent)
      .filter((goal) => goal.phase === "active" && this.#validGoalOwner(agent, goal));
    if (goals.length > 1)
      throw new Error(
        "Wake requires an explicit Goal target when an Agent owns multiple active Goals",
      );
    return goals.length === 1 ? { goalId: goals[0]!.id } : undefined;
  }
  #knownAgent(agent: string): boolean {
    return (
      this.#profiles.has(agent) ||
      this.ledger.threads().some((thread) => thread.agent === agent) ||
      this.ledger.goals().some((goal) => goal.owner === agent)
    );
  }
  #role(agent: string): AgentRole {
    return (
      this.ledger.threads().find((thread) => thread.agent === agent)?.role ??
      this.#profiles.get(agent)?.role ??
      (agent === "ceo" ? "ceo" : "child")
    );
  }
  #validGoalOwner(agent: string, goal: GoalSnapshot): boolean {
    const role = this.#role(agent);
    return (
      goal.owner === agent &&
      (role === "ceo"
        ? agent === "ceo" && goal.parentId === null
        : role === "child" && goal.parentId !== null)
    );
  }
  #validExecution(agent: string, turn: TurnContext): boolean {
    const role = this.#role(agent);
    if (turn.goalCommitment) {
      const goal = this.ledger.goal(turn.goalCommitment.goalId);
      return Boolean(
        goal && this.#validGoalOwner(agent, goal) && (role === "ceo" || role === "child"),
      );
    }
    if (turn.trigger.kind === "user_message") return agent === "ceo" && role === "ceo";
    return role === "verifier" || role === "audit";
  }

  #wake(id: string): WakeSnapshot {
    const value = this.ledger.wake(id);
    if (!value) throw new Error(`wake not found: ${id}`);
    return value;
  }
  #goal(id: string): GoalSnapshot {
    const value = this.ledger.goal(id);
    if (!value) throw new Error(`goal not found: ${id}`);
    return value;
  }
  #assertGoalMutationAuthority(goal: GoalSnapshot, actor: string): void {
    if (goal.parentId === null) {
      if (actor !== "human") throw new Error("only human may modify a root goal");
      return;
    }
    const parent = this.ledger.goal(goal.parentId);
    if (parent?.owner !== actor)
      throw new Error("only the parent goal owner may modify a child goal");
  }
  #now(): string {
    return this.clock.now().toISOString();
  }
  #futureTime(value: string, after: string): string {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || parsed <= Date.parse(after))
      throw new Error("nextWakeAt must be later than the Turn start");
    return new Date(parsed).toISOString();
  }
  #runnerProfileId(agent: string): string {
    return this.#profiles.get(agent)?.runnerProfile ?? "default";
  }
}

export async function runSupervisorDaemon(
  supervisor: Supervisor,
  options: {
    pollMs?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 1_000;
  await supervisor.recover();
  while (!options.signal?.aborted) {
    try {
      await supervisor.runAvailable(options.concurrency ?? 4);
    } catch (error) {
      options.onError?.(error);
    }
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, pollMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
  }
}

export function deriveTeam(ledger: Ledger, now = new Date().toISOString()): TeamMemberView[] {
  const goals = ledger.goals();
  const wakes = ledger.wakes();
  const schedules = ledger.schedules();
  const threads = ledger.threads();
  const turns = ledger.turns();
  const handoffs = ledger.eventsSince(0, ["handoff.recorded"]);
  const owners = [...new Set(goals.map((goal) => goal.owner))].sort();
  return owners.map((agent) => {
    const owned = goals.filter((goal) => goal.owner === agent);
    const live = owned.filter((goal) => goal.phase !== "complete");
    const agentWakes = wakes
      .filter((wake) => wake.agent === agent)
      .sort((a, b) => b.enqueuedSeq - a.enqueuedSeq);
    const activeWake = agentWakes.find((wake) => {
      if (wake.status !== "claimed" && wake.status !== "queued") return false;
      if (!wake.goalId) return true;
      const goal = ledger.goal(wake.goalId);
      return goal?.phase === "active" && goal.owner === agent;
    });
    const threadIds = new Set(
      threads.filter((thread) => thread.agent === agent).map((thread) => thread.id),
    );
    const activeTurn = turns.find(
      (turn) => threadIds.has(turn.threadId) && turn.status === "in_progress",
    );
    const nextWakeAt =
      schedules
        .filter((schedule) => {
          if (
            schedule.agent !== agent ||
            schedule.status !== "pending" ||
            schedule.nextWakeAt <= now
          )
            return false;
          if (!schedule.goalId) return true;
          const goal = ledger.goal(schedule.goalId);
          return goal?.phase === "active" && goal.owner === agent;
        })
        .map((schedule) => schedule.nextWakeAt)
        .sort()[0] ?? null;
    const lastHandoff = [...handoffs].reverse().find((event) => event.actor === agent) ?? null;
    const value = lastHandoff?.data as { outcome?: unknown } | undefined;
    const lastOutcome =
      typeof value?.outcome === "string" ? (value.outcome as TeamMemberView["lastOutcome"]) : null;
    let motion: TeamMemberView["motion"];
    if (live.length === 0) motion = "retired";
    else if (activeTurn) motion = "running";
    else if (activeWake) motion = "queued";
    else if (nextWakeAt) motion = "scheduled";
    else motion = "idle";
    return {
      agent,
      goalIds: owned.map((goal) => goal.id),
      motion,
      lastOutcome,
      lastHandoffSeq: lastHandoff?.seq ?? null,
      lastWakeStatus: agentWakes[0]?.status ?? null,
      nextWakeAt,
    };
  });
}

export function renderDashboard(ledger: Ledger): string {
  const rows = (values: unknown[]) =>
    values
      .map((value) => `<tr><td><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></td></tr>`)
      .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>goah status</title><style>body{font:14px ui-monospace;margin:32px;background:#101418;color:#dce3e4}section{margin:32px 0}pre{white-space:pre-wrap;border:1px solid #334;padding:12px}</style></head><body><h1>goah</h1><p>seq ${ledger.events().at(-1)?.seq ?? 0}</p><section><h2>Team</h2><table>${rows(deriveTeam(ledger))}</table></section><section><h2>Goals</h2><table>${rows(ledger.goals())}</table></section><section><h2>Wakes</h2><table>${rows(ledger.wakes())}</table></section><section><h2>Mailbox</h2><table>${rows(ledger.mailbox())}</table></section></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function messageTextContent(content: unknown): string {
  if (typeof content === "string") return normalizeAssistantText(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      (part as { type?: unknown }).type === "text"
        ? normalizeAssistantText(String((part as { text?: unknown }).text ?? ""))
        : "",
    )
    .filter(Boolean)
    .join("\n");
}
function messageReasoningContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      (part as { type?: unknown }).type === "thinking"
        ? normalizeAssistantText(String((part as { thinking?: unknown }).thinking ?? ""))
        : "",
    )
    .filter(Boolean)
    .join("\n");
}
function appendLiveChunk(target: Map<number, string[]>, index: number, delta: string): void {
  if (!delta) return;
  const chunks = target.get(index) ?? [];
  const last = chunks.at(-1);
  if (last !== undefined && last.length < 4096) chunks[chunks.length - 1] = last + delta;
  else chunks.push(delta);
  target.set(index, chunks);
}
function joinLiveChunks(target: Map<number, string[]>): string {
  return [...target.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, chunks]) => chunks.join(""))
    .join("\n");
}

export * from "./verification.js";
export * from "./roles.js";
