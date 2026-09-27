# Preserve fork changes during upstream updates

This fork owns the Kiro provider and its integration changes. An upstream
update must retain that implementation and its Git history. The sync workflow
proposes a merge commit and validates the combined code before publishing a
pull request. A maintainer decides whether to merge it.

```text
Trusted main + pinned upstream + fork patch registry
                       |
              read-only discovery
                       |
             normal CI on merge commit
                       |
         trusted publisher reconstructs commit
                       |
             sync branch -> pull request
                       |
        approve PR checks -> review -> merge commit
```

The publisher runs trusted code from main. Only the read-only CI job executes
the combined implementation.

## Source of truth and scope

`package.json.repository`, `CONTRIBUTING.md`, and GitHub's fork metadata identify
`kunchenguid/quota-axi` as upstream. [fork-sync.json](../fork-sync.json) records:

- The upstream repository, branch, and full accepted commit SHA.
- Each fork patch's ownership name, historical anchor, and exact owned paths.
- The Kiro implementation tip already contained by the fork's main merge.
- The synchronization implementation, anchored to its starting fork main.

The initial pin is `4368dbf4d621b0deb9c1432c7daa56ead219d7c1`. The initial fork
base is `9d10f077e69ec18c2bddd55821e6e81621831af0`. This version synchronizes
upstream **main into fork main**. Other branch mappings require a separate
reviewed change. The registry itself is implicitly fork-owned.

Accepted main is authoritative for owned file contents. Each patch anchor must
remain an ancestor of main. Every file that differs from the upstream pin must
have a registered owner. New fork files therefore require a registry update in
the same reviewed change. Existing owned files can evolve through reviewed fork
changes; the registry does not freeze their original contents.

## Trust and failure boundaries

| Component | Responsibility                                                                                        | Token permissions                         |
| --------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Discovery | Fetch public upstream objects, check the registry, construct a merge object, report immutable SHAs    | `contents: read`                          |
| Normal CI | Reconstruct the same SHA, then build, test, lint and check the generated skill                        | `contents: read`                          |
| Publisher | Reconstruct the validated SHA from trusted main, recheck remote refs, push the sync branch, open a PR | `contents: write`, `pull-requests: write` |

All jobs use fresh GitHub-hosted runners. The publisher installs no project
dependencies, checks out no proposed code, inherits no secrets, and executes
only the dependency-free helper from the workflow's main commit. Checkouts do
not persist credentials. The token enters only the publisher step. Git and API
errors omit response bodies and authenticated command diagnostics.

`GITHUB_TOKEN` permissions apply to the repository, **not an individual
branch**. The helper uses one explicit `sync/upstream-main-<base>-<upstream>`
destination. Default-branch protection must also prohibit force pushes and
require reviewed PRs and passing checks. The workflow cannot replace that
server-side protection. It never pushes main, enables auto-merge, publishes a
release, installs the CLI, or changes credentials.

Scheduled and manual runs must originate on the fork's default branch, which
must be `main`. Discovery writes local Git objects only. The workflow has no
`pull_request_target`, `workflow_run`, or dispatch payload that accepts code or
arbitrary refs. It does not accept personal access tokens.

The helper refuses:

- A rewritten upstream history or a missing fork anchor.
- An unregistered fork delta.
- Any upstream change to a fork-owned path, including a conflict-free edit.
- Any upstream change under `.github/`, to `.gitattributes`, `.gitmodules`,
  `.no-mistakes.yaml`, the registry, or the publishing helper.
- Git merge conflicts, a changed main or upstream tip before publication,
  a different reconstructed SHA, or an existing sync branch with another head.
- A second open sync PR. Finish or close the first proposal before retrying.

This conservative policy can stop on shared files such as README or provider
registration. That is intentional: a clean textual merge does not prove that
upstream preserved a fork behavior. A maintainer must review overlap in a
separate branch. The automation never resolves it by choosing one side.

## Activate and run

1. Merge the implementation PR only after review and its normal checks.
   Neither this document nor the workflow grants merge authority.
2. In the fork's Actions settings, enable **Allow GitHub Actions to create and
   approve pull requests**. The workflow uses PR creation only. On 2026-09-27,
   the API reported this setting disabled. No setting was changed by this work.
3. Confirm scheduled Actions are enabled for the fork. Confirm main forbids
   force pushes and requires the intended review and CI checks. On 2026-09-27,
   force pushes and deletion were prohibited, but the protection response did
   not list required reviews or status checks. Squash and rebase were still
   repository options. The maintainer must enforce the merge method for sync
   PRs; the proposal workflow does not administer repository settings.
