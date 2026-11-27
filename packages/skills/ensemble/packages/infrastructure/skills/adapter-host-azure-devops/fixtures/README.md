# Fixtures: synthetic, not captured live

Neither fixture in this directory was captured from a live Azure DevOps / `az` CLI run. No
`az` binary is installed in this environment (TRD-2026-8d825f54 TRD-040). Both are labeled
synthetic in their own content/header and here, per TRD-040's own Implementation AC 4.

- `az-repos-pr-help.txt`: a synthetic reconstruction of `az repos pr --help` plus each of its
  subcommands' own `--help` output (`create`, `show`, `list`, `update`, `set-vote`,
  `work-item add`), `az account show --help`, `az devops configure --help`, `az extension show
  --help` and `az --version`, built from this adapter's author's own independently-verifiable
  knowledge of the real, publicly documented Azure CLI `repos` extension command surface,
  extended to cover every `allowlist[].sub` entry. Used to cross-check every allowlist entry
  names a subcommand that exists in this recorded text (TRD-040 Implementation AC 4).

- `az-repos-pr-show.sample.json`: a synthetic but realistic Azure DevOps REST API pull-request
  object (the shape `az repos pr show --id <id> --output json` returns BEFORE this adapter's
  own `--query` flattening is applied), with `status: "active"` and `refs/heads/`-prefixed
  `sourceRefName`/`targetRefName` -- used to hand-verify that this adapter's declared
  `host.change-request-view` `run`/`parse` pipeline maps `status: "active"` to `state: "open"`
  and that the mapped result validates against
  `packages/development/toolchain/schemas/normalized/change-request.json` (TRD-040
  Implementation AC 2; see this bead's report for the exact command and output). Field names
  (`pullRequestId`, `status`, `sourceRefName`, `targetRefName`, `url`, `reviewers[].vote`)
  match the real, publicly documented Azure DevOps REST API pull-request schema.
