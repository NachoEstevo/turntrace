# Turntrace

A caller asks for Tuesday, then changes the booking to Thursday. The agent says “Thursday” and the device starts playing that confirmation. Which day did the provider actually book?

Turntrace is a terminal debugger for that race. It runs a synthetic voice agent, booking provider and playback device on a virtual clock. Each decision has an event ID. A saved JSON trace lets a colleague reproduce the same decision and inspect the evidence available to the agent when it spoke.

The [recovery demo](#recover-after-a-lost-acknowledgement) starts with a different question. A provider committed a booking, its acknowledgement was lost and the agent restarted. Can the new instance safely tell the caller that the booking exists?

## Run the demo

Use Node.js 22.13.0 or later in the 22.x line, or Node.js 24.x, with npm. From the repository root in PowerShell or a Linux shell, run these commands on separate lines.

```sh
npm ci
npm run build
npm run demo
```

```text
Delivery order     Policy  Agent said  Device played  Provider booked  Check
correction-first   buggy   Thursday    Thursday       Thursday         PASS
correction-first   fixed   Thursday    Thursday       Thursday         PASS
commit-first       buggy   Thursday    Thursday       Tuesday          FAIL
commit-first       fixed   Thursday    Thursday       Thursday         PASS
```

Both orders start with the same pending Tuesday request. In `correction-first`, the provider accepts the Thursday revision while the request is pending and commits Thursday. In `commit-first`, it commits Tuesday before the correction reaches the agent. In both runs, the agent receives the correction before the create acknowledgement.

In the failing timeline, the provider rejects the attempted revision at `provider.revise`. The agent receives the rejection at `reply.revise`, treats it as success and emits a Thursday confirmation at `agent.confirm`. The independent checker flags that last event first. The only commitment the agent had received (`reply.create`) was for Tuesday. The device subsequently starts Thursday playback at `device.play`, while the provider still holds Tuesday.

To see the fix under the same order, run the following command. Look for `request.amend`, `provider.amend` and `reply.amend`. The policy changes the existing reservation and waits for the Thursday commitment to reach the agent before speaking.

```sh
node dist/cli/index.js demo --order commit-first --policy fixed
```

## Recover after a lost acknowledgement

After `npm ci` and `npm run build`, run both providers with the safe policy.

```sh
npm run recovery
```

The caller requests Thursday once. The first agent stores the intent and operation key, waits for the store acknowledgement and sends the create request. The provider commits the reservation. The transport drops the acknowledgement before delivery, then the simulator destroys the agent instance. The provider keeps its booking and the agent's separate store keeps its journal. The new instance starts with the journal and has received no provider receipt.

| Provider and policy | What the restarted agent does | Observable outcome |
| --- | --- | --- |
| `idempotent`, `safe` | Sends a new attempt with the stored operation key. The provider returns the original receipt. | One booking. The agent receives the receipt, confirms Thursday and the device starts playback. |
| `opaque`, `safe` | Records the outcome as unknown and requests human review. This provider supports neither lookup nor deduplication. | One booking in the provider's ledger. The agent sends no second create request and makes no booking confirmation. |
| Either provider, `blind-retry` | Generates a new operation key after restart and sends another create request. | Two bookings for one intent. Even an idempotent provider treats the new key as a separate operation. The checker reports the violation. |

The first command shows the full handoff timeline. The second shows the faulty policy creating a duplicate with the idempotent provider.

```sh
node dist/cli/index.js recovery --provider opaque
node dist/cli/index.js recovery --provider idempotent --policy blind-retry
```

`unknown` with a recorded handoff is a passing outcome for the safe opaque case. A booking visible to the verifier is only evidence for the agent if the provider's result reaches that instance.

## Replay or share a trace

The repository includes the failing case. This command should print `Verified replay of 12 choices`, show the failed check and exit with status **1**.

```sh
npm run replay -- examples/commit-first.buggy.json
```

The same replay command accepts the recovery example and returns **0**. To capture a different recovery case, select a provider and write to a new file.

```sh
npm run replay -- examples/recovery.idempotent.json
node dist/cli/index.js recovery --provider opaque --out opaque.json
node dist/cli/index.js replay opaque.json
```

To save and replay a passing case, choose a new filename in an existing directory. If that path already exists, the CLI preserves the file and exits with status 2. These commands work in PowerShell and Bash.

```sh
node dist/cli/index.js demo --order commit-first --policy fixed --out thursday.json
node dist/cli/index.js replay thursday.json
```

The file contains the scenario, policy, schedule, ordered action IDs, observed events, check results and SHA-256 digests. Replay checks the compiled implementation fingerprint, builds a fresh world, executes each recorded choice and checks that the choices match the named schedule. It compares each observed event and the recomputed report with the saved values. Editing a commitment or a verdict is detected even if the editor recalculates the JSON digest. Object-key order and formatting may change. The digest identifies content. Anyone with the implementation can produce another valid run.

| Exit code | Meaning |
| --- | --- |
| 0 | All selected booking checks passed, or help was displayed. |
| 1 | At least one booking check failed. This is expected for the full demo and for a verified replay of the buggy `commit-first` case. |
| 2 | The CLI could not run or verify the case. Examples include a missing file, an incompatible build, a disabled choice and an observation that differs during replay. |

## Tests and scope

```sh
npm test
node dist/cli/index.js --help
```

`npm test` builds the TypeScript sources and runs scheduler, booking, recovery, verifier, replay and CLI regressions. CI checks the original schema 1 booking trace and the schema 2 recovery example on Windows and Linux with Node 22.13.0 and 24.x.

The booking-race fixture covers two selected schedules. The recovery fixture fixes one crash after a committed create and a lost reply, and varies provider capabilities and agent policy. Each run starts with a new world. The journal survives a simulated agent restart in memory. Crashes of the CLI or disk, further crash points, repeated losses, exhaustive exploration and real audio are outside these fixtures. Device playback is a start marker. Both simulations run offline after dependencies are installed. [Architecture and evidence boundaries](docs/architecture.md)
