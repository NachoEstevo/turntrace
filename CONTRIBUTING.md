# Contributing to Turntrace

Run the suite from a checkout with Node.js 22.13 or later in the 22.x line, or Node.js 24.x, and npm.

```sh
npm ci
npm test
npm run replay -- examples/commit-first.buggy.json
```

The last command reproduces a known failure and exits with status 1. The trace shows the agent confirming Thursday after the provider rejected the revision. For a change to the scheduler or replay format, use that saved trace as one check on compatibility. A freshly recorded trace exercises the current writer as well.

For a new scenario, describe the order of events and the evidence that reached each participant. Give the checker a concrete observation it can use to identify the error. For example, record which receipt reached the agent before it confirmed a booking. Include a passing schedule or policy alongside the regression so another contributor can tell whether the fix works.

When reporting a result that surprised you, share the CLI command, Node version, exit status and smallest synthetic trace that still shows it. Start with the timeline events near the first failed check. The architecture guide explains the provider, agent and playback boundaries. [Architecture](docs/architecture.md)
