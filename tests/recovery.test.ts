import { describe, expect, it } from "vitest";
import { RecoveryAgent } from "../src/fixtures/recovery/agent.js";
import { recoveryScenario, runRecovery } from "../src/fixtures/recovery/index.js";
import { RecoveryProvider } from "../src/fixtures/recovery/provider.js";
import { RecoveryStore } from "../src/fixtures/recovery/store.js";

const request = { operationKey: recoveryScenario.operationKey, day: recoveryScenario.day };

describe("provider operation keys", () => {
  it("reuses a committed receipt, and a conflicting payload leaves the original intact", () => {
    const provider = new RecoveryProvider("idempotent");
    const first = provider.create(request);
    expect(first).toMatchObject({ kind: "committed", bookingId: "booking-1", ...request });
    expect(provider.create({ ...request, day: "Tuesday" })).toMatchObject({
      kind: "conflict", operationKey: request.operationKey,
    });
    expect(provider.create({ ...request })).toMatchObject({ ...first, kind: "reused" });
    expect(provider.create({ ...request, operationKey: "another-operation" })).toMatchObject({
      kind: "committed", bookingId: "booking-2",
    });
  });

  it("makes a second commitment when the opaque provider receives the same key twice", () => {
    const provider = new RecoveryProvider("opaque");
    expect(provider.create(request)).toMatchObject({ kind: "committed", bookingId: "booking-1" });
    expect(provider.create(request)).toMatchObject({ kind: "committed", bookingId: "booking-2" });
  });
});

describe("durable agent snapshot", () => {
  it("isolates a durable write from both the caller's object and subsequent reads", () => {
    const store = new RecoveryStore();
    expect(store.read()).toEqual({ revision: 0, snapshot: null });
    const draft = { ...request, operationKey: "saved" };
    expect(store.write(draft)).toBe(1);
    draft.operationKey = "unsaved";
    const firstRead = store.read();
    expect(firstRead).toEqual({ revision: 1, snapshot: { ...request, operationKey: "saved" } });
    firstRead.snapshot!.operationKey = "changed-after-read";
    expect(store.read()).toEqual({ revision: 1, snapshot: { ...request, operationKey: "saved" } });
  });
});

describe("instance-scoped acknowledgments", () => {
  it("dispatches only once for its own pending write", () => {
    const agent = new RecoveryAgent(1, "safe", "idempotent");
    const ack = { ...request, epoch: 1, revision: 1 };
    expect(agent.receiveStoreAck(ack)).toBeUndefined();
    agent.receiveInput(request.day);
    expect(agent.receiveStoreAck({ ...ack, epoch: 2 })).toBeUndefined();
    expect(agent.receiveStoreAck({ ...ack, revision: 2 })).toBeUndefined();
    expect(agent.receiveStoreAck({ ...ack, operationKey: "unrelated" })).toBeUndefined();
    expect(agent.receiveStoreAck(ack)).toMatchObject({ ...request, epoch: 1, attemptId: "attempt-1" });
    expect(agent.receiveStoreAck(ack)).toBeUndefined();
  });

  it("accepts one matching provider reply on the new instance and ignores stale deliveries", () => {
    const restarted = new RecoveryAgent(2, "safe", "idempotent");
    const reply = { ...request, bookingId: "confirmed", epoch: 2, attemptId: "attempt-2" };
    const oldAck = { ...request, epoch: 1, revision: 1 };
    expect(restarted.receiveStoreAck(oldAck)).toBeUndefined();
    expect(restarted.receiveReply(reply)).toBeUndefined();
    restarted.recover(request);
    expect(restarted.receiveStoreAck(oldAck)).toBeUndefined();
    expect(restarted.receiveReply({ ...reply, epoch: 1, attemptId: "attempt-1" })).toBeUndefined();
    expect(restarted.receiveReply({ ...reply, epoch: 1 })).toBeUndefined();
    expect(restarted.receiveReply({ ...reply, attemptId: "attempt-1" })).toBeUndefined();
    expect(restarted.receiveReply({ ...reply, operationKey: "unrelated" })).toBeUndefined();
    expect(restarted.receiveReply({ ...reply, day: "Tuesday" })).toBeUndefined();
    expect(restarted.receiveReply(reply)).toMatchObject({ epoch: 2, bookingId: "confirmed", day: request.day });
    expect(restarted.receiveReply(reply)).toBeUndefined();
  });
});

describe("lost create acknowledgment", () => {
  it("persists and acknowledges before sending, drops attempt one, then retries from the recovered key", () => {
    const { events } = runRecovery("safe", "idempotent");
    expect(events.map(event => event.kind)).toEqual([
      "input.delivered", "store.requested", "store.committed", "store.ackDelivered",
      "request.sent", "provider.committed", "reply.dropped", "agent.crashed", "agent.restarted",
      "request.sent", "provider.reused", "reply.delivered", "claim.emitted", "device.queued",
      "device.playbackStarted",
    ]);
    const attempts = events.filter(event => event.kind === "request.sent");
    expect(attempts.map(event => event.payload)).toMatchObject([
      { ...request, epoch: 1, attemptId: "attempt-1" },
      { ...request, epoch: 2, attemptId: "attempt-2" },
    ]);
    expect(events.find(event => event.kind === "agent.restarted")?.payload).toMatchObject({
      epoch: 2, revision: 1, ...request,
    });
    expect(events.find(event => event.kind === "reply.dropped")?.payload).toMatchObject({
      epoch: 1, attemptId: "attempt-1", bookingId: "booking-1",
    });
    expect(events.find(event => event.kind === "reply.delivered")?.payload).toMatchObject({
      epoch: 2, attemptId: "attempt-2", bookingId: "booking-1",
    });
  });

  it("routes unresolved state to review without replaying a create on the opaque provider", () => {
    const { events } = runRecovery("safe", "opaque");
    const restart = events.findIndex(event => event.kind === "agent.restarted");
    expect(restart).toBeGreaterThan(0);
    const afterRestart = events.slice(restart + 1);
    expect(afterRestart.map(event => event.kind)).toEqual(["agent.reviewRequested"]);
    expect(afterRestart[0]?.payload).toMatchObject({
      epoch: 2, status: "unknown", reason: expect.stringMatching(/\S/),
    });
    expect(events.filter(event => event.kind === "request.sent")).toHaveLength(1);
    expect(events.filter(event => event.kind === "provider.committed")).toHaveLength(1);
  });

  it.each(["idempotent", "opaque"] as const)("changing the key creates a second booking with %s", mode => {
    const { events } = runRecovery("blind-retry", mode);
    const commits = events.filter(event => event.kind === "provider.committed");
    expect(commits.map(({ payload }) => [payload.attemptId, payload.bookingId])).toEqual([
      ["attempt-1", "booking-1"], ["attempt-2", "booking-2"],
    ]);
    expect(new Set(commits.map(({ payload }) => payload.operationKey)).size).toBe(2);
  });
});
