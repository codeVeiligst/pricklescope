# PrickleScope documentation

Start with the [README](../README.md) if you want to know what PrickleScope is.
This index is for once you have decided to use it, run it, or work on it.

## Using it

| Document                               | What it answers                                                        |
| -------------------------------------- | ---------------------------------------------------------------------- |
| [deployment.md](deployment.md)         | How do I put this into production, with TLS, secrets, and backups?     |
| [operations.md](operations.md)         | How big a host does it need, what should I watch, what grows silently? |
| [upgrades.md](upgrades.md)             | How do I move a pinned version forward, and how do I get back?         |
| [infrastructure.md](infrastructure.md) | What exactly are these containers and how are they pinned?             |

## Working on it

| Document                                 | What it answers                                                       |
| ---------------------------------------- | --------------------------------------------------------------------- |
| [development.md](development.md)         | How do I start it locally, run the tests, and reset when it breaks?   |
| [architecture.md](architecture.md)       | How is it put together, and what is each part responsible for?        |
| [implementation.md](implementation.md)   | What was decided, why, and what did it cost? Milestones and progress. |
| [releasing.md](releasing.md)             | What makes a version, and how does one get published?                 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | What does a useful change look like here?                             |

## Security

| Document                                             | What it answers                                         |
| ---------------------------------------------------- | ------------------------------------------------------- |
| [../SECURITY.md](../SECURITY.md)                     | How do I report a vulnerability?                        |
| [security/threat-model.md](security/threat-model.md) | What is worth stealing, who would try, what stops them? |
| [security/verification.md](security/verification.md) | How was that tested, and what did it find?              |

## Background

| Document                             | What it answers                                     |
| ------------------------------------ | --------------------------------------------------- |
| [storage-spike.md](storage-spike.md) | Why QuestDB, and what was actually proven about it? |

## Open points

Unresolved questions and known limitations are deliberately kept where they
belong rather than collected into a list that goes stale:

- **Milestone progress and what is not built** — the milestone sections in
  [implementation.md](implementation.md), including Milestone 7, which was
  dropped rather than deferred (D-024), and the items still open in Milestone 8.
- **Deferred work** — the "Deferred" notes under individual milestones, such as
  mute timings and maintenance windows in Milestone 6.
- **Accepted security risk** — the accepted gaps in
  [security/threat-model.md](security/threat-model.md) and the residual risk in
  [security/verification.md](security/verification.md), each with the condition
  that would reopen it.
- **Things that grow without pruning** — [operations.md](operations.md).
- **Scanner exceptions** — `scripts/scan-exceptions.txt` and
  `scripts/security-scan-exceptions.txt`, each entry carrying its reasoning.

## Conventions in these documents

Decisions are numbered `D-001` onward in [implementation.md](implementation.md)
and referenced by number wherever they are relied on. When a document says
something is deliberate, the decision number is how to find out why.

Where a document states a measurement — a resource figure, a row count, a test
result — it came from a run, and the document says which. Where a number was not
measured, it says that instead.
