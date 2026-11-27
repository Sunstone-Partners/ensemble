# Fixtures: synthetic, not captured live

Neither fixture in this directory was captured from a live Azure DevOps / `az` CLI run. No
`az` binary is installed in this environment (TRD-2026-8d825f54 TRD-033). Both are labeled
synthetic in their own content/header and here, per TRD-033's own Implementation AC 4.

- `az-boards-help.txt`: a synthetic reconstruction of `az boards --help`, `az boards work-item
  --help`, `az boards work-item relation --help`, `az boards query --help`, `az devops
  configure --help`, `az account show --help`, `az extension show --help` and `az --version`
  output, built from TRD-033's own verbatim text plus this adapter's author's own
  independently-verifiable knowledge of the real, publicly documented Azure CLI command
  surface. Used by this adapter's own test suite to cross-check every `allowlist[].sub` entry
  names a subcommand that exists in this recorded text (TRD-033 Implementation AC 4).

- `az-work-item-show.sample.json`: a synthetic but realistic Azure DevOps REST API work-item
  object (the shape `az boards work-item show --id <id> --expand relations --output json`
  returns BEFORE this adapter's own `--query` flattening is applied), including one
  `Predecessor` relation (and one `Child` relation, to prove the adapter's JMESPath filter
  excludes non-`Predecessor` relation types) -- used by this adapter's own test suite to prove
  the `tracker.show` capability's declared `--query`/`parse` pipeline maps
  `relations[?attributes.name=='Predecessor']` into `dependencies: [{id, type}]` correctly, and
  that the result validates against the normalized work-item schema (TRD-033 Implementation
  AC 2). Field names (`System.Title`, `System.State`, `Microsoft.VSTS.Common.Priority`, the
  relation `rel`/`url`/`attributes.name` shape) match the real, publicly documented Azure
  DevOps REST API work-item/relation schema.
