# Installing the private tarball

Use Node.js 22.13 or later in the 22.x line, or Node.js 24.x. Build `turntrace-0.2.0.tgz` from the checkout with `npm ci` followed by `npm pack`, or download the matching private build artifact from the Pack workflow. The pack lifecycle compiles TypeScript and checks that every file in `dist/` matches the current source layout. A stale file left by a previous build stops packaging and identifies the unexpected entry.

Start in an empty directory containing the tarball. Run the commands on separate lines in Bash or PowerShell. Keep the quotes around `'--'` so PowerShell passes the separator to npm.

```sh
npm init -y
npm install --omit=dev ./turntrace-0.2.0.tgz
npm exec --offline '--' turntrace demo --order commit-first --policy fixed
npm exec --offline '--' turntrace recovery --provider opaque
```

Installation needs registry access or a populated npm cache for the runtime dependency, Zod. After installation the simulations run locally. They use synthetic fixtures and need no provider credentials.

## Replay the packaged evidence

```sh
npm exec --offline '--' turntrace replay ./node_modules/turntrace/examples/commit-first.buggy.json
npm exec --offline '--' turntrace replay ./node_modules/turntrace/examples/recovery.idempotent.json
npm exec --offline '--' turntrace replay ./node_modules/turntrace/examples/lab/premature-ack.trace.json
```

The booking and premature-acknowledgement examples return status 1 after reproducing their respective violations. The recovery example returns 0. An invalid or incompatible trace returns 2. The installed package also exposes an ESM entry point with TypeScript declarations.

## Compare two histories from the installed adapter

The customer-service adapter sets a deadline while a booking is pending. Explore the two possible orders for the correction and the deadline. The command saves both histories in a new directory and exits with status 1 because one contains an unsupported confirmation.

```sh
npm exec --offline '--' turntrace explore ./node_modules/turntrace/examples/lab/customer-race.json --adapter ./node_modules/turntrace/examples/lab/customer-agent.mjs --max-runs 200 --out-dir customer-histories
npm exec --offline '--' turntrace compare customer-histories/history-00001.json customer-histories/history-00002.json --adapter ./node_modules/turntrace/examples/lab/customer-agent.mjs --out-dir paired --json
npm exec --offline '--' turntrace replay paired/left.json --adapter ./node_modules/turntrace/examples/lab/customer-agent.mjs
npm exec --offline '--' turntrace replay paired/right.json --adapter ./node_modules/turntrace/examples/lab/customer-agent.mjs
```

For this fixture, `customer-histories/index.json` identifies `history-00001.json` as the failure. The comparison returns `isolated` and writes its report to `paired/comparison.json`. Replaying `left.json` reproduces `claim.supported` and exits with status 1. Replaying `right.json` exits with status 0. Pass the trusted adapter explicitly to each command.

To replay a local-adapter trace from an earlier installation, keep the adapter's original source tree, its nearest `package-lock.json` if one existed and its exact Node version. The adapter fingerprint includes all three. A package upgrade can change the lockfile even when the adapter source is identical.

The `compare` command exits with status **0** for `isolated` or `no-contrast`, **3** for `inconclusive`, and **2** for invalid input or a replay error. Choose fresh output directories when repeating the comparison.

## Reduce a single failure

The premature-acknowledgement fixture shows how to reduce one failing execution. Run the full scenario, minimize its trace and replay the smaller witness.

```sh
npm exec --offline '--' turntrace run ./node_modules/turntrace/examples/lab/reduce.json --out full.json
npm exec --offline '--' turntrace minimize full.json --out smaller.json
npm exec --offline '--' turntrace replay smaller.json
```

Each command returns 1 because the witness retains the same violation. Choose fresh output paths when repeating the exercise. See the [adapter contract](adapter.md) for the limits of cooperative execution and the [scenario catalogue](acceptance.md) for the other packaged examples.

## Check the archive

Run `npm run test:pack` in the checkout after `npm ci`. This command creates a tarball, checks its file list and installs it with production dependencies in a fresh temporary project. It exercises the installed CLI and public ESM API, replays all three bundled traces, and checks the diagnostic for an edited verdict. It also explores the customer adapter, compares a failing history with a passing one and replays both files from the comparison directory. To check an existing archive, use `npm run test:pack '--' /path/to/turntrace-0.2.0.tgz`. The command needs a `tar` executable on the path.

The Pack workflow builds the archive once and sends the same artifact to Linux and Windows consumers on Node 22.13 and 24. It checks the local links inside the installed guides, type-checks a consumer that imports the public API and runs the ESM entry point. Package metadata marks the package private. The tarball includes the Apache license, the third-party notices and Zod's MIT license, compiled modules, public types, synthetic fixtures and user documentation.

## Weekly recovery profile

The private **Exploration profile** GitHub Actions workflow runs on Mondays at 04:37 UTC. Use **Run workflow** in Actions to start it manually. It exercises the bundled recovery scenario with seed 73 and a budget of 200 samples. After building the project, the same command writes the two reports locally.

```sh
node dist/cli/index.js explore examples/lab/recovery.json --seed 73 --samples 200 --max-runs 200 --profile --json > campaign.json 2> resources.json
```

The artifact contains both JSON files. `campaign.json` reports the number of executed histories, terminal, blocked and truncated counts, remaining budget, limits and findings. `mode: sampled` and `complete: false` describe a seeded sample even when all 200 runs finish. `resources.json` records the Node version, machine, elapsed time and process CPU time in milliseconds, and peak process RSS in KiB. The workflow checks sample accounting and records measurements without setting a machine-specific timing threshold.