4. Run **Propose upstream sync** with `workflow_dispatch` on `main`, or wait
   for Monday at 06:23 UTC. There are no user-supplied ref inputs.
5. Read the discovery summary. If the pin equals upstream main, the workflow
   succeeds without creating a branch or PR. Otherwise, normal CI runs through
   the same [ci.yml](../.github/workflows/ci.yml) job used by ordinary PRs.
6. If validation succeeds, the publisher reconstructs the exact same merge
   commit. It pushes an immutable-named sync branch and opens a ready PR. The
   commit's first parent is the fork base; its second parent is the upstream
   SHA. The commit also advances the registry pin.
7. On the bot-created PR, select **Approve workflows to run**. GitHub creates
   these `pull_request` runs in an approval-required state when `GITHUB_TOKEN`
   creates the PR. Do not treat a queued or absent check as passing. The
   [documented trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
   is why pre-publication CI also runs explicitly.
8. Check the current PR head and base against the recorded SHAs. Require normal
   PR CI, generated-file checks, review, and applicable branch requirements.
   The existing generated-file and no-mistakes bot exemptions remain unchanged.
   Do not fabricate a no-mistakes attestation. The normal human contribution
   contract remains in [CONTRIBUTING.md](../CONTRIBUTING.md).
9. With separately recorded merge authority, use **Create a merge commit**.
   Never squash or rebase a sync PR: that would remove upstream ancestry from
   the fork's accepted history. Revalidate before any separately authorized
   release or installation. This workflow makes no release or install changes.

The reusable CI runs without a write token and without repository secrets. Its
result proves the exact candidate SHA tested at the captured base. A later main
change invalidates that comparison. Close the stale PR and rerun from current
main. Do not use automatic branch updates or replace its sync-branch history.

## Failures and retry

A failed discovery, merge, or CI job produces no remote write. A publication
failure can leave the sync branch without a PR. Retry the workflow if main and
upstream are unchanged: deterministic commit construction yields the same SHA,
and the publisher reuses an exact existing branch or open bot-authored PR.
An existing different head is always an error. No force push or reset is used.

Remote checks and PR creation are separate GitHub operations, so they are not
an atomic transaction. Main can move after the final check. Review the current
base and rerun PR CI before merging. A concurrent divergent branch write is
rejected by ordinary non-force Git push; a later branch mutation is detected
by the head check. No token can bypass the need for a final maintainer review.

If upstream changes a protected path, inspect that change and its interaction
with the fork. Integrate it manually through a reviewed merge-commit PR, update
the pin and ownership registry together, and run the full contribution gate.
Do not weaken the path protection just to get a scheduled run through.

## Roll back without rewriting history

1. For an unmerged proposal, close the PR. No main rollback is needed. Preserve
   the branch until the investigation finishes; there is no automatic deletion.
2. For a merged sync, record the last known-good SHA and the final main merge
   commit. Verify its first parent is the expected previous fork main. Create
   a rollback feature branch from current main.
3. Use `git revert -m 1 <main-merge-commit>` on that branch. This creates a new
   commit that undoes the sync tree and restores its previous registry pin.
   Do not reset main or force-push. Resolve any later-change conflicts through
   review; do not choose a side automatically.
4. Run all contribution checks on the rollback tree and open a rollback PR.
   Merge only with separate authority and passing checks. The rollback does
   not undo an external release or installation.
5. Pause further sync proposals until the underlying defect is understood.
   A revert keeps the upstream commits in history. Reintroducing the update
   therefore needs a reviewed revert of the rollback or a deliberate forward
   fix, followed by an audited registry update. Do not merely advance the pin.

## Design assessment

This is repository automation, with one scheduled run per week and manual
retries. Public source and commit IDs are non-secret. The only sensitive value
is the ephemeral publishing token. Preservation of fork history and separation
of code execution from write authority are hard requirements. GitHub runner
availability and upstream change frequency are external and unmeasured; no
latency or availability target is assumed. Cost is one discovery job, with CI
and publication only when a candidate exists.

A single job that both tests upstream code and holds write authority would mix
trust levels. A personal token or an additional GitHub App would add credential
ownership outside this task. Three bounded jobs with a reusable normal CI job
meet the requirements without either. No service, database, queue, or new npm
dependency is needed.

Security, data lifecycle, component boundaries, and rollback are applicable
lenses, addressed above. A full-stack or application deployment redesign is not
applicable: provider behavior and release configuration are unchanged. Git
history owns accepted state; workflow summaries and PR bodies are evidence,
not alternative state stores. Immutable branch names and one workflow
concurrency group bound duplicate proposals. Tests use synthetic repositories
and mocked publication boundaries; hosted execution remains an activation
check after this workflow reaches trusted main.
