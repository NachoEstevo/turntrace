# Writing a cooperative adapter

A Turntrace adapter owns one agent's decisions. The lab delivers inputs, applies the agent's commands and records the results. This boundary lets a report distinguish a provider commit from a delivered reply, an emitted confirmation and the device's playback start.

## Run the external example

The customer desk example contains its own policy. It sets a deadline when it sends a create request. If a correction arrives while the create is outstanding, one deadline branch treats the offered replacement as a confirmed booking. Run the exploration from a built checkout to expose the unsupported claim.

```sh
node dist/cli/index.js explore examples/lab/customer-race.json --adapter examples/lab/customer-agent.mjs --max-runs 200
```

The example explores two terminal histories. One violates `claim.supported` and the command exits with status 1. An installed package exposes the same commands through `turntrace`. Pass a path to a trusted adapter on each external run and replay. The trace contains the adapter identity and digest. Select `--adapter` from your own checkout or installation. [Example scenario](../examples/lab/customer-race.json) · [Example adapter](../examples/lab/customer-agent.mjs)

## Hooks and state

Export a default object from a UTF-8 `.mjs` file. Set its `id` to the scenario's `policy` and its `version` to the adapter release. Static imports may reference relative `.mjs` modules within the entry file's directory tree. Keep all decisions synchronous. Timers, provider operations, storage and playback must yield to the lab through commands. A module-level variable outlives an agent epoch, so keep per-instance state in the value returned by `init` and `step`.

The loader fingerprints the captured static module graph, the nearest ancestor `package-lock.json` when present, and the exact Node version. Replay requires the same fingerprint and an explicit adapter path. Adapters execute as trusted Node code.

| Hook | Inputs | Return value |
| --- | --- | --- |
| `init(context)` | The current `epoch`, durable store `revision`, a copy of the last `snapshot` or `null`, provider capabilities, and caller `delivery` mode. Epochs start at 1. | Fresh volatile state. |
| `step(state, input)` | The current volatile state and one delivered event. | An object with `next` and an array of `commands`. An empty array emits no effects. |

The lab delivers `start` after each initialization. Other deliveries carry a caller `input`, a domain `signal`, a `store-ack` with its request ID, acceptance and revision, a `provider-reply`, a `timer` with its ID, or `end-call`. Each caller input includes `inputId`, `day` and `sourceRevision`. The caller assigns revisions starting at 1 in utterance order. Copies and redeliveries preserve the original ID and revision. [Public types and validators](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/src/lab/contract.ts)

A provider reply includes its request ID, operation, outcome, booking ID and day. Outcomes are `committed`, `found`, `missing` and `rejected`. Booking ID and day may be null. A delivered `failure: "precommit"` identifies a failure prior to the commitment. Correlate a reply with the outstanding request before acting on it. A commit in the diagnostic trace is visible to the checker even when its reply never reached the agent.

For booking scenarios, the checker ties each mutation to a durable caller input that the agent received or recovered. An amendment also needs the provider's booking ID. When a mutation's result is ambiguous, a reasoned review can resolve the case. A correction that arrives after the handoff needs its own resolution, such as an update to the open review. A restarted agent on a single-delivery channel can ask for reconfirmation because a newer input may have been lost.

## Effect commands

| Kind | Fields | Effect |
| --- | --- | --- |
| `store` | `requestId`, `expectedRevision`, `snapshot` | Submit an atomic write for this epoch. One write may be pending per instance. Wait for its accepted `store-ack` before sending an operation that relies on it. |
| `input-ack` | `inputId` | Acknowledge one logical caller input. The recoverable caller retains it until acknowledgement arrives. |
| `provider` | `requestId`, `operation` | Issue a transport attempt. Create takes `{kind:"create",key,day}`. Amend takes `{kind:"amend",key,bookingId,day}`. Query takes `{kind:"query",key}` with the original create key. |
| `speech` | `generation`, `claim:{bookingId,day}` | Emit a confirmation. Network arrival, queueing and playback follow as separate actions. |
| `flush` | `generation` | Request a device floor for future playback. An older fragment already playing when the flush arrives is recorded as a remnant. |
| `timer` | `timerId`, `delayTicks` | Release a virtual timer for this epoch. |
| `review` or `reconfirm` | `reason` | Request human review of an unresolved booking or ask the caller to reconfirm after possible input loss. The lab checks the booking evidence. |
| `observe` | `name`, `data` | Record an adapter-owned diagnostic result. The agent chooses the name and JSON object payload. |

Each retry gets its own transport request ID. Retrying the same idempotent operation uses the same key and content. An amendment is a distinct operation. Emitting two commands in one step can put both in transit. Use an acknowledgement to establish a required dependency.

The store accepts JSON objects. To evaluate the public booking properties, the checker reads the durable fields below. Adapters can persist additional JSON fields for their own state.

