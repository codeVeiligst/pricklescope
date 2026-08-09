# Contributing to PrickleScope

Thanks for looking. A few things worth knowing before you spend time on a change.

## This project is written by AI

Every line of PrickleScope was produced by an AI assistant working from a human
owner's direction. That is not a disclaimer — it shapes how the codebase is built
and what a useful contribution looks like:

- **Decisions are written down and numbered.** `D-001` onward in
  [docs/implementation.md](docs/implementation.md) record what was chosen, why,
  and what it cost. A change that contradicts one is fine, but it needs to say so
  and update the decision rather than quietly diverging from it.
- **Comments explain the reasoning, not the syntax.** Where a line looks odd
  there is usually a comment saying which bug produced it. Please keep that habit;
  those comments have already stopped several regressions.
- **Tests assert the property, not the implementation.** Several suites here
  deliberately fail if they stop covering anything — the authorization matrix
  fails when a route has no entry, and the scanners fail if they cannot find a
  planted secret. Prefer that shape.

## Before you start

Open an issue describing the problem first, particularly for anything that touches
the desired-state model, the collector pipeline, or authorization. The controller
owns state that three other engines act on, and a change that looks local often is
not.

## Setting up

```bash
nvm use                  # Node 24
corepack pnpm install
./scripts/dev-up.sh      # infra, migrations, an admin account, and both dev servers
```

[docs/development.md](docs/development.md) covers the rest: resetting, logs, test
data, and what to do when something will not start.

## Before you open a pull request

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration   # needs TEST_DATABASE_URL
corepack pnpm test:security      # needs TEST_DATABASE_URL
corepack pnpm test:e2e
corepack pnpm format:check
```

Integration and security tests **silently skip** without `TEST_DATABASE_URL`, so a
green run proves nothing until you have confirmed they actually executed.
`./scripts/dev-up.sh --infra` creates the database they expect.

If your change touches anything security-relevant, also run:

```bash
./scripts/security-scan.sh
./scripts/scan.sh
```

## House style

The mechanical parts are enforced — ESLint with `--max-warnings=0`, Prettier at
100 columns, no semicolons, single quotes. Beyond that:

- TypeScript is ESM with `NodeNext`, so **relative imports carry `.js`** even from
  `.ts` sources.
- New API surface starts with a TypeBox schema in `packages/contracts`, never a
  response shape written out twice.
- Nullable _request_ fields use `NullableString`/`NullableNumber`, not a union —
  Ajv coerces inside `anyOf` and will turn an explicit `null` into `''`.
- Slow work is a job, never a request.
- Destructive UI actions confirm through `useConfirm`, and the dialog names what
  is lost.

Beyond that, the surest guide is the code next to the code you are changing:
comment density, naming, and structure are consistent on purpose, and a change
that reads like its neighbours is easier to review than one that is merely
correct.

## Security

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md)
explains how to report one and what is already known and accepted.

## Licence

PrickleScope is licensed under the GNU Affero General Public License v3.0. By
contributing you agree that your contribution is licensed under the same terms.
