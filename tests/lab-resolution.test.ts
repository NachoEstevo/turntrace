import { describe, expect, it } from "vitest";
import { parseScenario, type AgentAdapter, type Scenario } from "../src/lab/contract.js";
import { executeWorld } from "../src/lab/world.js";
import { inspectLab } from "../src/lab/verify.js";

const first = { kind: "input", id: "first", tick: 5, inputId: "original", day: "Tuesday" };
const second = { kind: "input", id: "second", tick: 20, inputId: "correction", day: "Thursday" };
const opaque = { idempotent: false, query: false, amend: false };

function simulate(step: AgentAdapter<number>["step"], expectation: Scenario["expectation"], actions: object[], delivery = "recoverable") {
  const scenario = parseScenario({ schemaVersion: 1, id: "handoff", policy: "external", provider: opaque, delivery, expectation, actions });
  const run = executeWorld(scenario, { id: "external", version: "1", init: ctx => ctx.epoch, step });
  return inspectLab(run.events, scenario, run.status === "terminal");
}

describe("independent handoff evidence", () => {
  it.each(["review", "reconfirm"] as const)("ignoring all inputs after a startup %s cannot resolve the booking", kind => {
    const report = simulate((next, input) => ({
      next, commands: input.kind === "start" ? [{ kind, reason: "Let a person handle it." }] : [],
    }), kind, [first]);
    expect(report.findings.map(f => f.property)).toEqual(["handoff.supported", `progress.${kind}`]);
  });

  it("an opaque provider alone does not justify a handoff about an unsent booking", () => {
    const report = simulate((next, input) => ({
      next, commands: input.kind === "input" ? [{ kind: "review", reason: "I cannot look up a receipt." }] : [],
    }), "settled", [first]);
    expect(report.findings.map(f => f.property)).toEqual(["handoff.supported"]);
    expect(report.bookings).toEqual([]);
  });

  it("retires a supported manual handoff when a new caller request arrives", () => {
    const step: AgentAdapter<number>["step"] = (next, input) => {
      if (input.kind === "input" && input.inputId === "original") {
        return { next, commands: [{ kind: "store", requestId: "w", expectedRevision: 0, snapshot: {
          inputIds: ["original"], day: "Tuesday", intentRevision: 1, createKey: "k", createDay: "Tuesday", operationKey: "k",
        } }] };
      }
      if (input.kind === "store-ack") return { next, commands: [
        { kind: "provider", requestId: "r", operation: { kind: "create", key: "k", day: "Tuesday" } },
        { kind: "timer", timerId: "deadline", delayTicks: 5 },
      ] };
      if (input.kind === "timer") return { next, commands: [{ kind: "review", reason: "The create has no receipt." }] };
      return { next, commands: [] };
    };
    const actions = [{ id: "lost", kind: "drop-next", channel: "providerReply", tick: 0 }, first];
    expect(simulate(step, "review", actions).findings).toEqual([]);
    expect(simulate(step, "review", [...actions, second]).findings.map(f => f.property)).toEqual(["progress.review"]);
  });

  it("allows a restarted single-delivery agent to request reconfirmation before further delivery", () => {
    const report = simulate((next, input) => {
      if (input.kind === "start" && next === 2) {
        return { next, commands: [{ kind: "reconfirm", reason: "A single-delivery input could have been lost." }] };
      }
      return { next, commands: [] };
    }, "reconfirm", [first, { kind: "crash", id: "cut", tick: 6 }, { kind: "restart", id: "boot", tick: 8 }], "once");
    expect(report.findings).toEqual([]);
  });
});
