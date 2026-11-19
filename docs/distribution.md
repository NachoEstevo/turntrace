# Installing the private tarball

Use Node.js 22.13 or later in the 22.x line, or Node.js 24.x. Download the private `turntrace-0.1.0.tgz` build artifact or build it from a checkout with `npm ci` followed by `npm pack`. The pack lifecycle compiles TypeScript and checks that every file in `dist/` matches the current source layout. A stale file left by a previous build stops packaging and identifies the unexpected entry.

Start in an empty directory containing the tarball. Run the commands on separate lines in Bash or PowerShell.

```sh
npm init -y
npm install --omit=dev ./turntrace-0.1.0.tgz
npm exec --offline -- turntrace demo --order commit-first --policy fixed
npm exec --offline -- turntrace recovery --provider opaque
```

Installation needs registry access or a populated npm cache for the runtime dependency, Zod. After installation the simulations run locally. They use synthetic fixtures and need no provider credentials.

## Replay the packaged evidence

```sh
npm exec --offline -- turntrace replay ./node_modules/turntrace/examples/commit-first.buggy.json
npm exec --offline -- turntrace replay ./node_modules/turntrace/examples/recovery.idempotent.json
```

The first replay verifies the recorded choices and returns status 1 because the booking policy confirmed the wrong day. The recovery example returns 0. An invalid or incompatible trace returns 2. The installed package also exposes an ESM entry point with TypeScript declarations.

## Run an installed adapter and reduce a failure

The package includes a customer-service adapter with a deliberate timing error. Explore the race and save a witness to a new file. Replay needs the same trusted adapter path. Both commands return 1 when they reproduce the violation.

```sh
npm exec --offline -- turntrace explore ./node_modules/turntrace/examples/lab/customer-race.json --adapter ./node_modules/turntrace/examples/lab/customer-agent.mjs --max-runs 200 --out witness.json
npm exec --offline -- turntrace replay witness.json --adapter ./node_modules/turntrace/examples/lab/customer-agent.mjs
```

The package also includes a failing lab trace at `node_modules/turntrace/examples/lab/premature-ack.trace.json`. Replay it directly or run the bundled reduction scenario to compare the full trace with a smaller witness.

```sh
npm exec --offline -- turntrace run ./node_modules/turntrace/examples/lab/reduce.json --out full.json
npm exec --offline -- turntrace minimize full.json --out smaller.json
npm exec --offline -- turntrace replay smaller.json
```

Each command returns 1 because the witness retains the same violation. Choose fresh output paths when repeating the exercise. See the [adapter contract](adapter.md) for the limits of cooperative execution and the [scenario catalogue](acceptance.md) for the other packaged examples.

## Check the archive

Run `npm run test:pack` in the checkout after `npm ci`. This command creates a tarball, checks its file list and installs it with production dependencies in a fresh temporary project. It executes the installed command and the public ESM API, replays both bundled traces and deliberately changes a verdict to verify the diagnostic. To check an existing archive, use `npm run test:pack -- /path/to/turntrace-0.1.0.tgz`. The command needs a `tar` executable on the path.

The Pack workflow builds the archive once and sends the same artifact to Linux and Windows consumers on Node 22.13 and 24. It checks the local links inside the installed guides, type-checks a consumer that imports the public API and runs the ESM entry point. Package metadata marks the package private. The tarball includes the Apache license, the third-party notices and Zod's MIT license, compiled modules, public types, synthetic fixtures and user documentation.

## Weekly recovery profile

The private **Exploration profile** GitHub Actions workflow runs on Mondays at 04:37 UTC. Use **Run workflow** in Actions to start it manually. It exercises the bundled recovery scenario with seed 73 and a budget of 200 samples. After building the project, the same command writes the two reports locally.

```sh
node dist/cli/index.js explore examples/lab/recovery.json --seed 73 --samples 200 --max-runs 200 --profile --json > campaign.json 2> resources.json
```

The artifact contains both JSON files. `campaign.json` reports the number of executed histories, terminal, blocked and truncated counts, remaining budget, limits and findings. `mode: sampled` and `complete: false` describe a seeded sample even when all 200 runs finish. `resources.json` records the Node version, machine, elapsed time and process CPU time in milliseconds, and peak process RSS in KiB. The workflow checks sample accounting and records measurements without setting a machine-specific timing threshold.
