import type { Trace } from "../trace.js";

export function formatRun(trace: Trace): string {
  const { result, scenario } = trace;
  const observations = new Map(
    [
      ...result.agent.received, ...result.agent.said,
      ...result.device.queued, ...result.device.played, ...result.provider.history,
    ].map((observation) => [observation.eventId, observation.detail]),
  );
  const lines = [`${result.verdict.toUpperCase()}  ${scenario.policy} / ${scenario.order}`, ""];
  for (const event of trace.events) {
    let detail = observations.get(event.id);
    if (event.kind === "request.sent") {
      detail = `Sent ${event.payload.operation} for ${event.payload.bookingId} on ${event.payload.day}.`;
    } else if (event.kind === "provider.pending") {
      detail = `Opened a pending request for ${event.payload.day}.`;
    } else if (event.kind === "provider.revision") {
      detail = `Attempt to revise pending request to ${event.payload.day}: ${event.payload.outcome}.`;
    }
    lines.push(`  t${event.tick}  ${event.id.padEnd(24)}  ${detail ?? event.kind}`);
  }
  const bookings = result.provider.active.map(({ bookingId, day }) => `${bookingId} on ${day}`);
  lines.push("", `Active bookings: ${bookings.join(", ") || "none"}`);
  for (const finding of result.findings) {
    lines.push(`  FAIL ${finding.property} [${finding.eventId ?? "terminal"}]  ${finding.detail}`);
  }
  lines.push(`SHA-256  ${trace.digest}`);
  return lines.join("\n");
}

export function formatComparison(traces: Trace[]): string {
  const lines = [
    "One caller changes a booking from Tuesday to Thursday.",
    "",
    "Delivery order     Policy  Agent said  Device played  Provider booked  Check",
  ];
  for (const trace of traces) {
    const { scenario, events, result } = trace;
    const claim = events.findLast((event) => event.kind === "claim.emitted");
    const playback = events.findLast((event) => event.kind === "device.playbackStarted");
    const booked = result.provider.active.map(({ day }) => day).join(", ") || "none";
    const row = [
      scenario.order.padEnd(17), scenario.policy.padEnd(6),
      (claim?.payload.day ?? "none").padEnd(10), (playback?.payload.day ?? "none").padEnd(13),
      booked.padEnd(15), result.verdict.toUpperCase(),
    ];
    lines.push(row.join("  "));
  }
  const failure = traces.find((trace) => trace.result.verdict === "fail");
  if (failure) {
    const finding = failure.result.findings[0]!;
    lines.push("", `First failed check in ${failure.scenario.policy} / ${failure.scenario.order}:`,
      `  ${finding.property} [${finding.eventId ?? "terminal"}]  ${finding.detail}`);
  }
  return lines.join("\n");
}
