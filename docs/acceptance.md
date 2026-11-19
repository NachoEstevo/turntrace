# Booking lab acceptance cases

The JSON files in `examples/lab` specify caller actions, provider capabilities, fault injections and virtual delivery delays. They contain synthetic requests for one booking. Each run starts with a new provider, device, journal and agent instance. The assertions below use the provider's commits, the agent's delivered inputs and the device's playback markers.

| Scenario | What to inspect |
| --- | --- |
| `correction.json` | One caller changes Tuesday to Thursday while the first create is in flight. Compare the days and booking IDs of the provider's commits and the last playback. |
| `recovery.json` | The provider's reply is dropped. Recovery must reconcile the durable correction against the existing reservation and confirm Thursday after receiving evidence. |
| `opaque.json` | A create commits, the reply is lost and the agent restarts. With lookup and deduplication unavailable, the agent records a reason for human review. |
| `epoch-race.json` | The agent has crashed. Its old write and the restart are enabled at tick 4. If the write wins, the new epoch sees revision 1. If restart wins, the store rejects the old epoch and the caller redelivers its input. |
| `commit-race.json` | The agent has crashed with a create in flight. The provider commit and the restart are enabled at tick 7. Either order yields one booking. The recovering instance queries it and obtains its own receipt. |
| `once-loss.json` | The Thursday correction reaches the first instance. Its journal write arrives after restart and is rejected. The new instance asks for reconfirmation. |
| `redelivery.json` | The caller loses the acknowledgement for its Thursday correction. Redelivery uses the same input ID after restart. Count the durable intent revisions and commitments for Thursday. |
| `device-flush.json` | The Tuesday speech fragment is delayed in transit. The device applies the Thursday generation before the old fragment arrives. Only the admissible generation may start playback. |
| `post-end.json` | The caller ends the call after dispatch. The provider still commits the in-flight create while the world drains. |
| `reduce.json` | A faulty agent acknowledges the caller before storing the request. Three optional perturbations can be removed while preserving that first violation. |
| `customer-race.json` and `customer-agent.mjs` | A separately authored adapter races a correction against a review deadline. The opaque provider has already committed Tuesday and the receipt was dropped. |

## Reproduce the external agent decision

From a checkout, run `npm ci` and `npm run build` once. Use a new output filename for each trace. The adapter is a local ES module that you explicitly select. Its decision code imports no Turntrace implementation.

```sh
node dist/cli/index.js run examples/lab/customer-race.json --adapter examples/lab/customer-agent.mjs --out customer.json
node dist/cli/index.js replay customer.json --adapter examples/lab/customer-agent.mjs
```

The adapter saves Tuesday and sends a create request. It arms a review timer while it waits for the receipt. The default run delivers a Thursday correction before the deadline. The adapter treats the caller's preference as a booked replacement, so the checker flags `claim.supported` at the emitted claim. Both commands return 1.

After installation, use the installed `turntrace` executable in place of `node dist/cli/index.js`. You can copy the scenario and adapter into your own project and generate a fresh trace there. For replay in another workspace, reproduce the adapter's source files, Node version and nearest `package-lock.json` (including its absence), then supply the adapter path explicitly. [Adapter guide](adapter.md)

## Compare two histories

Run these commands on separate lines with fresh directory names. The first saves both orders of the customer race. The second asks which ordering change reproduces the difference between history 2 (PASS) and history 1 (FAIL).

```sh
node dist/cli/index.js explore examples/lab/customer-race.json --adapter examples/lab/customer-agent.mjs --max-runs 8 --out-dir customer-histories
node dist/cli/index.js compare customer-histories/history-00002.json customer-histories/history-00001.json --adapter examples/lab/customer-agent.mjs --out-dir customer-diagnosis
node dist/cli/index.js replay customer-diagnosis/left.json --adapter examples/lab/customer-agent.mjs
node dist/cli/index.js replay customer-diagnosis/right.json --adapter examples/lab/customer-agent.mjs
```

At tick 4 the provider books Tuesday and at tick 5 the transport drops the receipt. Both inputs share those facts. Their tenth scheduling choice is the first difference. At tick 10, both the review deadline and the Thursday delivery are eligible. The comparison reports `ISOLATED` after testing one pair. At the deadline, the agent's most recently delivered caller input is Tuesday on the left and Thursday on the right.

| Order at tick 10 | Agent decision | Later evidence |
| --- | --- | --- |
| Deadline, Thursday delivery | Opens a review for the missing receipt, then updates it with Thursday. | The device plays no confirmation. The provider holds Tuesday. |
| Thursday delivery, deadline | Emits a claim for `desk-provisional` on Thursday. Its first finding is `claim.supported`. | Playback starts at tick 12. The provider holds Tuesday. |

