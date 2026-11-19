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

## Check the archive

Run `npm run test:pack` in the checkout after `npm ci`. This command creates a tarball, checks its file list and installs it with production dependencies in a fresh temporary project. It executes the installed command and the public ESM API, replays both bundled traces and deliberately changes a verdict to verify the diagnostic. To check an existing archive, use `npm run test:pack -- /path/to/turntrace-0.1.0.tgz`. The command needs a `tar` executable on the path.

The Pack workflow builds the archive once and sends the same artifact to Linux and Windows consumers on Node 22.13 and 24. It type-checks a consumer that imports the public API and runs the ESM entry point. Package metadata marks the package private. The tarball includes the Apache license, the third-party notices and Zod's MIT license, compiled modules, public types, synthetic fixtures and user documentation. The architecture guide's source references open from a checkout.