- `inputIds`, `intentRevision` and `day` record the processed logical inputs, their positive revision and the current intent. Persist the corrected day and the receipt together before acknowledging the input.
- With reordered deliveries, the built-in journal tracks `latestInputId`, `sourceRevision` and per-input `receipts` containing `{inputId,day,sourceRevision}`. If Thursday arrives before an older Tuesday input, retire and acknowledge Tuesday under its own durable receipt. Keep Thursday as the latest intent. The store revision can advance for that receipt while the latest intent revision stays the same.
- `createKey` and `createDay` identify the original create. They allow an idempotent retry to send the original payload even after a correction.
- `operationKey` identifies the operation for the current intent. Before modifying a booking, persist its amendment key and intended day. [Built-in booking policy](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/src/lab/policy.ts)

## Scenario files

Scenario schema version 1 takes an `id`, three independent provider flags (`idempotent`, `query`, `amend`), a caller `delivery` mode, a terminal `expectation` and an `actions` array. The default `policy` is `safe`. Choose `recoverable` for redelivery of retained inputs after restart. Choose `once` to exercise a correction that may be lost before persistence. The terminal expectation can require confirmed playback (`confirmed`), a reasoned handoff (`review`), or reconfirmation (`reconfirm`). Use `settled` when any of those outcomes satisfies the progress requirement.

For a policy with its own domain vocabulary, script `signal` actions. Each carries a name and a JSON object. At its scheduled tick the world records `scenario.signal` and synchronously delivers `{kind:"signal",name,data}` to the active instance, recording `agent.signalDelivered`. While the agent is down, the world records `transport.signalUndelivered`. The adapter may return an `observe` command to expose a structured decision as `agent.observed`. With `expectation:"observe"`, PASS means the run reached a terminal state and passed the lab's applicable safety checks. Evaluating whether the policy made the right domain decision requires a consumer assertion over those observations.

### Check a handoff before a reservation exists

Suppose a policy receives approval (A), a request to prepare a calendar operation (P) and an independent availability update (U) carrying `{status:"uncertain"}`. The scenario requires A before P. Call the consumer's decision function on each delivered signal. Map its actual result to an `observe` command and include the request ID, the returned route and the number of plans it produced. Preserve the distinction between a prepared calendar operation and a provider commit. The built-in `review` command covers a different decision, the handoff of an unresolved booking. Its `handoff.supported` evidence check also runs under `expectation:"observe"`.

| Delivered order | Expected decision at P | Prepared plans |
| --- | --- | --- |
| A, P, U | Prepare | 1 |
| A, U, P | Handoff | 0 |
| U, A, P | Handoff | 0 |

Explore with `--out-dir` and replay each history with the same adapter. In a consumer assertion, scan the replayed events in order. At the decision, use the latest availability update among earlier `agent.signalDelivered` events for that request in the issuing epoch. A handoff needs a current uncertain status. A later update can supersede that status. The scheduled tick and an adapter-authored reason cannot establish delivery. Also check that the emitted decision belongs to P and that its plan count matches the table. A policy that always hands off fails the first row even though all three lab histories can replay successfully.

Report this assertion alongside the lab verdict and save the history that failed it. The CLI's witness selection and reducer use built-in findings. A consumer can reproduce a domain assertion by replaying its selected archive file and running the assertion again. The executable regression covers all three orders and a premature handoff. [Consumer assertion and negative control](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/tests/lab-cli.test.ts)

Each scripted action names an ASCII `id`, a nonnegative integer `tick` and optional `parents`. Parents name other scripted actions. The parser checks for duplicate IDs, missing parents, cycles and a child tick earlier than its parent. Distinct actions can deliver the same logical `inputId` only with identical content. A reducer can remove actions marked `optional:true`. Use `group` to associate optional actions for a joint reduction attempt.

Use the CLI to print JSON Schema for editors and external tooling. The runtime also checks the relationships between actions.

```sh
turntrace schema scenario
turntrace schema command
turntrace schema trace
```

| Action | Additional fields | Meaning |
| --- | --- | --- |
| `input` | `inputId`, `day` | The caller requests `Tuesday` or `Thursday`. Transport delivers the input separately. |
| `signal` | `name`, optional `data` | Deliver a domain event immediately to the active instance. The default payload is an empty object. |
| `crash`, `restart`, `end-call` | — | Discard the live instance, recover from storage, or signal that the caller has left. Already-issued effects can still complete. |
| `drop-next`, `duplicate-next` | `channel` | Arm loss or duplication on the next transmission on that channel. |
| `delay-next` | `channel`, `delayTicks` | Add release delay to the next transmission on that channel. |
| `fail-next-provider` | — | Reject the next arriving provider operation before it changes provider state. |

Set `delays` by channel. The available names are `input`, `inputAck`, `store`, `storeAck`, `provider`, `providerReply`, `speech`, `playback` and `flush`. Each defaults to one tick. `fifo` lists the channels that preserve per-sender order and defaults to an empty list. `playbackTicks` gives the duration of a fragment after playback starts and defaults to two. All tick values are nonnegative safe integers. [Acceptance scenarios](acceptance.md)

This integration models the boundary where a policy receives messages and requests effects. Real SDK callback order, wall-clock deadlines and audio heard by a caller require separate measurements.
