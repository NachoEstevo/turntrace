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
node dist/cli/index.js explore examples/lab/customer-race.json --adapter examples/lab/customer-agent.mjs --max-runs 8
node dist/cli/index.js run examples/lab/customer-race.json --adapter examples/lab/customer-agent.mjs --out customer.json
node dist/cli/index.js replay customer.json --adapter examples/lab/customer-agent.mjs
```

The first instance saves Tuesday and sends a create request. It arms a courtesy timer while it waits for the receipt. There are exactly two histories. At tick 10 the timer and the delivery of Thursday are both enabled. If the timer fires first, the agent opens a manual review for the unresolved Tuesday booking. When the correction arrives, it updates the open review with Thursday as the requested day. If it receives Thursday first, a defect in the adapter treats the caller's preferred day as a booked replacement. The checker flags `claim.supported` at the emitted claim. The provider history remains Tuesday in both cases. The default run selects the failing order and returns status 1.

After installation, use the installed `turntrace` executable in place of `node dist/cli/index.js`. You can copy the scenario and adapter into your own project and generate a fresh trace there. For replay in another workspace, reproduce the adapter's source files, Node version and nearest `package-lock.json` (including its absence), then supply the adapter path explicitly. [Adapter guide](adapter.md)

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

The regression suite also moves the amendment commit across a crash, restarts after an opaque handoff and drops both acknowledgements for the same correction. It checks the IDs behind duplicate commitments, the difference between a stale playback start and audio already playing, and whether a truncated prefix already contains a safety violation. [Scenario acceptance tests](https://github.com/NachoEstevo/turntrace/blob/v0.1.0/tests/lab-scenarios.test.ts) · [Crash-cut tests](https://github.com/NachoEstevo/turntrace/blob/v0.1.0/tests/lab-crash-cuts.test.ts) · [Policy properties](https://github.com/NachoEstevo/turntrace/blob/v0.1.0/tests/lab-policy.test.ts)