To exercise an earlier harmless difference, the regression adds two signals, `a` and `b`, that the adapter ignores. It compares `a, b, Thursday, deadline` with `b, a, deadline, Thursday`. The first difference is the choice between the signals. The isolated pair is still Thursday delivery and deadline. For a passing control, the first two enumerated histories of `correction.json` swap a caller acknowledgement with the provider's amendment at tick 7. Both confirm and play the same Thursday booking. [Comparison regression](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/tests/contrast.test.ts)

### Select a target and read the result

```text
turntrace compare <left.json> <right.json> [--adapter <trusted.mjs>] [--left-adapter <path> --right-adapter <path>] [--observation NAME] [--max-pairs N] [--out-dir <new-directory>] [--json]
```

Use two terminal schema 3 histories with matching manifests and execution limits. Each input must replay under its recorded implementation, scenario and adapter fingerprint. Choose either `--adapter` for a shared module or the separate adapter flags for matching copies at different paths. `--json` prints a machine-readable comparison.

By default, isolation requires one witness to pass and the other to reproduce the failing input's **exact first finding signature**. With `--observation NAME`, each trace must contain exactly one `agent.observed` of that name. The two events must have the same event ID, parents and agent epoch. Different `data` values give the search a target. Equal values mean these two inputs agree on that observation. An absent, repeated or uncorrelated observation makes the comparison inconclusive. An independent consumer assertion determines whether either value is correct for its domain. [Signals, observations and consumer assertions](adapter.md#check-a-handoff-before-a-reservation-exists)

The first changed choice is a lead. To isolate a difference, Turntrace tests a pair of eligible actions after the same prefix. One witness runs A then B, the other B then A. Both orders must be legal, and both witnesses use the same deterministic rule for subsequent choices. The rule selects by action ID among eligible actions at the earliest tick. Later choices can differ as the agent issues different commands. The two witnesses must reproduce the selected outcomes. This demonstrates the swap's effect for that prefix and continuation. Explaining the adapter's internal reasoning requires its observations or its code.

`--max-pairs N` bounds the search to N candidate pairs (default 64). With `--out-dir`, an isolated result writes two replayable witnesses, `left.json` and `right.json`, alongside `comparison.json`. Other completed comparisons write only `comparison.json`. The commands above return 1, 0, 0 and 1 in order.

| Comparison exit | Meaning |
| --- | --- |
| 0 | The search isolated the target difference, or the two inputs agree on the selected target. |
| 3 | The verified inputs are incompatible, the requested observations cannot be paired, or the bounded search is inconclusive. |
| 2 | Arguments or files are invalid, or an input failed replay verification. |

## Verify a consumer's signal-based decision

The CLI regression suite also runs a synthetic pre-booking decision through an external adapter. It checks the three legal delivery orders against an independent assertion, then repeats the check with a faulty policy. To run this gate against a specific tarball, install it in an empty consumer directory. In a checkout of the matching tag with development dependencies installed, set `TURNTRACE_TEST_CLI` to the absolute path of the installed `node_modules/turntrace/dist/cli/index.js`. Run the following command from that checkout.

```sh
node node_modules/vitest/vitest.mjs run tests/lab-cli.test.ts --testNamePattern "consumer oracle"
```

The subprocesses use the same Node version as the test runner. Repeat on each supported runtime. The test reads the actual decision, the delivered evidence and the prepared-plan count from replayed histories. It expects the domain assertion to reject a handoff lacking current evidence even when the lab replay succeeds. [Signal and observation contract](adapter.md#check-a-handoff-before-a-reservation-exists)

## Reduce a saved failure

```sh
node dist/cli/index.js run examples/lab/reduce.json --out original.json
node dist/cli/index.js minimize original.json --out reduced.json
node dist/cli/index.js replay reduced.json
```

The original and reduced runs both report `input.durable-ack` for `request-thursday`. The minimizer removes the optional group and its dependent action. Both traces remain replayable. These three commands each return status 1 because their evidence contains a booking violation.

The regression suite also moves the amendment commit across a crash, restarts after an opaque handoff and drops both acknowledgements for the same correction. It checks the IDs behind duplicate commitments, the difference between a stale playback start and audio already playing, and whether a truncated prefix already contains a safety violation. [Scenario acceptance tests](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/tests/lab-scenarios.test.ts) · [Crash-cut tests](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/tests/lab-crash-cuts.test.ts) · [Policy properties](https://github.com/NachoEstevo/turntrace/blob/v0.2.0/tests/lab-policy.test.ts)
