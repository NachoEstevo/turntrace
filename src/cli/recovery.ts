import type { RecoveryTrace } from "../recovery-trace.js";

type Event = RecoveryTrace["events"][number];

function describe(event: Event): string {
  const { kind, payload } = event;
  switch (kind) {
    case "input.delivered":
      return `The caller requested ${payload.day}.`;
    case "store.requested":
      return `Agent instance ${payload.epoch} asked to save ${payload.day} and key ${payload.operationKey}.`;
    case "store.committed":
      return `The store persisted ${payload.day} and key ${payload.operationKey} at revision ${payload.revision}.`;
    case "store.ackDelivered":
      return `Agent instance ${payload.epoch} received the write receipt for revision ${payload.revision}.`;
    case "request.sent":
      return `Agent instance ${payload.epoch} sent ${payload.attemptId} for ${payload.day} with key ${payload.operationKey}.`;
    case "provider.committed":
      return `The provider committed ${payload.bookingId} on ${payload.day} for ${payload.attemptId}.`;
    case "provider.reused":
      return `The provider reused ${payload.bookingId} for key ${payload.operationKey} on ${payload.attemptId}.`;
    case "reply.dropped":
      return `The transport dropped the receipt for ${payload.bookingId} before it reached the agent.`;
    case "agent.crashed":
      return `Agent instance ${payload.epoch} crashed and lost its volatile state.`;
    case "agent.restarted":
      return `Agent instance ${payload.epoch} recovered ${payload.day} and key ${payload.operationKey} from store revision ${payload.revision}. The booking outcome is unknown to the agent.`;
    case "reply.delivered":
      return `Agent instance ${payload.epoch} received the provider receipt for ${payload.bookingId} on ${payload.day}.`;
    case "agent.reviewRequested":
      return `The agent requested human review. ${payload.reason}`;
    case "claim.emitted":
      return `The agent confirmed ${payload.bookingId} on ${payload.day} (claim ${payload.claimId}).`;
    case "device.queued":
      return `The device queued ${payload.claimId}.`;
    case "device.playbackStarted":
      return `The device began playing ${payload.claimId} for ${payload.bookingId} on ${payload.day}.`;
  }
}

function timeline(event: Event): string {
  return `  t${String(event.tick).padEnd(2)}  ${event.id.padEnd(16)}  ${describe(event)}`;
}

function summarize(trace: RecoveryTrace): string[] {
  const { result, scenario } = trace;
  const bookings = result.bookings.map(({ bookingId, day }) => `${bookingId} on ${day}`);
  const evidence = result.confirmation?.evidenceEventId;
  const handoff = result.review ? ` (human review at ${result.review.eventId})` : "";
  const playback = result.played.map(({ bookingId, day }) => `${bookingId} on ${day}`).join(", ");
  return [
    `${result.verdict.toUpperCase()}  ${scenario.policy} / ${scenario.provider}`,
    `  Agent outcome  ${result.status}${evidence ? ` (receipt ${evidence})` : handoff}`,
    `  Provider holds ${bookings.length} booking${bookings.length === 1 ? "" : "s"}${bookings.length ? ` (${bookings.join(", ")})` : ""}`,
    `  Device played  ${playback || "no confirmation"}`,
    ...result.findings.map((finding) =>
      `  FAIL ${finding.property} [${finding.eventId ?? "terminal"}]  ${finding.detail}`),
  ];
}

export function formatRecoveryRun(trace: RecoveryTrace): string {
  return [...summarize(trace), "", ...trace.events.map(timeline), "", `SHA-256  ${trace.digest}`].join("\n");
}

export function formatRecoveryComparison(traces: readonly RecoveryTrace[]): string {
  const lines = traces.flatMap((trace) => [...summarize(trace), ""]);
  lines.push("Through the restart in both cases");
  const common = traces[0]!;
  const end = common.events.findIndex((event) => event.kind === "agent.restarted") + 1;
  const milestones: Event["kind"][] = [
    "store.committed", "store.ackDelivered", "request.sent", "provider.committed",
    "reply.dropped", "agent.crashed", "agent.restarted",
  ];
  for (const event of common.events.slice(0, end)) {
    if (milestones.includes(event.kind)) lines.push(timeline(event));
  }
  for (const trace of traces) {
    lines.push("", `After restart with the ${trace.scenario.provider} provider`);
    for (const event of trace.events.slice(end)) {
      if (event.kind !== "device.queued") lines.push(timeline(event));
    }
  }
  return lines.join("\n");
}
