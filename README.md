# Turntrace

A caller asks for Tuesday, then changes the booking to Thursday. The agent says “Thursday” and the device starts playing that confirmation. Which day did the provider actually book?

Turntrace is a terminal debugger for that race. It runs a synthetic voice agent, booking provider and playback device on a virtual clock. Each decision has an event ID. A saved JSON trace lets a colleague reproduce the same decision and inspect the evidence available to the agent when it spoke.

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

## Replay or share a trace

The repository includes the failing case. This command should print `Verified replay of 12 choices`, show the failed check and exit with status **1**.

```sh
npm run replay -- examples/commit-first.buggy.json
```

To save and replay a passing case, choose a file in an existing directory. Export replaces that file when the run completes. These commands work in PowerShell and Bash.

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

`npm test` builds the TypeScript sources and runs scheduler, booking, verifier, replay and CLI regressions. The CLI test regenerates the checked-in failing trace byte for byte. CI runs that test on both Windows and Linux with Node 22.13.0 and 24.x.

V1 covers one caller, one stateful provider and two selected schedules. Input, replies, enqueueing and playback start are distinct observations. Playback is a device marker. Real audio, restarts, lost acknowledgements, persistent recovery and exhaustive schedule exploration are outside this demo. The simulation runs offline after dependencies are installed. [Architecture and evidence boundaries](docs/architecture.md)
