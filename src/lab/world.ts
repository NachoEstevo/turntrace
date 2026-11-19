import { createHash } from "node:crypto";
import {
  assertSynchronousState, parseAgentStep, parseScenario, type AgentAdapter, type AgentCommand, type Channel, type Day,
  type DeliveredEvent, type JsonObject, type LabEvent, type Scenario, type ScenarioAction,
} from "./contract.js";
import { LabScheduler, type LabAction, type LabRunOptions } from "./engine.js";
import { WorldChannels } from "./world-channel.js";
import { WorldDevice } from "./world-device.js";
import { WorldJournal } from "./world-journal.js";
import { WorldProvider } from "./world-provider.js";

type PacketOptions = { enabled?: () => boolean; onDrop?: () => void; parents?: string[] };
type CallerMessage = { inputId: string; day: Day; sourceRevision: number; origin: string };

/** Each call constructs a new process, journal, provider, source, transport and device. */
export function executeWorld<S>(input: Scenario, adapter: AgentAdapter<S>, options: LabRunOptions = {}) {
  const scenario = parseScenario(input);
  const scheduler = new LabScheduler();
  const channels = new WorldChannels(scenario);
  const provider = new WorldProvider(scenario.provider);
  const journal = new WorldJournal();
  const device = new WorldDevice();
  const events: LabEvent[] = [];
  const sourceRevisions = new Map<string, number>();
  const retained = new Map<string, CallerMessage>();
  const failures: string[] = [];
  let epochStart: string | undefined;
  let lastCrash: string | undefined;
  let durableCommit: string | undefined;
  let lastProviderResult: string | undefined;
  let epoch = 0;
  let active: { state: S } | undefined;
  let ended = false;
  let frame: { id: string; parents: string[]; observations: number; effects: number; last: string } | undefined;

  function action(
    id: string, tick: number, parents: string[], causes: string[], run: () => void,
    constraints: Pick<LabAction, "enabled" | "resource"> = {},
  ): void {
    scheduler.schedule({
      id, tick, parents: [...new Set(parents)], ...constraints,
      run() {
        frame = { id, parents: [...new Set(causes)], observations: 0, effects: 0, last: id };
        run();
        frame = undefined;
      },
    });
  }

  function observe(actor: string, kind: string, payload: JsonObject, readFrom: (string | undefined)[] = []): string {
    const current = frame!;
    const first = current.observations++ === 0;
    const id = first ? current.id : `${current.id}#${current.observations}`;
    const parents = new Set(first ? current.parents : [current.last]);
    for (const cause of readFrom) if (cause !== undefined) parents.add(cause);
    events.push({ id, tick: scheduler.tick, parents: [...parents], actor, kind, payload: structuredClone(payload) });
    current.last = id;
    return id;
  }

  // The triggering action and its local emission index identify a delivery
  // across fresh worlds. Hashing keeps deep timer chains' IDs bounded.
  function effectId(label: string): string {
    const current = frame!;
    const token = createHash("sha256").update(`${current.id}/${current.effects++}/${label}`).digest("hex").slice(0, 24);
    return `@${label}.${token}`;
  }

  function transmit(
    channel: Channel, sender: string, envelope: JsonObject, deliver: () => void, controls: PacketOptions = {},
  ): void {
    const source = frame!;
    const base = effectId(channel);
    const packets = channels.plan(channel, sender, scheduler.tick, copy => `${base}.${copy}`);
    for (const packet of packets) {
      const constraints: Pick<LabAction, "enabled" | "resource"> = {};
      if (packet.duplicate) constraints.resource = "duplicate";
      if (controls.enabled && !packet.dropped) constraints.enabled = controls.enabled;
      const otherParents = [...packet.parents, ...(controls.parents ?? [])];
      action(packet.id, packet.tick, [source.id, ...otherParents], [source.last, ...otherParents], () => {
        if (packet.dropped) {
          observe("transport", "transport.dropped", { ...envelope, channel });
          controls.onDrop?.();
          return;
        }
        if (packet.duplicate) observe("transport", "transport.duplicated", { ...envelope, channel });
        deliver();
      }, constraints);
    }
  }

  function stale(channel: Channel, payload: JsonObject): void {
    observe("transport", "transport.stale", { ...payload, channel, currentEpoch: epoch });
  }

  function step(input: DeliveredEvent): void {
    if (!active) return;
    const response = parseAgentStep(adapter.step(active.state, structuredClone(input)));
    active.state = response.next;
    for (const command of response.commands) effect(command);
  }

  function boot(): void {
    const recovered = journal.activate();
    epoch = recovered.epoch;
    const context = { ...recovered, provider: scenario.provider, delivery: scenario.delivery };
    const state = adapter.init(structuredClone(context));
    assertSynchronousState(state);
    active = { state };
    epochStart = observe("agent", epoch === 1 ? "agent.started" : "agent.restarted", recovered, [lastCrash, durableCommit]);
    step({ kind: "start" });
    for (const message of retained.values()) deliverInput(message);
  }

  function deliverInput(message: CallerMessage): void {
    const target = epoch;
    const msg = { epoch: target, ...message };
    transmit("input", "caller", msg, () => {
      if (!active || epoch !== target) return stale("input", msg);
      observe("agent", "input.delivered", msg);
      const { inputId, day, sourceRevision } = message;
      step({ kind: "input", inputId, day, sourceRevision });
    }, { parents: [message.origin] });
  }

  function persist(command: Extract<AgentCommand, { kind: "store" }>): void {
    const { requestId, expectedRevision, snapshot: proposed } = command;
    const target = epoch;
    const msg = { epoch: target, requestId, expectedRevision, snapshot: proposed };
    const writeId = observe("agent", "store.requested", msg);
    const write = journal.request(target, writeId, expectedRevision, proposed);
    transmit("store", `agent.${target}`, msg, () => {
      const result = journal.apply(write);
      const ack = { ...msg, ...result };
      const observation = observe("store", result.accepted ? "store.committed" : "store.rejected", ack, [epochStart, durableCommit]);
      if (result.accepted) durableCommit = observation;
      transmit("storeAck", "store", ack, () => {
        if (!active || epoch !== target) return stale("storeAck", ack);
        journal.acknowledge(write);
        observe("agent", "store.ackDelivered", ack);
        step({ kind: "store-ack", requestId, accepted: ack.accepted, revision: ack.revision });
      });
    });
  }

  function sendProvider(command: Extract<AgentCommand, { kind: "provider" }>): void {
    const target = epoch;
    const { requestId, operation } = command;
    const attemptId = effectId("attempt");
    const msg = { epoch: target, requestId, attemptId, operation };
    observe("agent", "request.sent", msg);
    transmit("provider", `agent.${epoch}`, msg, () => {
      const failId = operation.kind === "query" ? undefined : failures.shift();
      const { effect, reply } = provider.execute(requestId, operation, failId !== undefined);
      const kind = { created: "provider.committed", amended: "provider.committed", reused: "provider.reused",
        queried: "provider.queried", rejected: "provider.failed" }[effect];
      const result = { ...msg, outcome: reply.outcome, bookingId: reply.bookingId, day: reply.day,
        ...(reply.reason === undefined ? {} : { reason: reply.reason }),
        ...(reply.failure === undefined ? {} : { failure: reply.failure }), ...(failId ? { faultId: failId } : {}) };
      lastProviderResult = observe("provider", kind, result, [lastProviderResult, failId]);
      transmit("providerReply", "provider", result, () => {
        if (!active || epoch !== target) return stale("providerReply", result);
        observe("agent", "reply.delivered", result);
        step(reply);
      });
    });
  }

  function speak(command: Extract<AgentCommand, { kind: "speech" }>): void {
    const fragment = { epoch, generation: command.generation, claim: command.claim, fragmentId: effectId("fragment") };
    observe("agent", "claim.emitted", fragment);
    transmit("speech", `agent.${epoch}`, fragment, () => {
      const ticket = device.accept(fragment);
      if (ticket === null) {
        observe("device", "device.stale", fragment);
        return;
      }
      observe("device", "device.queued", fragment);
      transmit("playback", "device", fragment, () => {
        const playing = device.start(ticket);
        if (!playing) {
          observe("device", "device.skipped", fragment);
          return;
        }
        observe("device", "device.playbackStarted", playing);
        const current = frame!;
        action(effectId("finish"), scheduler.tick + scenario.playbackTicks, [current.id], [current.last], () => {
          device.finish(ticket);
          observe("device", "device.playbackEnded", playing);
        });
      }, { enabled: () => device.ready(ticket), onDrop: () => device.drop(ticket) });
    });
  }

  function flush(generation: number): void {
    const msg = { epoch, generation };
    observe("agent", "flush.requested", msg);
    transmit("flush", `agent.${epoch}`, msg, () => {
      const { floor, remnant } = device.flush(generation);
      observe("device", "device.flushed", { ...msg, floor });
      if (remnant) observe("device", "device.remnant", remnant);
    });
  }

  function effect(command: AgentCommand): void {
    switch (command.kind) {
      case "store": return persist(command);
      case "provider": return sendProvider(command);
      case "speech": return speak(command);
      case "flush": return flush(command.generation);
      case "input-ack": {
        const payload = { epoch, inputId: command.inputId };
        observe("agent", "input.ackRequested", payload);
        transmit("inputAck", `agent.${epoch}`, payload, () => {
          retained.delete(command.inputId);
          observe("caller", "input.acknowledged", payload);
        });
        return;
      }
      case "timer": {
        const payload = { epoch, timerId: command.timerId, delayTicks: command.delayTicks };
        observe("agent", "timer.scheduled", payload);
        const current = frame!;
        action(effectId("timer"), scheduler.tick + command.delayTicks, [current.id], [current.last], () => {
          if (!active || epoch !== payload.epoch) {
            observe("agent", "timer.stale", payload);
            return;
          }
          observe("agent", "timer.fired", payload);
          step({ kind: "timer", timerId: command.timerId });
        });
        return;
      }
      case "review":
      case "reconfirm":
        observe("agent", command.kind === "review" ? "agent.reviewRequested" : "agent.reconfirmRequested",
          { epoch, reason: command.reason });
        return;
      case "observe":
        observe("agent", "agent.observed", { epoch, name: command.name, data: command.data });
    }
  }

  function external(event: ScenarioAction): void {
    switch (event.kind) {
      case "input": {
        const { inputId, day } = event;
        if (ended) {
          observe("caller", "caller.absent", { inputId, day });
          return;
        }
        const sourceRevision = sourceRevisions.get(inputId) ?? sourceRevisions.size + 1;
        sourceRevisions.set(inputId, sourceRevision);
        const origin = observe("caller", "caller.spoke", { inputId, day, sourceRevision });
        const message = { inputId, day, sourceRevision, origin };
        if (scenario.delivery === "recoverable") retained.set(inputId, message);
        deliverInput(message);
        return;
      }
      case "signal": {
        const { name, data } = event;
        observe("scenario", "scenario.signal", { name, data });
        if (!active) {
          observe("transport", "transport.signalUndelivered", { epoch, name, data });
          return;
        }
        observe("agent", "agent.signalDelivered", { epoch, name, data });
        step({ kind: "signal", name, data });
        return;
      }
      case "crash":
        lastCrash = observe("agent", active ? "agent.crashed" : "agent.alreadyDown", { epoch }, [epochStart]);
        active = undefined;
        return;
      case "restart":
        if (!active) boot();
        else observe("agent", "agent.alreadyRunning", { epoch });
        return;
      case "end-call":
        ended = true;
        observe("caller", "call.ended", {});
        step({ kind: "end-call" });
        return;
      case "fail-next-provider":
        failures.push(event.id);
        observe("transport", "provider.failureArmed", {});
        return;
      case "drop-next":
      case "duplicate-next":
      case "delay-next":
        channels.arm(event.channel, event);
        observe("transport", "transport.faultArmed", { fault: event.kind, channel: event.channel,
          ...(event.kind === "delay-next" ? { delayTicks: event.delayTicks } : {}) });
    }
  }

  const start = "@boot";
  action(start, 0, [], [], boot);
  for (const event of scenario.actions) {
    const parents = [start, ...event.parents];
    action(event.id, event.tick, parents, parents, () => external(event),
      event.kind === "restart" ? { resource: "restart" } : {});
  }
  const run = scheduler.run(options);
  return { ...run, events };
}
