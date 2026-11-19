import { Scheduler } from "../../core/scheduler.js";
import { RecoveryAgent } from "./agent.js";
import { RecoveryProvider } from "./provider.js";
import { RecoveryStore } from "./store.js";
import { recoveryScenario } from "./types.js";
import type {
  Attempt, Confirmation, Envelope, ProviderMode, RecoveryEvent, RecoveryFact, RecoveryPolicy, StoreAck, StoreWrite,
} from "./types.js";

export { recoveryScenario };
export type { RecoveryEvent, RecoveryPolicy, ProviderMode } from "./types.js";

export function runRecovery(policy: RecoveryPolicy, providerMode: ProviderMode, replayChoices?: readonly string[]): {
  choices: readonly string[];
  events: readonly RecoveryEvent[];
} {
  const scheduler = new Scheduler();
  const events: RecoveryEvent[] = [];
  const store = new RecoveryStore();
  const provider = new RecoveryProvider(providerMode);
  const inTransit = new Map<string, Envelope>();
  const deviceQueue: Confirmation[] = [];
  let agent: RecoveryAgent | null = new RecoveryAgent(1, policy, providerMode);

  function currentAgent(): RecoveryAgent {
    if (!agent) throw new Error("No live agent instance.");
    return agent;
  }

  function at(id: string, tick: number, parents: string[], run: () => RecoveryFact): void {
    scheduler.schedule({
      id, tick, parents,
      run() {
        events.push({ id, tick, parents: [...parents], ...structuredClone(run()) });
      },
    });
  }

  function takeReply(attemptId: string): Envelope {
    const packet = inTransit.get(attemptId);
    if (!packet) throw new Error(`Reply for ${attemptId} is no longer in transit.`);
    inTransit.delete(attemptId);
    return packet;
  }

  function persist(requested: StoreWrite): void {
    at("store.write", 1, ["input.thursday"], () => {
      at("store.commit", 2, ["store.write"], () => {
        const ack: StoreAck = { ...requested, revision: store.write(requested) };
        at("store.ack", 3, ["store.commit"], () => {
          const attempt = currentAgent().receiveStoreAck(ack);
          if (!attempt) throw new Error("Store acknowledgment did not match the pending write.");
          send(attempt, 4, "store.ack");
          return { actor: "agent", kind: "store.ackDelivered", payload: ack };
        });
        return { actor: "store", kind: "store.committed", payload: ack };
      });
      return { actor: "agent", kind: "store.requested", payload: requested };
    });
  }

  function send(attempt: Attempt, tick: number, parent: string): void {
    const id = `request.${attempt.epoch}`;
    const providerEvent = `provider.${attempt.epoch}`;
    at(id, tick, [parent], () => {
      const ledgerParents = attempt.epoch === 1 ? [id] : [id, "provider.1"];
      at(providerEvent, tick + 1, ledgerParents, () => {
        const result = provider.create(attempt);
        if (result.kind === "conflict") throw new Error(`Conflicting payload for ${result.operationKey}.`);
        const packet = { ...attempt, operationKey: result.operationKey, day: result.day, bookingId: result.bookingId };
        inTransit.set(attempt.attemptId, packet);
        if (attempt.epoch === 1) dropThenCrash(attempt.attemptId, tick + 2, providerEvent);
        else deliver(attempt.attemptId, tick + 2, providerEvent);
        return {
          actor: "provider", kind: result.kind === "reused" ? "provider.reused" : "provider.committed",
          payload: packet,
        };
      });
      return { actor: "agent", kind: "request.sent", payload: attempt };
    });
  }

  function dropThenCrash(attemptId: string, tick: number, parent: string): void {
    at("reply.drop", tick, [parent], () => {
      const lost = takeReply(attemptId);
      at("agent.crash", tick + 1, ["reply.drop"], () => {
        const epoch = currentAgent().epoch;
        agent = null;
        restart(epoch + 1, tick + 2);
        return { actor: "agent", kind: "agent.crashed", payload: { epoch } };
      });
      return { actor: "transport", kind: "reply.dropped", payload: lost };
    });
  }

  function restart(epoch: number, tick: number): void {
    at("agent.restart", tick, ["agent.crash", "store.commit"], () => {
      const { snapshot, revision } = store.read();
      if (!snapshot) throw new Error("Missing durable booking intent.");
      agent = new RecoveryAgent(epoch, policy, providerMode);
      const decision = agent.recover(snapshot);
      if (decision.kind === "review") {
        at("agent.review", tick + 1, ["agent.restart"], () => ({
          actor: "agent", kind: "agent.reviewRequested", payload: decision.review,
        }));
      } else {
        send(decision.attempt, tick + 1, "agent.restart");
      }
      return { actor: "agent", kind: "agent.restarted", payload: { ...snapshot, epoch, revision } };
    });
  }

  function deliver(attemptId: string, tick: number, parent: string): void {
    at("reply.2", tick, [parent], () => {
      const packet = takeReply(attemptId);
      const claim = currentAgent().receiveReply(packet);
      if (claim) speak(claim, tick + 1);
      return { actor: "agent", kind: "reply.delivered", payload: packet };
    });
  }

  function speak(claim: Confirmation, tick: number): void {
    at("agent.confirm", tick, ["reply.2"], () => {
      at("device.queue", tick + 1, ["agent.confirm"], () => {
        deviceQueue.push({ ...claim });
        at("device.play", tick + 2, ["device.queue"], () => {
          const next = deviceQueue.shift();
          if (!next) throw new Error("The playback queue is empty.");
          return { actor: "device", kind: "device.playbackStarted", payload: next };
        });
        return { actor: "device", kind: "device.queued", payload: claim };
      });
      return { actor: "agent", kind: "claim.emitted", payload: claim };
    });
  }

  at("input.thursday", 0, [], () => {
    const { day } = recoveryScenario;
    const epoch = currentAgent().epoch;
    persist(currentAgent().receiveInput(day));
    return { actor: "agent", kind: "input.delivered", payload: { epoch, day } };
  });
  return { choices: scheduler.run([], replayChoices), events };
}
