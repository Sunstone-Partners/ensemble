# FIX_REPORT — BDD default follows the repo language (`ensemble-pdf-bdd-default-off-non-dotnet-v2-r3`)

STATUS: IN PROGRESS — reproduction recorded, fix not yet applied.

## Reproduction (failing-first, recorded before any edit)

Command (from the repo root, branch `foreman/ensemble-pdf-bdd-default-off-non-dotnet-v2-r3/run-1b98d4d0cfda71b096c6038bb25ef21d` at `fe5aea4f`):

```
$ node ~/.omp/ensemble-bdd-default-off-r3/repro.js
plain repo  : 0 {"ok":true,"enabled":true,"source":"default","message":"Test approach: BDD (Reqnroll) [default; opt out with ENSEMBLE_BDD=0, or --no-bdd on create-trd]"}
dotnet repo : 0 {"ok":true,"enabled":true,"source":"default","message":"Test approach: BDD (Reqnroll) [default; opt out with ENSEMBLE_BDD=0, or --no-bdd on create-trd]"}
FAIL  non-.NET repo default is OFF -> {"ok":true,"enabled":true,"source":"default",...}
PASS  .NET repo default stays ON -> ...
REPRO_EXIT=1
```

Two throwaway directories (one empty, one holding a root `App.csproj`), each the cwd for
`node packages/development/lib/trd-cli.js resolve-bdd`. The non-.NET repo is answered with
`enabled: true, source: 'default'`, so `create-trd` routes its test tasks to C#-only Reqnroll.

## Root cause

Unknown yet — not analysed beyond the reproduction above.

## Change

None yet.

## Tests

None yet.

## Local verification

`node ~/.omp/ensemble-bdd-default-off-r3/repro.js` → exit 1 (the reproduction above). Nothing else run yet.

## Follow-ups

None yet.

## Assumptions

None yet.

## PR body

Not written yet.
