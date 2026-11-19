import type {
  AgentAdapter, AgentCommand, BookingOperation, Day, DeliveredEvent, JsonObject, RecoveryContext,
} from "./contract.js";

export const policyNames = ["safe", "premature-ack", "blind-retry", "stale-fragment", "always-handoff", "silent"] as const;
type Policy = typeof policyNames[number];
type Input = { inputId: string; day: Day; sourceRevision: number };
type Booking = { bookingId: string; day: Day };
type Journal = JsonObject & {
  inputIds: string[]; intentRevision: number; day: Day; createDay: Day; createKey: string; operationKey: string;
  latestInputId: string; sourceRevision: number; receipts: Input[];
};
type Pending = { requestId: string; operation: BookingOperation };
type State = {
  context: RecoveryContext; revision: number; journal: Journal | null; writing: { requestId: string; journal: Journal } | null;
  queue: Input[]; possibleCreate: boolean; booking: Booking | null; pending: Pending | null; outstanding: Pending[]; requestCount: number;
  forceAmend: boolean;
  recoveryAttempts: number; uncertain: boolean; stopped: boolean; spoken: number; generation: number;
};

function readJournal(snapshot: JsonObject | null): Journal | null {
  if (!snapshot) return null;
  if (!Array.isArray(snapshot.inputIds) || !snapshot.inputIds.length || !snapshot.inputIds.every(id => typeof id === "string") ||
      !Number.isSafeInteger(snapshot.intentRevision) || (snapshot.day !== "Tuesday" && snapshot.day !== "Thursday") ||
      (snapshot.createDay !== "Tuesday" && snapshot.createDay !== "Thursday") ||
      typeof snapshot.createKey !== "string" || typeof snapshot.operationKey !== "string") {
    throw new Error("The booking policy cannot recover this journal format.");
  }
  // The earlier in-order journal encoded the active intent as the last ID.
  const latestInputId = snapshot.latestInputId ?? snapshot.inputIds.at(-1);
  const sourceRevision = snapshot.sourceRevision ?? snapshot.intentRevision;
  if (typeof latestInputId !== "string" || typeof sourceRevision !== "number" || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
    throw new Error("The booking journal has no valid source revision.");
  }
  const receipts = snapshot.receipts ?? [{ inputId: latestInputId, day: snapshot.day, sourceRevision }];
  if (!Array.isArray(receipts)) throw new Error("The booking journal has no receipt list.");
  return { ...snapshot, latestInputId, sourceRevision, receipts } as Journal;
}

function init(context: RecoveryContext): State {
  const journal = readJournal(context.snapshot);
  return {
    context, revision: context.revision, journal, writing: null, queue: [], possibleCreate: !!journal, booking: null,
    pending: null, outstanding: [], requestCount: 0, recoveryAttempts: 0, uncertain: !!journal, stopped: false, spoken: 0, forceAmend: false,
    generation: journal?.sourceRevision ?? 0,
  };
}

