import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runProcessWorker } from "goah-runner-pi";
import type { AgentHandoff, HandoffValidationResult, JsonValue, RunnerCandidateResult, TurnOutput } from "goah-ledger-contract";

interface FauxHandoffStep {response:{content:string};handoff:AgentHandoff}

interface WorkerStep {
  trace?: Array<{ type: string; data: JsonValue }>;
  response?: string;
  write?: { path: string; content: string };
  handoff?: FauxHandoffStep;
  crash?: string;
  hang?: boolean;
  delayMs?: number;
  rpc?: { method: import("goah-ledger-contract").AgentCapability; params: JsonValue };
}

await runProcessWorker(async (request, emit, rpc): Promise<RunnerCandidateResult> => {
  if (process.env.GOAH_FAUX_CONTEXT_FILE) writeFileSync(process.env.GOAH_FAUX_CONTEXT_FILE, JSON.stringify(request.context));
  const byAgent = JSON.parse(process.env.GOAH_FAUX_STEPS_BY_AGENT ?? "{}") as Record<string, WorkerStep[]>;
  const byTrigger = JSON.parse(process.env.GOAH_FAUX_STEPS_BY_TRIGGER ?? "{}") as Record<string, WorkerStep[]>;
  const triggerSteps = Object.entries(byTrigger).find(([selector]) => {const separator=selector.indexOf("|");const agent=separator<0?null:selector.slice(0,separator);const prefix=separator<0?selector:selector.slice(separator+1);return(!agent||agent===request.agent)&&request.sourceWakeTriggers?.some((trigger)=>trigger.triggerRef.startsWith(prefix));})?.[1];
  const steps = triggerSteps ?? byAgent[request.agent] ?? JSON.parse(process.env.GOAH_FAUX_STEPS ?? "[]") as WorkerStep[];
  let goalCommitment = request.turn?.goalCommitment;
  let recordUpdated = false;
  for (const step of steps) {
    if (step.write) {
      const path = join(process.cwd(), step.write.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.write.content);
    }
    for (const trace of step.trace ?? []) emit(trace);
    if (step.rpc) {
      const result = await rpc(step.rpc.method, resolveParams(step.rpc.params, request.context));
      emit({ type: "runner.rpc.result", data: result });
      if (step.rpc.method === "goal.create" || step.rpc.method === "goal.work") goalCommitment = commitmentFrom(result) ?? goalCommitment;
      if (step.rpc.method === "work_record.update") recordUpdated = true;
    }
    if (step.crash) throw new Error(step.crash);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step.hang) await new Promise(() => undefined);
    if (step.response !== undefined) return { outcome: "completed", response: { content: step.response } };
    if (step.handoff) {
      const draft=step.handoff;
      if (goalCommitment && !recordUpdated) {
        const current = await rpc("work_record.read", { goalId: goalCommitment.goalId });
        const record = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, JsonValue> : {};
        const evidence = sourceSeqs(request.context);
        await rpc("work_record.update", { expectedRevision: Number(record.recordRevision ?? 0), content: handoffRecord(draft.handoff, request.execution.id), reason: "record faux Goal progress", evidence: evidence.length ? [Math.max(...evidence)] : [] });
      }
      const validation=await rpc("goal.handoff.validate",{handoff:draft.handoff,candidateMessage:draft.response.content} as unknown as JsonValue) as unknown as HandoffValidationResult;emit({type:"message.assistant.completed",data:{message:{id:`faux:${request.execution.id}:handoff:${validation.attemptId}`,role:"assistant",content:[{type:"text",text:draft.response.content}],stopReason:"toolUse"},commitState:"provisional"}});if(!validation.accepted){emit({type:"runner.handoff_rejected",data:{attemptId:validation.attemptId,issues:validation.issues} as unknown as JsonValue});if(validation.fatal)return{outcome:"abnormal",reason:validation.issues.map((issue)=>issue.message).join("; ")};continue;}const output:TurnOutput={validationAttemptId:validation.attemptId,validationToken:validation.token,handoff:draft.handoff};return { outcome: "completed", response:draft.response,handoff:output };
    }
  }
  return { outcome: "abnormal", reason: "faux worker stopped without handoff" };
});

function resolveParams(value: JsonValue, context: JsonValue): JsonValue {
  const latest = Math.max(0, ...sourceSeqs(context));
  const visit = (item: JsonValue): JsonValue => {
    if (item === "$LATEST_SOURCE_SEQ") return latest;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]));
    return item;
  };
  return visit(value);
}

function sourceSeqs(context: JsonValue): number[] { return context && typeof context === "object" && !Array.isArray(context) && Array.isArray(context.sourceSeqs) ? context.sourceSeqs.filter((item): item is number => typeof item === "number") : []; }
function commitmentFrom(value: JsonValue): { goalId: string; goalRevision: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.goalCommitment || typeof value.goalCommitment !== "object" || Array.isArray(value.goalCommitment)) return undefined;
  const binding = value.goalCommitment as Record<string, JsonValue>;
  return typeof binding.goalId === "string" && typeof binding.goalRevision === "number" ? { goalId: binding.goalId, goalRevision: binding.goalRevision } : undefined;
}
function handoffRecord(handoff: AgentHandoff, turnId: string): string {
  return `# Current State\n\nGoal outcome: ${handoff.outcome}.\n\n# Observations\n\nSee Ledger evidence ${handoff.evidence.join(", ") || "none"}.\n\n# Work Completed\n\nRecorded Goal progress.\n\n# Decisions\n\nRecorded by the faux Goal runner in ${turnId}.\n\n# Blockers\n\n${handoff.outcome === "blocked" ? "Blocked." : "None."}\n\n# Next Steps\n\nContinue from the current Goal state.\n`;
}
