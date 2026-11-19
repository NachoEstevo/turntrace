# Turntrace

A caller asks for Tuesday, then changes the booking to Thursday. The agent says “Thursday” and the device starts playing that confirmation. Which day did the provider actually book?

Turntrace is a terminal debugger for that race. It runs a synthetic voice agent, booking provider and playback device on a virtual clock. Each decision has an event ID. A saved JSON trace lets a colleague reproduce the same decision and inspect the evidence available to the agent when it spoke.

The commands below use a built checkout. You can also install the v0.2.0 private tarball and use `npm exec --offline '--' turntrace` in place of `node dist/cli/index.js`. The installed fixtures are in `node_modules/turntrace/examples/`. [v0.2.0 release](https://github.com/NachoEstevo/turntrace/releases/tag/v0.2.0) · [Installation guide](docs/distribution.md)

## Find the first wrong decision

The bundled customer-service adapter requests a Tuesday reservation. The provider commits it and its reply gets lost. When a Thursday correction and the agent's review timer become eligible together, their order determines what the agent tells the caller. From a checkout, run `npm ci` and `npm run build`, then explore both orders.

```sh
node dist/cli/index.js explore examples/lab/customer-race.json --adapter examples/lab/customer-agent.mjs --max-runs 8 --out-dir histories
node dist/cli/index.js compare histories/history-00002.json histories/history-00001.json --adapter examples/lab/customer-agent.mjs --out-dir diagnosis
node dist/cli/index.js replay diagnosis/left.json --adapter examples/lab/customer-agent.mjs
node dist/cli/index.js replay diagnosis/right.json --adapter examples/lab/customer-agent.mjs
```

The campaign finds two terminal histories and exits 1. At tick 10, history 2 runs the review timer first. The agent opens a manual review and adds the Thursday correction when it arrives. History 1 delivers Thursday first. When its timer fires, the agent confirms a Thursday reservation without a receipt. The first finding is `claim.supported` at tick 10. The device starts playing that confirmation at tick 12. The provider holds Tuesday in both histories. [Scenario](examples/lab/customer-race.json) · [Adapter](examples/lab/customer-agent.mjs)

`compare` replays both input traces. The first scheduling difference can be harmless. To isolate the difference that changed the outcome, the command generates two witnesses with the same prefix, runs two eligible actions in opposite orders and applies the same deterministic scheduling rule afterward. Here that swap reproduces the passing result on the left and the exact first finding on the right. The comparison exits 0. Replaying its witnesses exits 0 and 1 respectively. Use a new directory for each command that writes files. For other agents, `--observation NAME` targets a difference in a recorded decision. [Comparison options and evidence](docs/acceptance.md#compare-two-histories)

For a smaller built-in example, replay the [saved failure](examples/lab/premature-ack.trace.json). The agent acknowledged a caller input before its receipt was durable. To see which perturbations the reducer can remove, run the original case and compare the files.

```sh
node dist/cli/index.js replay examples/lab/premature-ack.trace.json
node dist/cli/index.js run examples/lab/reduce.json --out full.json
node dist/cli/index.js minimize full.json --out smaller.json
node dist/cli/index.js replay smaller.json
```

All four commands return 1. The first finding in both generated histories is `input.durable-ack` for the same input. The reducer removes optional groups and actions, reruns the scenario and verifies the retained history by replay. It keeps the original file. `--max-attempts` and `--max-milliseconds` bound its search. The time budget is checked between attempts. Use fresh filenames and a new directory each time.

## Explore a scenario

`run` chooses one history. `explore` enumerates the eligible choices in a fresh world for each branch. Scripted events can inject a crash, restart, lost reply, duplicate or delayed delivery. Set `--max-runs`, `--max-steps`, `--max-decisions`, `--max-restarts` and `--max-duplicates` to bound the campaign. Its report counts terminal, blocked and truncated histories, observed violations and pending prefixes. A terminal history can contain a property violation.

```sh
node dist/cli/index.js explore examples/lab/commit-race.json --max-runs 200 --json
node dist/cli/index.js explore examples/lab/recovery.json --seed 73 --samples 20 --max-runs 20 --profile --json
node dist/cli/index.js schema scenario
node dist/cli/index.js schema command
node dist/cli/index.js schema trace
node dist/cli/index.js schema campaign
```

The second command takes a reproducible sample. Its coverage remains `sampled` even when every selected history passes. `--profile` writes elapsed time, CPU time, peak process memory, platform and budgets to stderr. Machine-readable results go to stdout. Save a witness with `--out`. Add `--out-dir` to write each history as it finishes. The final `index.json` records their filenames, digests, statuses and the selected witness. If the process stops early, completed history files remain replayable and a missing index identifies an interrupted campaign.

Third-party policies can receive domain-specific `signal` actions and return structured `observe` commands. With `expectation: "observe"`, consumers check their own decisions against the signals actually delivered before each decision. The guide works through a handoff caused by uncertain availability, including a premature handoff that a consumer assertion catches. [Adapter contract and worked example](docs/adapter.md#check-a-handoff-before-a-reservation-exists) · [Scenario catalogue and acceptance tests](docs/acceptance.md)

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
| 0 | The selected histories passed. For `compare`, the command isolated the target difference or found the selected target equal. Help and schema output also return 0. |
| 1 | An observed property violation, including a verified replay or reduction of a failing case. This takes precedence over an unfinished branch or campaign. |
| 2 | The CLI could not run or verify the case. Examples include a missing file, an incompatible build, a disabled choice and an observation that differs during replay. |
| 3 | The requested exploration is inconclusive. For `compare`, the two verified inputs are incompatible or the search could not isolate the target within its limits. |

## Tests and scope

```sh
npm test
node dist/cli/index.js --help
```

`npm test` builds the TypeScript sources and runs scheduler, actor, policy, verifier, replay, reduction and CLI regressions. These include independent enumeration of small graphs, provider capability combinations and deliberately faulty agents. The original schema 1 booking trace and schema 2 recovery trace retain their recorded identities. Scenario-driven runs use trace schema 3.

The two historical demos use fixed schedules. The scenario lab explores interleavings of explicitly modeled actions on an integer virtual clock. The journal survives an agent restart in simulated storage. The device records structured playback and flush markers. Physical storage failures, real provider behavior and what a caller heard require separate integration measurements. The examples use synthetic data and run offline after dependencies are installed. [Architecture and evidence boundaries](docs/architecture.md)
