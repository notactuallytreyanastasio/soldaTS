# Maps directory

Drop real Soldat `.PMS` map files here. The dev server serves this directory at
`/maps/`, so a file named `ctf_Ash.pms` is reachable at `/maps/ctf_Ash.pms`.

## Choosing a map

The client picks the map URL from the `?map=` query parameter, falling back to
`/maps/ctf_Ash.pms`:

- `?map=ctf_Ash` → `/maps/ctf_Ash.pms`
- `?map=/maps/dm_Arena.pms` → used verbatim
- no parameter → the default above

If the fetch fails (file missing, offline, or a parse error), the client falls
back to a small synthetic test scene so development still works without any
assets present.

## Licensing — these files are NOT committed

`.PMS` files are **not** checked into this repository. Per the asset-licensing
decision, you must supply your own from a legitimate Soldat / OpenSoldat
install. Copy maps from your install's `maps/` folder into this directory.

This directory is intentionally tracked only by this `README.md`; the `.pms`
files themselves are expected to be git-ignored / user-supplied.
