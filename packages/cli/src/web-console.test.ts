import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import test from "node:test";
import { ceoInboxRoute, goalAutomaticTarget } from "goah-ledger-contract";
import { deriveRecoveryViews } from "goah-supervisor";
import { createRuntime, defaultConfig, loadConfig } from "./index.js";
import { consoleMetadataPath, readConsoleMetadata, runWebConsole } from "./web-console.js";

test("local Console serves assets, redacted snapshots, and CEO control through Supervisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-"));
  const configPath = join(root, "goah.config.json");
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const runtime = createRuntime(loadConfig(configPath));
  runtime.ledger.putMail(
    {
      id: "secret-mail",
      to: "ceo",
      from: "verifier",
      priority: "normal",
      ...ceoInboxRoute(),
      body: { apiKey: "sk-do-not-expose-123456789" },
      readAt: null,
    },
    "verifier",
  );
  await assert.rejects(
    () =>
      runWebConsole(
        runtime.supervisor,
        runtime.ledger,
        config.stateDir,
        new AbortController().signal,
        { host: "0.0.0.0" },
      ),
    /loopback/,
  );

  const controller = new AbortController();
  let resolveListening!: () => void;
  const listening = new Promise<void>((resolve) => {
    resolveListening = resolve;
  });
  const server = runWebConsole(
    runtime.supervisor,
    runtime.ledger,
    config.stateDir,
    controller.signal,
    { onListening: resolveListening },
  );
  await listening;
  const metadata = readConsoleMetadata(config.stateDir);
  assert.ok(metadata);

  const page = await fetch(metadata.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Goah Console/);
  const forgedReferer = await fetch(`${metadata.url}api/snapshot`, {
    headers: { referer: metadata.url },
  });
  assert.equal(forgedReferer.status, 403);
  const rebound = await rawRequest(metadata.url, "evil.test");
  assert.equal(rebound.status, 403);
  assert.equal(rebound.setCookie, undefined);

  const ceoResponse = await fetch(`${metadata.url}api/ceo?token=${metadata.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Launch a profitable store" }),
  });
  assert.equal(ceoResponse.status, 202);
  const accepted = (await ceoResponse.json()) as { threadId: string; turnId: string };
  assert.equal(runtime.ledger.goals().length, 0);

  const snapshotResponse = await fetch(`${metadata.url}api/snapshot?token=${metadata.token}`);
  assert.equal(snapshotResponse.status, 200);
  const snapshotText = await snapshotResponse.text();
  assert.match(snapshotText, /Launch a profitable store/);
  assert.doesNotMatch(snapshotText, /sk-do-not-expose/);
  assert.match(snapshotText, /\[REDACTED\]/);

  const trajectoryResponse = await fetch(
    `${metadata.url}api/trajectory?limit=2&token=${metadata.token}`,
  );
  assert.equal(trajectoryResponse.status, 200);
  const trajectory = (await trajectoryResponse.json()) as {
    items: Array<{ event: { seq: number; type: string }; agent: string; wakeId: string | null }>;
  };
  assert.ok(trajectory.items.length > 0);
  assert.ok(
    trajectory.items.every(
      (item, index, items) => index === 0 || items[index - 1]!.event.seq > item.event.seq,
    ),
  );

  const threadResponse = await fetch(
    `${metadata.url}api/threads/${encodeURIComponent(accepted.threadId)}?token=${metadata.token}`,
  );
  assert.equal(threadResponse.status, 200);
  const thread = (await threadResponse.json()) as {
    thread: { id: string };
    turns: Array<{ id: string; items: unknown[] }>;
  };
  assert.equal(thread.thread.id, accepted.threadId);
  assert.equal(thread.turns[0]?.id, accepted.turnId);

  while (runtime.ledger.turn(accepted.turnId)?.status === "in_progress")
    await new Promise((resolve) => setTimeout(resolve, 5));

  controller.abort();
  await server;
  assert.equal(readConsoleMetadata(config.stateDir), null);
  assert.equal(consoleMetadataPath(config.stateDir), join(config.stateDir, "console.json"));
  runtime.ledger.close();
});

function rawRequest(
  url: string,
  host: string,
): Promise<{ status: number; setCookie: string[] | undefined }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const call = request(
      { hostname: target.hostname, port: target.port, path: target.pathname, headers: { host } },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, setCookie: response.headers["set-cookie"] }),
        );
      },
    );
    call.once("error", reject);
    call.end();
  });
}

test("Console chat streams a CEO interaction and survives client disconnects", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-chat-"));
  const configPath = join(root, "goah.config.json");
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") };
  config.runnerProfiles![0]!.config = {
    provider: "faux",
    model: "faux-goah",
    fauxHandoff: { outcome: "blocked" },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const runtime = createRuntime(loadConfig(configPath));

  const controller = new AbortController();
  let resolveListening!: () => void;
  const listening = new Promise<void>((resolve) => {
    resolveListening = resolve;
  });
  const server = runWebConsole(
    runtime.supervisor,
    runtime.ledger,
    config.stateDir,
    controller.signal,
    { onListening: resolveListening },
  );
  await listening;
  const metadata = readConsoleMetadata(config.stateDir);
  assert.ok(metadata);
  try {
    const chatResponse = await fetch(`${metadata.url}api/chat?token=${metadata.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Operate the store" }),
    });
    assert.equal(chatResponse.status, 200);
    assert.match(chatResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    const frames: Array<{ type: string; event?: { type: string } }> = [];
    const text = await chatResponse.text();
    for (const chunk of text.split("\n\n")) {
      if (chunk.startsWith("data: ")) frames.push(JSON.parse(chunk.slice(6)));
    }
    assert.equal(frames.at(-1)?.type, "result");
    assert.ok(frames.some((frame) => frame.type === "accepted"));
    assert.equal(
      frames.some((frame) => frame.type === "event" && frame.event?.type === "handoff.recorded"),
      false,
    );
    assert.equal(runtime.ledger.goals().length, 0);
    const second = await fetch(`${metadata.url}api/chat?token=${metadata.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Keep going" }),
    });
    const reader = second.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    assert.equal(firstChunk.includes('"accepted"'), true);
    await reader.cancel();
    assert.ok(runtime.ledger.turns().some((turn) => turn.triggerKind === "user_message"));
  } finally {
    controller.abort();
    await server;
    for (const turn of runtime.ledger
      .turns()
      .filter((candidate) => candidate.status === "in_progress"))
      await runtime.supervisor.interruptTurn(turn.id);
    runtime.ledger.close();
  }
});

test("Console recovery state follows the current Goal lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-recovery-"));
  const configPath = join(root, "goah.config.json");
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const runtime = createRuntime(loadConfig(configPath));
  const started = runtime.supervisor.startGoal("recover failed work", "recovery-root");
  const now = new Date().toISOString();
  assert.equal(runtime.ledger.claimNextWake(now)?.id, started.wake.id);
  const thread = runtime.supervisor.threadFor("ceo");
  runtime.ledger.startTurnFromWake(
    started.wake.id,
    {
      id: "failed-turn",
      threadId: thread.id,
      triggerKind: "wake",
      goalId: started.goal.id,
      goalRevision: started.goal.revision,
      status: "in_progress",
      attempt: 1,
      error: null,
      startedAt: now,
      endedAt: null,
      leaseUntil: new Date(Date.parse(now) + 60_000).toISOString(),
      leaseToken: "test-lease",
      runnerPid: null,
    },
    now,
  );
  runtime.ledger.finishTurn("failed-turn", "failed", { message: "failed" }, now, "supervisor");
  runtime.ledger.putSchedule(
    {
      id: "recovery:failed-turn:1",
      ...goalAutomaticTarget("ceo", started.goal.id),
      nextWakeAt: new Date(Date.parse(now) + 60_000).toISOString(),
      reason: "recovery:failed-turn",
      setBy: "supervisor",
      status: "pending",
      resolvedAt: null,
    },
    "supervisor",
  );

  assert.deepEqual(deriveRecoveryViews(runtime.ledger), [
    { turnId: "failed-turn", agent: "ceo", state: "scheduled", actionable: false },
  ]);
  runtime.supervisor.transitionGoal(started.goal.id, "paused", "human");
  assert.deepEqual(deriveRecoveryViews(runtime.ledger), []);
  assert.equal(runtime.ledger.schedules()[0]?.status, "superseded");
  runtime.ledger.close();
});

test("recovery state distinguishes escalation, unrelated schedules, and failed retries", () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-recovery-matrix-"));
  const configPath = join(root, "goah.config.json");
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const runtime = createRuntime(loadConfig(configPath));
  runtime.supervisor.createRootGoal("root", "root");
  for (const [goalId, agent] of [
    ["child-escalated", "worker-a"],
    ["child-retried", "worker-b"],
  ] as const)
    runtime.ledger.putGoal(
      {
        id: goalId,
        parentId: "root",
        objective: goalId,
        observationMethod: "observe",
        verificationMethod: "verify",
        owner: agent,
        phase: "active",
        revision: 0,
      },
      "ceo",
    );

  failGoalWake(
    runtime,
    "child-escalated",
    "worker-a",
    "source-a",
    "failed-a",
    "goal:child-escalated",
  );
  failGoalWake(runtime, "child-retried", "worker-b", "source-b", "failed-b", "goal:child-retried");
  const now = new Date().toISOString();
  runtime.ledger.putSchedule(
    {
      id: "ordinary",
      ...goalAutomaticTarget("ceo", "root"),
      nextWakeAt: new Date(Date.parse(now) + 60_000).toISOString(),
      reason: "recovery:failed-b",
      setBy: "ceo",
      status: "pending",
      resolvedAt: null,
    },
    "ceo",
  );
  assert.equal(
    deriveRecoveryViews(runtime.ledger).find((view) => view.turnId === "failed-b")?.state,
    "needed",
  );

  failGoalWake(
    runtime,
    "child-retried",
    "worker-b",
    "retry-b",
    "failed-retry-b",
    "recovery:failed-b:1",
  );
  runtime.ledger.enqueueWake(
    {
      id: "escalation-a",
      ...goalAutomaticTarget("ceo", "root"),
      triggerRef: "child-retry-exhausted:failed-a",
      status: "queued",
      attempt: 0,
      enqueuedSeq: 0,
      claimedAt: null,
      consumedAt: null,
      turnId: null,
    },
    "supervisor",
  );
  const views = deriveRecoveryViews(runtime.ledger);
  assert.equal(views.find((view) => view.turnId === "failed-a")?.state, "escalated");
  assert.equal(views.find((view) => view.turnId === "failed-b")?.state, "superseded");
  assert.deepEqual(
    views.find((view) => view.turnId === "failed-retry-b"),
    { turnId: "failed-retry-b", agent: "worker-b", state: "needed", actionable: true },
  );
  runtime.ledger.close();
});

function failGoalWake(
  runtime: ReturnType<typeof createRuntime>,
  goalId: string,
  agent: string,
  wakeId: string,
  turnId: string,
  triggerRef: string,
): void {
  const now = new Date().toISOString();
  const thread = runtime.supervisor.threadFor(agent);
  runtime.ledger.enqueueWake(
    {
      id: wakeId,
      ...goalAutomaticTarget(agent, goalId),
      triggerRef,
      status: "queued",
      attempt: 0,
      enqueuedSeq: 0,
      claimedAt: null,
      consumedAt: null,
      turnId: null,
    },
    "supervisor",
  );
  assert.equal(runtime.ledger.claimNextWake(now)?.id, wakeId);
  runtime.ledger.startTurnFromWake(
    wakeId,
    {
      id: turnId,
      threadId: thread.id,
      triggerKind: "wake",
      goalId,
      goalRevision: runtime.ledger.goal(goalId)!.revision,
      status: "in_progress",
      attempt: 1,
      error: null,
      startedAt: now,
      endedAt: null,
      leaseUntil: new Date(Date.parse(now) + 60_000).toISOString(),
      leaseToken: turnId,
      runnerPid: null,
    },
    now,
  );
  runtime.ledger.finishTurn(turnId, "failed", { message: "failed" }, now, "supervisor");
}
