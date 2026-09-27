# Contributing

Agent Monitor is a small CommonJS extension with a standalone Node hook collector and a plain JavaScript webview. It has no runtime npm dependencies or build framework.

## Set up

Use Node.js 22 or newer and npm. From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
```

For interface changes, run the renderer checks described in [Validation](docs/VALIDATION.md#renderer-test-setup). Browser setup is needed only for developing the extension.

## Find the code

Read the [architecture source map](docs/ARCHITECTURE.md), then the [specification](docs/SPECIFICATION.md). For a new runtime, use the [adapter guide](docs/ADAPTERS.md). [AGENTS.md](AGENTS.md) provides the same repository boundaries for coding agents.

## Make a change

1. Describe the user-visible problem and expected behaviour. Keep unrelated refactors separate.
2. Add regression cases for changed behaviour. Use synthetic input, including failure and false-positive cases. For classification, add labelled cases to `test/focus-corpus.js` stating the areas that must and must not be signalled. Never put real or realistic credentials in fixtures; assemble credential-shaped test strings at run time so secret scanning stays meaningful.
3. Keep resource use bounded and ordinary hook events free of model-facing output, except required host permission responses.
4. Update the relevant contract documentation and changelog. Record native verification gaps honestly.
5. Run `npm run format`, `npm run check`, `npm test` and `npm run format:check`. Run `npm run test:ui` for webview or host-message changes, then `npm run package` for packaging changes.

The formatter is pinned as a development dependency. Prefer comments explaining invariants and decisions; do not repeat the code in prose. Stable category IDs, stored request revisions and hook output fields are compatibility contracts.

## Protect contributors' data

Do not commit agent settings, transcripts, real cache contents, credentials, personal filesystem paths or screenshots of private work. Use `example.test`, `/work/example`, or the synthetic home directory `demo` in fixtures. Describe failures with minimal redacted examples. Retain third-party copyright notices and licences.

`npm run check` checks the source inventory, local documentation links, PNG metadata and common sensitive-data patterns. It is not a guarantee against every secret or identifying detail; inspect diffs and visible screenshot content too. Packaging runs the same checks and validates its output.

## Review and resources

A change description should state what changed, why, checks performed and material limitations. Do not report synthetic or mocked tests as native agent acceptance. UI changes must preserve keyboard access, theme colours, narrow layouts and hidden-view cleanup.

Use one automation browser at a time. Stop task-owned servers, watchers and test processes after verification, including failures. Do not stop another contributor's editor or agent sessions.

Building a source archive or VSIX does not publish it. Repository, registry and marketplace publication require a separate maintainer decision; see [release preparation](docs/RELEASING.md).