function advance(policy: Policy, current: State, input: DeliveredEvent) {
  const state: State = { ...current, queue: [...current.queue], outstanding: [...current.outstanding] };
  const commands: AgentCommand[] = [];
  const { epoch, provider } = state.context;
  function stop(kind: "review" | "reconfirm", reason: string) {
    state.stopped = true;
    commands.push({ kind, reason });
  }
  function send(operation: BookingOperation) {
    const requestId = `request-${epoch}-${++state.requestCount}`;
    state.pending = { requestId, operation };
    state.outstanding.push(state.pending);
    if (operation.kind === "create") state.possibleCreate = true;
    commands.push({ kind: "provider", requestId, operation });
    commands.push({ kind: "timer", timerId: requestId, delayTicks: 12 });
  }
  function speak(booking: Booking) {
    commands.push({ kind: "speech", generation: state.generation, claim: booking });
    state.spoken = state.generation;
  }
  function write(next: Input) {
    const previous = state.journal;
    const inputIds = [...(previous?.inputIds ?? []), next.inputId];
    const receipts = [...(previous?.receipts ?? []), next];
    let journal: Journal;
    if (previous && next.sourceRevision < previous.sourceRevision) {
      journal = { ...previous, inputIds, receipts };
    } else {
      const intentRevision = next.sourceRevision;
      const createKey = state.possibleCreate && previous ? previous.createKey : `booking.create.${intentRevision}`;
      const createDay = state.possibleCreate && previous ? previous.createDay : next.day;
      const operationKey = state.possibleCreate ? `booking.amend.${intentRevision}` : createKey;
      journal = { inputIds, receipts, latestInputId: next.inputId, sourceRevision: next.sourceRevision,
        intentRevision, day: next.day, createKey, createDay, operationKey };
    }
    const requestId = `write-${epoch}-${next.sourceRevision}`;
    state.writing = { requestId, journal };
    commands.push({ kind: "store", requestId, expectedRevision: state.revision, snapshot: journal });
  }
  function act() {
    if (state.writing) return;
    const next = state.queue.shift();
    if (next) { write(next); return; }
    const journal = state.journal;
    if (state.stopped || !journal || state.pending) return;
    if (policy === "always-handoff") { stop("review", "Policy routes every booking to a human."); return; }
    if (state.uncertain) {
      state.uncertain = false;
      if (++state.recoveryAttempts > 3) { stop("review", "The provider did not resolve the outstanding operation."); return; }
      if (policy === "blind-retry") {
        send({ kind: "create", key: `retry.${epoch}.${state.requestCount + 1}`, day: journal.day });
      } else if (provider.query) {
        send({ kind: "query", key: journal.createKey });
      } else if (provider.idempotent) {
        // A replayed create receipt describes the original commitment. An
        // amendment at this key can safely establish the saved intent again.
        state.forceAmend = journal.operationKey !== journal.createKey;
        send({ kind: "create", key: journal.createKey, day: journal.createDay });
      } else {
        stop("review", "A prior create may have committed and this provider cannot resolve it safely.");
      }
      return;
    }
    if (!state.booking) {
      send({ kind: "create", key: journal.createKey, day: journal.createDay });
    } else if (state.forceAmend || state.booking.day !== journal.day) {
      if (!provider.amend) { stop("review", "The provider cannot amend the existing booking."); return; }
      send({ kind: "amend", key: journal.operationKey, bookingId: state.booking.bookingId, day: journal.day });
    } else if (state.spoken !== state.generation && policy !== "silent") {
      speak(state.booking);
    }
  }

  switch (input.kind) {
    case "start":
      if (epoch > 1 && state.context.delivery === "once") {
        stop("reconfirm", "A single-delivery correction could have been lost. Please reconfirm the requested day.");
      }
      break;
    case "input": {
      if (state.journal?.inputIds.includes(input.inputId)) {
        commands.push({ kind: "input-ack", inputId: input.inputId });
        break;
      }
      if (state.writing?.journal.inputIds.includes(input.inputId) || state.queue.some(entry => entry.inputId === input.inputId)) break;
      state.queue.push({ inputId: input.inputId, day: input.day, sourceRevision: input.sourceRevision });
      if (input.sourceRevision > state.generation) {
        state.generation = input.sourceRevision;
        state.stopped = false;
        commands.push({ kind: "flush", generation: state.generation });
        if (policy === "stale-fragment" && state.booking && state.booking.day !== input.day) speak(state.booking);
      }
      if (policy === "premature-ack") commands.push({ kind: "input-ack", inputId: input.inputId });
      break;
    }
    case "store-ack": {
      const write = state.writing;
      if (!write || write.requestId !== input.requestId) break;
      state.writing = null;
      if (!input.accepted) { stop("review", "The journal rejected the booking intent."); break; }
      state.journal = write.journal;
      state.revision = input.revision;
      commands.push({ kind: "input-ack", inputId: write.journal.inputIds[write.journal.inputIds.length - 1]! });
      break;
    }
    case "provider-reply": {
      const index = state.outstanding.findIndex(attempt => attempt.requestId === input.requestId);
      if (index < 0) break;
      state.outstanding.splice(index, 1);
      const awaited = state.pending?.requestId === input.requestId;
      if (awaited) state.pending = null;
      if ((input.outcome === "committed" || input.outcome === "found") && input.bookingId && input.day) {
        if (!awaited && state.booking && input.day !== state.journal?.day) break;
        if (state.pending?.operation.kind === "query" || state.pending?.operation.kind === "create") state.pending = null;
        state.uncertain = false;
        state.stopped = false;
        state.recoveryAttempts = 0;
        if (input.operation.kind !== "create") state.forceAmend = false;
        state.booking = { bookingId: input.bookingId, day: input.day };
        if (policy === "stale-fragment" && state.journal?.day !== input.day) speak(state.booking);
      } else if (input.outcome === "rejected" && input.failure === "precommit" && !state.pending && !state.outstanding.length) {
        state.uncertain = false;
        state.stopped = false;
        if (++state.recoveryAttempts > 3) stop("review", "The provider repeatedly rejected the operation before commitment.");
      } else if (input.outcome === "missing" && provider.idempotent) {
        // Even an expired lookup can authorize retrying this same create
        // key. A newer positive result or live create takes precedence.
        if (!state.booking && state.pending?.operation.kind !== "create") {
          state.pending = null;
          state.uncertain = false;
          state.stopped = false;
        }
      } else if (!awaited) {
        break;
      } else if (input.outcome === "missing") {
        stop("review", "Lookup found no booking while a non-idempotent create could still be in flight.");
      } else {
        state.uncertain = true;
      }
      break;
    }
    case "timer":
      if (state.pending?.requestId === input.timerId) { state.pending = null; state.uncertain = true; }
      break;
    case "end-call":
      break;
  }
  act();
  return { next: state, commands };
}

export function builtinPolicy(id: string): AgentAdapter<State> {
  const policy = policyNames.find(name => name === id);
  if (!policy) throw new Error(`Unknown built-in policy '${id}'. Choose one of ${policyNames.join(", ")}.`);
  return { id: policy, version: "1", init, step: (state, input) => advance(policy, state, input) };
}
