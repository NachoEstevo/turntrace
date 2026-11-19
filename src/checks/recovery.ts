import type { Attempt, Confirmation, Day, Envelope, ProviderMode, RecoveryEvent, StoreAck } from "../fixtures/recovery/types.js";

type Booking = Pick<Envelope, "bookingId" | "day">;
type Playback = Booking & { eventId: string };
type Finding = { property: string; eventId: string | null; detail: string };

export interface RecoveryReport {
  verdict: "pass" | "fail";
  status: "confirmed" | "unknown" | "missing";
  bookings: Booking[];
  confirmation: (Playback & { evidenceEventId: string | null }) | null;
  review: { eventId: string; reason: string } | null;
  played: Playback[];
  findings: Finding[];
}

function sameSnapshot(a: StoreAck | undefined, b: StoreAck): boolean {
  return a?.operationKey === b.operationKey && a.day === b.day && a.revision === b.revision;
}

function sameAttempt(a: Attempt | undefined, b: Attempt): boolean {
  return a?.attemptId === b.attemptId && a.epoch === b.epoch && a.operationKey === b.operationKey && a.day === b.day;
}

/** Inspect journal, transport, agent, provider and playback observations in delivery order. */
export function inspectRecovery(events: readonly RecoveryEvent[], provider: ProviderMode): RecoveryReport {
  const report: RecoveryReport = {
    verdict: "pass", status: "missing", bookings: [], confirmation: null, review: null, played: [], findings: [],
  };
  function fail(property: string, eventId: string | null, detail: string) {
    report.findings.push({ property, eventId, detail });
    report.verdict = "fail";
  }
  let epoch = 1;
  let running = true;
  let restarted = false;
  let intent: Day | undefined;
  let durable: StoreAck | undefined;
  let acknowledged = false;
  let firstAttempt: Attempt | undefined;
  const attempts = new Map<string, Attempt>();
  const providerResults = new Map<string, Envelope>();
  const created = new Map<string, { result: Envelope; eventId: string }>();
  const dropped = new Set<string>();
  const deliveredAttempts = new Set<string>();
  const evidence = new Map<string, { receipt: Envelope; eventId: string }>();
  let emitted: Confirmation | undefined;
  let queued: Confirmation | undefined;
  let recoveredPlayback = false;

  for (const event of events) {
    const { id } = event;
    // In-flight provider and transport work may outlive an agent epoch.
    if (event.actor === "agent" && event.kind !== "agent.restarted" && (!running || event.payload.epoch !== epoch)) {
      fail("epoch.active", id, `Agent observed epoch ${event.payload.epoch} outside its active instance.`);
    }
    switch (event.kind) {
      case "input.delivered":
        intent = event.payload.day;
        break;
      case "store.committed":
        if (!running || event.payload.epoch !== epoch || event.payload.day !== intent) {
          fail("store.intent", id, "The write does not belong to the live caller intent and epoch.");
        }
        durable = event.payload;
        acknowledged = false;
        break;
      case "store.ackDelivered":
        acknowledged = running && event.payload.epoch === epoch && sameSnapshot(durable, event.payload);
        if (!acknowledged) fail("store.receipt", id, "The write acknowledgement has no matching durable revision in this epoch.");
        break;
      case "agent.crashed":
        running = false;
        acknowledged = false;
        evidence.clear();
        emitted = undefined;
        break;
      case "agent.restarted":
        if (running || event.payload.epoch !== epoch + 1 || !sameSnapshot(durable, event.payload)) {
          fail("recovery.snapshot", id, "Restart must follow the crash, advance the epoch and restore the durable intent, key and revision.");
        }
        if (!firstAttempt || !dropped.has(firstAttempt.attemptId)) {
          fail("recovery.lost-reply", id, "Restart did not follow loss of the first committed attempt's reply.");
        }
        epoch = event.payload.epoch;
        running = true;
        restarted = true;
        evidence.clear();
        break;
      case "request.sent": {
        const request = event.payload;
        if (!firstAttempt) {
          if (!acknowledged || request.day !== durable?.day || request.operationKey !== durable?.operationKey) {
            fail("request.durable", id, "First send requires a committed and acknowledged snapshot with the requested day and operation key.");
          }
          firstAttempt = request;
        } else {
          if (!restarted || request.epoch === firstAttempt.epoch) {
            fail("retry.instance", id, "The retry must come from the recovered instance.");
          }
          if (provider === "opaque") {
            fail("retry.opaque", id, `Attempt ${request.attemptId} repeated a create at a provider without deduplication or lookup.`);
          } else if (request.operationKey !== firstAttempt.operationKey || request.day !== firstAttempt.day) {
            fail("retry.key", id, `Retry must reuse ${firstAttempt.operationKey} with its original day ${firstAttempt.day}.`);
          }
        }
        if (attempts.has(request.attemptId)) fail("attempt.unique", id, `Transport attempt ID ${request.attemptId} was reused.`);
        attempts.set(request.attemptId, request);
        break;
      }
      case "provider.committed":
      case "provider.reused": {
        const result = event.payload;
        if (!sameAttempt(attempts.get(result.attemptId), result)) {
          fail("provider.request", id, "Provider result does not match its transport attempt.");
        }
        if (event.kind === "provider.committed") {
          if (created.size) {
            const first = created.values().next().value!;
            fail("booking.unique", id, `${first.result.attemptId} created ${first.result.bookingId} at ${first.eventId}. ${result.attemptId} committed ${result.bookingId} at ${id}.`);
          }
          created.set(result.bookingId, { result, eventId: id });
        } else {
          const original = created.get(result.bookingId)?.result;
          if (provider !== "idempotent" || original?.operationKey !== result.operationKey || original.day !== result.day) {
            fail("provider.reuse", id, "Reused result lacks a matching prior commitment for this idempotency key.");
          }
        }
        providerResults.set(result.attemptId, result);
        break;
      }
      case "reply.dropped":
      case "reply.delivered": {
        const reply = event.payload;
        const result = providerResults.get(reply.attemptId);
        const fromProvider = sameAttempt(result, reply) && result?.bookingId === reply.bookingId;
        if (!fromProvider) fail("reply.origin", id, "Reply has no matching provider result for that attempt and epoch.");
        if (event.kind === "reply.dropped") {
          if (deliveredAttempts.has(reply.attemptId)) fail("reply.disposition", id, "A delivered reply was also marked as lost.");
          dropped.add(reply.attemptId);
        } else if (dropped.has(reply.attemptId) || !running || reply.epoch !== epoch) {
          fail("reply.instance", id, "A dropped reply or a reply addressed to another instance was delivered.");
        } else if (fromProvider) {
          deliveredAttempts.add(reply.attemptId);
          evidence.set(reply.bookingId, { receipt: reply, eventId: id });
        }
        break;
      }
      case "agent.reviewRequested":
        report.status = "unknown";
        report.review = { eventId: id, reason: event.payload.reason };
        if (!restarted || !event.payload.reason.trim()) fail("review.reason", id, "Recovery requires an explicit human handoff with a reason.");
        break;
      case "claim.emitted": {
        const claim = event.payload;
        const delivered = evidence.get(claim.bookingId);
        const evidenceEventId = delivered?.receipt.day === claim.day && delivered.receipt.epoch === claim.epoch ? delivered.eventId : null;
        report.confirmation = { eventId: id, bookingId: claim.bookingId, day: claim.day, evidenceEventId };
        report.status = "confirmed";
        emitted = claim;
        if (!restarted) fail("claim.instance", id, "Recovery confirmation must come from the restarted instance.");
        if (!evidenceEventId) fail("claim.supported", id, "The current instance has no delivered provider commitment for the claimed booking and day.");
        break;
      }
      case "device.queued":
        if (!matchesClaim(emitted, event.payload)) fail("queue.emitted", id, "Device queued a claim the agent did not emit.");
        queued = event.payload;
        break;
      case "device.playbackStarted": {
        const claim = event.payload;
        const wasQueued = matchesClaim(queued, claim);
        if (!wasQueued) fail("playback.queued", id, "Playback did not consume the matching queued claim.");
        if (restarted && running && epoch === claim.epoch && wasQueued && matchesClaim(emitted, claim) && report.confirmation?.evidenceEventId) {
          recoveredPlayback = true;
        }
        queued = undefined;
        report.played.push({ eventId: id, bookingId: claim.bookingId, day: claim.day });
        break;
      }
    }
  }

  report.bookings = Array.from(created.values(), ({ result }) => ({ bookingId: result.bookingId, day: result.day }));
  const end = events.at(-1)?.id ?? null;
  if (!restarted) fail("recovery.completed", end, "The trace never reached a restarted instance.");
  if (!report.bookings.length || report.bookings.some(booking => booking.day !== intent)) {
    fail("booking.intent", end, "The provider did not retain the requested booking day.");
  }
  if (provider === "idempotent") {
    if (attempts.size < 2 || report.review || report.status !== "confirmed" || !recoveredPlayback) {
      fail("recovery.confirmed", end, "The recovered instance must retry, confirm from its delivered receipt and start matching device playback.");
    }
  } else if (!report.review || report.confirmation || report.played.length) {
    fail("recovery.unknown", end, "Ambiguous opaque recovery requires a human handoff and no confirmation.");
  }
  return report;
}

function matchesClaim(expected: Confirmation | undefined, actual: Confirmation): boolean {
  return expected?.claimId === actual.claimId && expected.epoch === actual.epoch &&
    expected.bookingId === actual.bookingId && expected.day === actual.day;
}
