# Contributing

Thanks for your interest in narcissus. Issues and pull requests are welcome.

## Before you open a pull request

1. Open an issue first for anything larger than a bug fix, so we can agree on the approach.
2. Keep the change small and focused. One subject for each pull request.
3. Add or update tests for the behaviour you change.

[docs/architecture.md](docs/architecture.md) shows where code goes and which layer may import which.

A change to [docs/format.md](docs/format.md) is a new version of the format, and each reader and writer must follow it. Open an issue before you start on one.

## Setup

You need Node 26 and [pnpm](https://pnpm.io).

```sh
pnpm install
```

## Linting, formatting and tests

CI runs these four commands. Run them before you push:

```sh
pnpm check
pnpm lint
pnpm test
pnpm package
```

`pnpm format` formats the code. The tests of the GPU passes need a GPU adapter.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, for example `fix(format): reject an empty root list`. Keep the subject short and in the imperative.

## Licence

Your contributions are licensed under the [BSD 3-Clause License](LICENSE).
