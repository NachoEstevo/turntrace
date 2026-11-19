import type { BookingEvent, Day } from "../fixtures/booking/index.js";

export interface Observation {
  eventId: string;
  detail: string;
}

export interface Finding {
  property: string;
  eventId: string | null;
  detail: string;
}

export interface BookingReport {
  verdict: "pass" | "fail";
  latestRequest: Day | null;
  agent: { received: Observation[]; said: Observation[] };
  device: { queued: Observation[]; played: Observation[] };
  provider: { history: Observation[]; active: { bookingId: string; day: Day }[] };
  findings: Finding[];
}

type Claim = Extract<BookingEvent, { kind: "claim.emitted" }>["payload"];
type DeliveredReply = Extract<BookingEvent, { kind: "reply.delivered" }>["payload"];

function matchesClaim(known: Claim | undefined, actual: Claim): boolean {
  return known?.bookingId === actual.bookingId && known.day === actual.day;
}

function describeReply(reply: DeliveredReply): string {
  switch (reply.outcome) {
    case "committed":
      return `Provider confirmed ${reply.bookingId} for ${reply.day} (${reply.operation}).`;
    case "pending-revised":
      return `Provider accepted the pending revision of ${reply.bookingId} to ${reply.day} (pending-revised).`;
    case "too-late":
      return `Provider rejected the attempted revision of ${reply.bookingId} to ${reply.day} (too-late).`;
  }
}

// Only delivered replies count as the agent's evidence. The provider ledger and
// the device queue are reconstructed separately from their own observations.
export function inspectBooking(events: readonly BookingEvent[]): BookingReport {
  const report: BookingReport = {
    verdict: "pass",
    latestRequest: null,
    agent: { received: [], said: [] },
    device: { queued: [], played: [] },
    provider: { history: [], active: [] },
    findings: [],
  };
  const receipts = new Map<string, { day: Day; eventId: string }>();
  const bookings = new Map<string, { day: Day; eventId: string; firstCommitId: string }>();
  const emitted = new Map<string, Claim>();
  const queued = new Map<string, Claim>();
  let lastPlayback: Claim | undefined;
  let lastInputId: string | null = null;

  function fail(property: string, eventId: string | null, detail: string) {
    report.findings.push({ property, eventId, detail });
    report.verdict = "fail";
  }

  for (const event of events) {
    const eventId = event.id;
    switch (event.kind) {
      case "input.delivered": {
        report.latestRequest = event.payload.day;
        lastInputId = eventId;
        lastPlayback = undefined;
        report.agent.received.push({ eventId, detail: `Caller requested ${event.payload.day}.` });
        break;
      }
      case "reply.delivered": {
        const { outcome, bookingId, day } = event.payload;
        report.agent.received.push({ eventId, detail: describeReply(event.payload) });
        if (outcome === "committed") receipts.set(bookingId, { day, eventId });
        break;
      }
      case "provider.committed": {
        const { operation, day, bookingId } = event.payload;
        const firstCommitId = bookings.get(bookingId)?.firstCommitId ?? eventId;
        bookings.set(bookingId, { day, eventId, firstCommitId });
        report.provider.history.push({
          eventId, detail: `${operation === "create" ? "Created" : "Amended"} ${bookingId} for ${day}.`,
        });
        break;
      }
      case "claim.emitted": {
        const claim = event.payload;
        emitted.set(claim.claimId, claim);
        report.agent.said.push({
          eventId, detail: `Emitted confirmation ${claim.claimId} for ${claim.bookingId} on ${claim.day}.`,
        });
        const receipt = receipts.get(claim.bookingId);
        if (receipt?.day !== claim.day) {
          const evidence = receipt
            ? `The latest delivered commitment confirms ${receipt.day} at ${receipt.eventId}.`
            : "The agent has received no commitment for that booking.";
          fail("claim.supported", eventId, `Claimed ${claim.day} for ${claim.bookingId}. ${evidence}`);
        }
        break;
      }
      case "device.queued": {
        const claim = event.payload;
        report.device.queued.push({
          eventId, detail: `Queued ${claim.claimId} for ${claim.bookingId} on ${claim.day}.`,
        });
        if (!matchesClaim(emitted.get(claim.claimId), claim)) {
          fail("queue.emitted", eventId, `Queued ${claim.claimId} without a matching emitted claim.`);
        }
        queued.set(claim.claimId, claim);
        break;
      }
      case "device.playbackStarted": {
        const claim = event.payload;
        lastPlayback = claim;
        report.device.played.push({
          eventId, detail: `Started playback of ${claim.claimId} for ${claim.bookingId} on ${claim.day}.`,
        });
        if (!matchesClaim(queued.get(claim.claimId), claim)) {
          fail("playback.queued", eventId, `Played ${claim.claimId} without a matching queued claim.`);
        }
        queued.delete(claim.claimId);
        const booking = bookings.get(claim.bookingId);
        if (booking?.day !== claim.day) {
          const evidence = booking
            ? `The provider committed ${booking.day} at ${booking.eventId}.`
            : "The provider has no commitment for that booking.";
          fail("playback.booked", eventId, `Playback confirmed ${claim.day} for ${claim.bookingId}. ${evidence}`);
        }
        break;
      }
    }
  }

  report.provider.active = Array.from(bookings, ([bookingId, { day }]) => ({ bookingId, day }));
  const lastEventId = events.at(-1)?.id ?? null;
  if (report.latestRequest === null) {
    fail("intent.delivered", lastEventId, "The agent received no booking request.");
  }
  if (bookings.size !== 1) {
    const secondBooking = Array.from(bookings.values())[1];
    const origins = Array.from(bookings, ([id, booking]) => `${id} at ${booking.firstCommitId}`);
    const detail = origins.length ? ` Active commitments include ${origins.join(", ")}.` : "";
    fail("booking.unique", secondBooking?.firstCommitId ?? lastEventId, `Expected one active booking, found ${bookings.size}.${detail}`);
  }
  for (const [bookingId, { day, eventId }] of bookings) {
    if (report.latestRequest !== null && day !== report.latestRequest) {
      fail("booking.latest", eventId, `${bookingId} is for ${day}. The last request at ${lastInputId} was for ${report.latestRequest}.`);
    }
  }
  if (!lastPlayback || lastPlayback.day !== report.latestRequest || !bookings.has(lastPlayback.bookingId)) {
    const lastPlaybackId = lastPlayback && report.device.played.at(-1)?.eventId;
    fail("playback.latest", lastPlaybackId ?? lastEventId, "No final playback confirmed the latest request for an active booking.");
  }
  return report;
}
