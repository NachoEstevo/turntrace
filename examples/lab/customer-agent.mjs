// A synthetic customer-service adapter with a deliberate optimistic-confirmation bug.
// Its application state and decisions are independent of the built-in booking agent.
export default {
  id: "customer-desk",
  version: "1.0.0",

  init({ revision }) {
    return { phase: "new", revision, requestedDay: null, offeredDay: null };
  },

  step(state, input) {
    if (input.kind === "input" && state.phase === "new") {
      const snapshot = {
        inputIds: [input.inputId],
        intentRevision: 1,
        day: input.day,
        createDay: input.day,
        operationKey: "desk-create",
        createKey: "desk-create",
      };
      return {
        next: { ...state, phase: "saving", requestedDay: input.day },
        commands: [{ kind: "store", snapshot, requestId: "save-request", expectedRevision: state.revision }],
      };
    }
    if (input.kind === "store-ack" && input.accepted && state.phase === "saving") {
      return {
        next: { ...state, phase: "waiting", revision: input.revision },
        commands: [
          { kind: "provider", requestId: "desk-1", operation: { kind: "create", key: "desk-create", day: state.requestedDay } },
          { kind: "timer", timerId: "review-deadline", delayTicks: 7 },
        ],
      };
    }
    if (input.kind === "input" && state.phase === "waiting") {
      return { next: { ...state, offeredDay: input.day }, commands: [] };
    }
    if (input.kind === "input" && state.phase === "review") {
      const reason = `For the open review, the caller now wants ${input.day}. The provider has still not acknowledged the original ${state.requestedDay} request.`;
      return { next: { ...state, offeredDay: input.day }, commands: [{ kind: "review", reason }] };
    }
    if (input.kind === "provider-reply" && input.requestId === "desk-1" && input.outcome === "committed" && state.phase === "waiting") {
      return {
        next: { ...state, phase: "done" },
        commands: [{ kind: "speech", generation: 1, claim: { bookingId: input.bookingId, day: input.day } }],
      };
    }
    if (input.kind === "timer" && input.timerId === "review-deadline" && state.phase === "waiting") {
      // A replacement offer is only a caller preference. This branch treats it as a receipt.
      const command = state.offeredDay
        ? { kind: "speech", generation: 1, claim: { bookingId: "desk-provisional", day: state.offeredDay } }
        : { kind: "review", reason: "The create request has no receipt and this provider cannot look it up." };
      return { next: { ...state, phase: command.kind === "review" ? "review" : "done" }, commands: [command] };
    }
    return { next: state, commands: [] };
  },
};
