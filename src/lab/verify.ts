import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue, LabEvent, Scenario } from "./contract.js";
import { ResolutionEvidence } from "./resolution.js";

export interface LabFinding {
  property: string;
  eventId: string;
  detail: string;
  signature: string;
}
type Booking = { bookingId: string; day: string };
type Mark = Booking & { eventId: string; generation: number };
type Decision = { eventId: string; reason: string };
export interface LabReport {
  verdict: "pass" | "fail" | "inconclusive";
  findings: LabFinding[];
  latestIntent: { inputId: string; day: string } | null;
  bookings: Booking[];
  played: Mark[];
  review: Decision | null;
  reconfirm: Decision | null;
}

function object(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function ids(snapshot: JsonObject): string[] {
  return Array.isArray(snapshot.inputIds) ? snapshot.inputIds.filter((id): id is string => typeof id === "string") : [];
}

/** Observations are independent of adapter state and replay choices. Only terminal runs owe progress. */
export function inspectLab(events: readonly LabEvent[], scenario: Scenario, quiescent: boolean): LabReport {
  const findings: LabFinding[] = [];
  const report: LabReport = { verdict: quiescent ? "pass" : "inconclusive", findings, latestIntent: null, bookings: [], played: [], review: null, reconfirm: null };
  const fail = (property: string, eventId: string, detail: string, ...facts: (string | number)[]) => {
    findings.push({ property, eventId, detail, signature: JSON.stringify([property, ...facts]) });
    report.verdict = "fail";
  };
  type SourceInput = { inputId: string; day: string; sourceRevision: number };
  const spokenInputs = new Map<string, SourceInput>();
  function latestRecorded(snapshot: JsonObject): SourceInput | undefined {
    let latest: SourceInput | undefined;
    for (const inputId of ids(snapshot)) {
      const source = spokenInputs.get(inputId);
      if (source && (!latest || source.sourceRevision > latest.sourceRevision)) latest = source;
    }
    return latest;
  }
  const durableInputs = new Set<string>();
  const retiredReceipts = new Set<string>();
  const bookings = new Map<string, string>();
  const receipts = new Map<string, { day: string; version: number }>();
  const providerResults = new Map<string, { payload: JsonObject; version: number }>();
  const storeResults = new Map<string, JsonObject>();
  const committedKeys = new Map<string, number>();
  const createIntents = new Map<string, { input: SourceInput; epoch: number }>();
  const sentCreates = new Set<string>();
  const bookingCreateKeys = new Map<string, string>();
  const learnedBookings = new Set<string>();
  let persistedBookingId: string | null = null;
  let providerVersion = 0;
  const fragments = new Map<string, { generation: number; bookingId: string; day: string; inputId: string; queued: number }>();
  let originalCreate: { key: string; day: string } | null = null;
  let journal: JsonObject = {};
  let revision = 0;
  let knownJournal: JsonObject = {};
  let knownRevision = 0;
  let epoch = 0;
  let running = false;
  let heard = "";
  let heardId = "unknown";
  let heardRevision = 0;
  let knownInputs = new Set<string>();
  const deliveredLate = new Set<string>();
  let generationFloor = 0;
  let lastResolution: "claim" | "review" | "reconfirm" | null = null;
  const resolution = new ResolutionEvidence();
  let lastPlay: Mark | null = null;

  for (const event of events) {
    const p = event.payload;
    const { id } = event;
    const operation = object(p.operation);
    const claim = object(p.claim);
    resolution.note(event, operation, heardId);
    switch (event.kind) {
      case "caller.spoke": {
        const inputId = String(p.inputId);
        if (!spokenInputs.has(inputId)) {
          const day = String(p.day);
          spokenInputs.set(inputId, { inputId, day, sourceRevision: Number(p.sourceRevision) });
          report.latestIntent = { inputId, day };
          lastPlay = null;
          lastResolution = null;
        }
        break;
      }
      case "agent.started":
      case "agent.restarted":
        if ((epoch && Number(p.epoch) <= epoch) || Number(p.revision) !== revision ||
            !isDeepStrictEqual(p.snapshot ?? null, revision ? journal : null)) {
          fail("store.recovery", id, "The restarted instance did not recover the latest committed journal and a new epoch.",
            latestRecorded(journal)?.inputId ?? "unknown", String(journal.operationKey ?? "none"), revision);
        }
        epoch = Number(p.epoch);
        running = true;
        receipts.clear();
        deliveredLate.clear();
        knownInputs = new Set(ids(journal));
        knownJournal = journal;
        knownRevision = revision;
        learnedBookings.clear();
        if (persistedBookingId) learnedBookings.add(persistedBookingId);
        heard = String(journal.day ?? "");
        heardId = latestRecorded(journal)?.inputId ?? "unknown";
        heardRevision = latestRecorded(journal)?.sourceRevision ?? 0;
        resolution.onRestart(journal, scenario.delivery, event.kind === "agent.restarted");
        lastResolution = null;
        lastPlay = null;
        break;
      case "agent.crashed":
        running = false;
        receipts.clear();
        break;
      case "input.delivered": {
        const inputId = String(p.inputId);
        const source = spokenInputs.get(inputId);
        if (!source || p.sourceRevision !== source.sourceRevision || p.day !== source.day) {
          fail("input.origin", id, "The delivered input does not match the caller's day and source revision.", inputId, String(p.day), Number(p.sourceRevision));
        }
        if (!knownInputs.has(inputId) && Number(p.sourceRevision) < heardRevision) deliveredLate.add(inputId);
        knownInputs.add(inputId);
        if (Number(p.sourceRevision) > heardRevision) {
          resolution.onNewerDeliveredInput();
          lastResolution = null;
          heard = String(p.day);
          heardId = inputId;
          heardRevision = Number(p.sourceRevision);
        }
        break;
      }
      case "store.committed": {
        storeResults.set(id, p);
        const next = object(p.snapshot);
        const activeInput = latestRecorded(next);
        if (Number(p.epoch) !== epoch || Number(p.revision) !== revision + 1 ||
            (p.expectedRevision !== undefined && p.expectedRevision !== revision)) {
          fail("store.epoch", id, "A stale-epoch or stale-revision write changed the durable journal.", activeInput?.inputId ?? "unknown", String(next.operationKey ?? "none"), Number(p.epoch), epoch);
        }
        const previousIds = ids(journal);
        const nextIds = ids(next);
        const added = nextIds.filter(inputId => !previousIds.includes(inputId));
        if (previousIds.some(inputId => !nextIds.includes(inputId)) || new Set(nextIds).size !== nextIds.length ||
            (previousIds.length && !added.length && journal.intentRevision !== next.intentRevision)) {
          const affected = previousIds.find(inputId => !nextIds.includes(inputId)) ??
            nextIds.find((inputId, index) => nextIds.indexOf(inputId) !== index) ?? activeInput?.inputId;
          fail("input.deduplicated", id, "A duplicate input changed its revision or an earlier receipt was lost.", affected ?? "unknown", String(next.day), Number(next.intentRevision));
        }
        const previous = latestRecorded(journal);
        if (activeInput && (next.day !== activeInput.day || (next.latestInputId !== undefined && next.latestInputId !== activeInput.inputId) ||
            (next.sourceRevision !== undefined && next.sourceRevision !== activeInput.sourceRevision))) {
          fail("input.latest-durable", id, "The journal's active intent does not match its newest recorded source revision.",
            activeInput.inputId, activeInput.day, String(next.day), activeInput.sourceRevision);
        }
        if (added.length && previous && activeInput?.inputId === previous.inputId &&
            ["intentRevision", "day", "operationKey", "createKey", "createDay"].some(key => next[key] !== journal[key])) {
          fail("input.stale-receipt", id, "Recording an older input changed the active intent or its operation.", previous.inputId, previous.day, ...added);
        }
        const inputReceipts = new Map(Array.isArray(next.receipts)
          ? next.receipts.map(value => { const receipt = object(value); return [String(receipt.inputId), receipt] as const; })
          : []);
        for (const inputId of nextIds) {
          const source = spokenInputs.get(inputId);
          if (!knownInputs.has(inputId)) {
            fail("input.observed", id, "The journal contains an input the process never received or recovered.", inputId, String(next.day));
            continue;
          }
          if (added.includes(inputId) && (deliveredLate.has(inputId) || (source && previous && source.sourceRevision < previous.sourceRevision))) {
            retiredReceipts.add(inputId);
          }
          const receipt = inputReceipts.get(inputId);
          const matches = receipt && source && receipt.day === source.day && receipt.sourceRevision === source.sourceRevision;
          const legacy = next.receipts === undefined && !retiredReceipts.has(inputId) && next.day === source?.day;
          if ((matches || legacy) && Number(next.intentRevision) > 0) {
            durableInputs.add(inputId);
          } else if (retiredReceipts.has(inputId) && durableInputs.delete(inputId)) {
            fail("input.durable-receipt", id, "A previously durable out-of-order receipt disappeared or changed.", inputId,
              String(source?.day), activeInput?.inputId ?? "unknown");
          }
        }
        if (activeInput && durableInputs.has(activeInput.inputId) && knownInputs.has(activeInput.inputId) &&
            next.day === activeInput.day && next.createDay === activeInput.day && typeof next.createKey === "string" &&
            !createIntents.has(next.createKey)) {
          createIntents.set(next.createKey, { input: activeInput, epoch });
        }
        persistedBookingId = typeof next.bookingId === "string" && learnedBookings.has(next.bookingId) &&
          bookingCreateKeys.get(next.bookingId) === next.createKey ? next.bookingId : null;
        journal = next;
        revision = Number(p.revision);
        break;
      }
      case "store.rejected":
        storeResults.set(id, p);
        break;
      case "store.ackDelivered":
      case "reply.delivered":
      case "input.ackRequested":
        if (!running || p.epoch !== epoch) {
          fail("epoch.delivery", id, "An agent received or emitted an event outside its active epoch.", event.kind,
            String(p.inputId ?? operation.key ?? latestRecorded(object(p.snapshot))?.inputId ?? "unknown"), Number(p.epoch), epoch);
        }
        if (event.kind === "store.ackDelivered") {
          const source = storeResults.get(event.parents[0] ?? "");
          if (!source || !["epoch", "requestId", "accepted", "expectedRevision", "revision"].every(key => p[key] === source[key]) ||
              !isDeepStrictEqual(p.snapshot, source.snapshot)) {
            fail("store.ack-origin", id, "The delivered write acknowledgement does not match the observed journal decision.",
              latestRecorded(object(p.snapshot))?.inputId ?? "unknown", String(object(p.snapshot).operationKey ?? "none"), Number(p.revision), Number(p.epoch));
          } else if (p.accepted === true && running && p.epoch === epoch && Number(p.revision) > knownRevision) {
            knownJournal = object(p.snapshot);
            knownRevision = Number(p.revision);
          }
        }
        if (event.kind === "input.ackRequested" && (!durableInputs.has(String(p.inputId)) || !ids(journal).includes(String(p.inputId)))) {
          fail("input.durable-ack", id, `Input ${p.inputId} was acknowledged before its ID, day and revision were durable.`, String(p.inputId), String(spokenInputs.get(String(p.inputId))?.day));
        }
        if (event.kind === "reply.delivered") {
          const source = providerResults.get(event.parents[0] ?? "");
          if (!source || !["attemptId", "epoch", "requestId", "day", "bookingId", "outcome", "failure"].every(k => source.payload[k] === p[k]) ||
              !isDeepStrictEqual(source.payload.operation, operation)) {
            fail("reply.origin", id, "Delivered result differs from its provider observation.", String(operation.kind), String(operation.key), String(p.bookingId), String(p.day));
          } else if (running && p.epoch === epoch && typeof p.bookingId === "string" && typeof p.day === "string" &&
                     (p.outcome === "committed" || p.outcome === "found")) {
            learnedBookings.add(p.bookingId);
            if ((receipts.get(p.bookingId)?.version ?? -1) <= source.version) {
              receipts.set(p.bookingId, { day: p.day, version: source.version });
            }
          } else if (p.failure === "precommit" && p.outcome === "rejected" && operation.kind === "create" && originalCreate?.key === operation.key) {
            originalCreate = null;
          }
        }
        break;
      case "request.sent": {
        if (operation.kind !== "create" && operation.kind !== "amend") break;
        if (operation.kind === "create") {
          if (originalCreate && (!scenario.provider.idempotent || originalCreate.key !== operation.key || originalCreate.day !== operation.day)) {
            fail("recovery.blind-retry", id, "Repeated an unresolved create without the original idempotent key and contents.",
              heardId, originalCreate.key, originalCreate.day, String(operation.key), String(operation.day));
          }
          originalCreate ??= { key: String(operation.key), day: String(operation.day) };
        }
        const create = operation.kind === "create";
        const key = String(operation.key);
        const durable = [journal, knownJournal].every(saved => create
          ? saved.createKey === key && saved.createDay === operation.day
          : saved.operationKey === key && saved.day === operation.day);
        if (!durable) fail("dispatch.durable-key", id, "The dispatched operation key and day were not committed to the journal.",
          heardId, String(operation.kind), String(operation.key), String(operation.bookingId ?? "unassigned"), String(operation.day));
        const origin = createIntents.get(String(knownJournal.createKey));
        const intent = create ? origin?.input : latestRecorded(knownJournal);
        // A saved create may be retried with its original day following a
        // correction. A new amendment must target the currently wanted day.
        const historical = create && origin && (sentCreates.has(key) || epoch > origin.epoch);
        if (!intent || !durableInputs.has(intent.inputId) || !ids(knownJournal).includes(intent.inputId) ||
            !ids(journal).includes(intent.inputId) || intent.day !== operation.day || (!historical && intent.inputId !== heardId)) {
          fail("dispatch.intent", id, "The operation has no matching durable caller intent known to the issuing instance.",
            heardId, intent?.inputId ?? "unknown", String(operation.kind), key, String(operation.day));
        }
        if (create) sentCreates.add(key);
        else if (!origin || bookingCreateKeys.get(String(operation.bookingId)) !== knownJournal.createKey || !learnedBookings.has(String(operation.bookingId))) {
          fail("dispatch.booking", id, "The amendment requires a delivered or recovered provider identity for the booking created for this intent.",
            heardId, key, String(operation.bookingId), String(knownJournal.createKey ?? "unknown"));
        }
        break;
      }
      case "provider.committed":
      case "provider.reused":
      case "provider.queried":
      case "provider.failed": {
        if (event.kind === "provider.committed") providerVersion++;
        const version = event.kind === "provider.reused" ? committedKeys.get(String(operation.key)) ?? -1 : providerVersion;
        providerResults.set(id, { payload: p, version });
        if (event.kind !== "provider.committed") break;
        const bookingId = String(p.bookingId);
        const day = String(p.day);
        if (operation.kind === "create") bookingCreateKeys.set(bookingId, String(operation.key));
        if (operation.kind === "create" && bookings.size && !bookings.has(bookingId)) {
          fail("booking.unique", id, `Another create produced ${bookingId} while ${[...bookings.keys()].join(", ")} remained active.`,
            String(bookings.keys().next().value), bookingId, String(operation.key), day);
        }
        if (committedKeys.has(String(operation.key))) {
          fail("operation.once", id, "The provider committed the same logical operation more than once.", String(operation.kind), String(operation.key), bookingId, day);
        }
        committedKeys.set(String(operation.key), version);
        bookings.set(bookingId, day);
        break;
      }
      case "transport.duplicated": {
        if (p.channel === "providerReply") {
          const source = providerResults.get(event.parents[0] ?? "");
          if (source) providerResults.set(id, source);
        } else if (p.channel === "storeAck") {
          const source = storeResults.get(event.parents[0] ?? "");
          if (source) storeResults.set(id, source);
        }
        break;
      }
      case "claim.emitted": {
        lastResolution = "claim";
        const bookingId = String(claim.bookingId);
        const day = String(claim.day);
        fragments.set(String(p.fragmentId), { generation: Number(p.generation), bookingId, day, inputId: heardId, queued: 0 });
        if (!running || p.epoch !== epoch || receipts.get(bookingId)?.day !== day) {
          fail("claim.supported", id, "The issuing instance lacks a delivered result supporting this confirmation.",
            heardId, bookingId, day, receipts.get(bookingId)?.day ?? "unknown");
        }
        if (heard !== day) fail("claim.latest", id, "The confirmation does not match the instance's latest caller intent.", heardId, bookingId, heard || "unknown", day);
        break;
      }
      case "device.queued": {
        const fragment = fragments.get(String(p.fragmentId));
        if (!fragment || fragment.day !== claim.day || fragment.bookingId !== claim.bookingId || fragment.generation !== p.generation) {
          fail("queue.emitted", id, "The queued fragment differs from the emitted claim.", fragment?.inputId ?? heardId, String(claim.bookingId), String(claim.day), Number(p.generation));
        } else fragment.queued++;
        break;
      }
      case "device.flushed":
        generationFloor = Math.max(generationFloor, Number(p.generation));
        break;
      case "device.playbackStarted": {
        const mark = { eventId: id, bookingId: String(claim.bookingId), day: String(claim.day), generation: Number(p.generation) };
        lastPlay = mark;
        report.played.push(mark);
        const fragment = fragments.get(String(p.fragmentId));
        if (!fragment?.queued || fragment.day !== mark.day || fragment.bookingId !== mark.bookingId || fragment.generation !== mark.generation) {
          fail("playback.queued", id, "Playback did not consume a matching queued fragment.", fragment?.inputId ?? heardId, mark.bookingId, mark.day, mark.generation);
        } else fragment.queued--;
        if (mark.generation < generationFloor) {
          fail("playback.generation", id, "A superseded fragment started after its generation was flushed.", fragment?.inputId ?? heardId, mark.bookingId, mark.generation, generationFloor, mark.day);
        }
        break;
      }
      case "agent.reviewRequested":
      case "agent.reconfirmRequested": {
        lastResolution = event.kind === "agent.reviewRequested" ? "review" : "reconfirm";
        const reason = String(p.reason ?? "");
        report[lastResolution] = { eventId: id, reason };
        if (!reason.trim()) fail("handoff.reason", id, "The request lacks an actionable reason.", lastResolution, heardId, heard);
        const supported = lastResolution === "review"
          ? resolution.canReview(scenario, journal, heardId, heard, receipts)
          : resolution.canReconfirm();
        if (!supported) {
          fail("handoff.supported", id, lastResolution === "review"
            ? "No unresolved operation, relevant rejection or unavailable amendment supports this handoff."
            : "No restarted single-delivery instance has an unresolved caller intent to reconfirm.", lastResolution, heardId, heard);
        }
        break;
      }
    }
  }
  report.bookings = Array.from(bookings, ([bookingId, day]) => ({ bookingId, day }));
  if (!quiescent) return report;
  const endId = events.at(-1)?.id ?? "terminal";
  const day = report.latestIntent?.day;
  const confirmed = !!day && lastResolution === "claim" && bookings.size === 1 &&
    lastPlay?.day === day && bookings.get(lastPlay.bookingId) === day;
  if (scenario.expectation === "confirmed" && !confirmed) {
    fail("progress.confirmed", endId, "Expected one booking for the latest caller intent and a matching confirmation at playback.",
      report.latestIntent?.inputId ?? "unknown", day ?? "unknown", lastResolution ?? "silent", lastPlay?.bookingId ?? "none", lastPlay?.day ?? "silent");
  } else if (scenario.expectation === "review" || scenario.expectation === "reconfirm") {
    if (lastResolution !== scenario.expectation) {
      fail(`progress.${scenario.expectation}`, endId, `Expected a reasoned ${scenario.expectation} outcome.`, report.latestIntent?.inputId ?? "unknown", day ?? "unknown", lastResolution ?? "silent");
    }
  } else if (scenario.expectation === "settled" && !confirmed && lastResolution !== "review" && lastResolution !== "reconfirm") {
    fail("progress.settled", endId, "Expected confirmed playback, human review or a request for reconfirmation.", report.latestIntent?.inputId ?? "unknown", day ?? "unknown", lastResolution ?? "silent");
  }
  return report;
}
