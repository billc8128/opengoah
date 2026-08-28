import { createHash } from "node:crypto";
import { goalRoute,humanInboxRoute,specialistInboxRoute,type EventRecord,type JsonValue,type Ledger,type MailSnapshot } from "goah-ledger-contract";
import { spawn } from "node:child_process";
import type { Supervisor } from "./index.js";

export interface VerificationFinding {
  id: string;
  body: JsonValue;
  evidence: number[];
  riskWeight: number;
}

export interface VerificationResult { findings: VerificationFinding[]; tokensUsed: number }
export interface VerifierModel {
  verifyTurn(input: { turnId: string; handoff: JsonValue | null; trace: EventRecord[] }): Promise<VerificationResult>;
  blindAudit(facts: EventRecord[]): Promise<VerificationResult>;
}

export interface VerifierProcessSpec { command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }

export class ProcessVerifierModel implements VerifierModel {
  constructor(readonly spec: VerifierProcessSpec) {}
  verifyTurn(input: { turnId: string; handoff: JsonValue | null; trace: EventRecord[] }): Promise<VerificationResult> { return this.#call("verify_turn", input); }
  blindAudit(facts: EventRecord[]): Promise<VerificationResult> { return this.#call("blind_audit", { facts }); }

  async #call(operation: string, input: unknown): Promise<VerificationResult> {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(this.spec.command, this.spec.args, { detached: process.platform !== "win32", env: { ...env, ...this.spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;let outputOverflow=false;
    const kill=()=>{if(child.pid){try{process.kill(process.platform==="win32"?child.pid:-child.pid,"SIGKILL");}catch{}}};
    const append=(channel:"stdout"|"stderr",chunk:Buffer)=>{const text=chunk.toString();const remaining=Math.max(0,1_000_000-stdout.length-stderr.length);if(channel==="stdout")stdout+=text.slice(0,remaining);else stderr+=text.slice(0,remaining);if(text.length>remaining&&!outputOverflow){outputOverflow=true;kill();}};
    child.stdout.on("data",(chunk:Buffer)=>append("stdout",chunk));
    child.stderr.on("data",(chunk:Buffer)=>append("stderr",chunk));
    child.stdin.end(`${JSON.stringify({ operation, input })}\n`);
    const timer = setTimeout(() => { timedOut = true;kill(); }, this.spec.timeoutMs ?? 60_000);
    let code:number|null;
    try{code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});}finally{clearTimeout(timer);}
    if(outputOverflow)throw new Error("verifier output exceeded 1 MB");
    if (code !== 0) throw new Error(timedOut ? "verifier process timed out" : stderr.trim() || `verifier exited ${code}`);
    return JSON.parse(stdout) as VerificationResult;
  }
}

export class VerificationPlane {
  constructor(readonly ledger: Ledger, readonly supervisor: Supervisor, readonly model: VerifierModel) {}

  async verifyTurn(turnId: string): Promise<VerificationResult> {
    const turn=this.ledger.turn(turnId);if(!turn)throw new Error(`Turn not found: ${turnId}`);if(turn.status==="in_progress")throw new Error("cannot verify an in-progress Turn");
    const trace = this.ledger.readStream(`turn:${turnId}`);
    const handoff = this.ledger.turnItems(turnId).findLast((item) => item.type === "handoff")?.data ?? null;
    const result = await this.model.verifyTurn({ turnId, handoff, trace });
    this.#validate(result);
    const thread=this.ledger.thread(turn.threadId);if(!thread)throw new Error("verified Turn has no Thread");
    const level=result.findings.length?"decision" as const:"fyi" as const;const body={type:"verification_result",turnId,agent:thread.agent,findings:result.findings,tokensUsed:result.tokensUsed} as unknown as JsonValue;let route:ReturnType<typeof goalRoute>|ReturnType<typeof humanInboxRoute>|ReturnType<typeof specialistInboxRoute>;if(turn.goalId){const goal=this.ledger.goal(turn.goalId);if(!goal||goal.owner!==thread.agent)throw new Error("verified committed Turn no longer matches its owner");route=goalRoute(turn.goalId);}else if(thread.role==="ceo"){route=humanInboxRoute();}else{if(thread.role!=="verifier"&&thread.role!=="audit")throw new Error("verified uncommitted Turn is not a Specialist");route=specialistInboxRoute(thread.role);}const mail:MailSnapshot={id:this.#mailId("verification",turnId,thread.agent,result),to:thread.agent,from:"verifier",level,...route,body,readAt:null};this.ledger.putMail(mail,"verifier");
    return result;
  }

  async auditGlobal(sinceSeq = 0): Promise<VerificationResult> {
    const facts = this.ledger.eventsSince(sinceSeq).filter((event) => !["handoff.recorded", "runner.note"].includes(event.type));
    const result = await this.model.blindAudit(facts);
    this.#validate(result);
    this.ledger.putMail({id:this.#mailId("audit",String(sinceSeq),"ceo",result),to:"ceo",from:"audit",level:result.findings.length?"decision":"fyi",...humanInboxRoute(),body:{type:"audit_result",sinceSeq,findings:result.findings as unknown as JsonValue,tokensUsed:result.tokensUsed},readAt:null},"audit");
    return result;
  }

  #validate(result:VerificationResult):void {
    const evidence=new Set(this.ledger.events().map((event)=>event.seq));
    for(const finding of result.findings)if(!finding.id.trim()||finding.evidence.length===0||finding.evidence.some((seq)=>!evidence.has(seq)))throw new Error("verification finding requires an id and existing evidence");
  }
  #mailId(kind:string,source:string,recipient:string,result:VerificationResult):string{const digest=createHash("sha256").update(JSON.stringify(result)).digest("hex").slice(0,16);return `${kind}:${source}:${recipient}:${digest}`;}
}

export interface VerificationLabel { id: string; shouldFlag: boolean; riskWeight: number }
export interface ScoredPrediction { id: string; score: number }
export function evaluateVerification(labels: VerificationLabel[], predictedIds: string[]): { precision: number; riskWeightedRecall: number } {
  const predicted = new Set(predictedIds);
  const positives = labels.filter((label) => label.shouldFlag);
  const truePositives = positives.filter((label) => predicted.has(label.id));
  const falsePositives = labels.filter((label) => !label.shouldFlag && predicted.has(label.id));
  const precision = truePositives.length + falsePositives.length === 0 ? 1 : truePositives.length / (truePositives.length + falsePositives.length);
  const totalRisk = positives.reduce((sum, label) => sum + label.riskWeight, 0);
  const recalledRisk = truePositives.reduce((sum, label) => sum + label.riskWeight, 0);
  return { precision, riskWeightedRecall: totalRisk === 0 ? 1 : recalledRisk / totalRisk };
}

export function calibrateVerificationThreshold(labels: VerificationLabel[], predictions: ScoredPrediction[], minimumPrecision: number): number {
  const candidates = [...new Set(predictions.map((prediction) => prediction.score))].sort((a, b) => a - b);
  let selected = 1;
  let bestRecall = -1;
  for (const threshold of candidates) {
    const metrics = evaluateVerification(labels, predictions.filter((prediction) => prediction.score >= threshold).map((prediction) => prediction.id));
    if (metrics.precision >= minimumPrecision && metrics.riskWeightedRecall > bestRecall) { selected = threshold; bestRecall = metrics.riskWeightedRecall; }
  }
  return selected;
}
