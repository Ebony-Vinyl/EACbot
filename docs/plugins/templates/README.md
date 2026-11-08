# Plugin package template

Copy this folder into a plugin repository, rename `eac-plugin.example.json` to `eac-plugin.json`, and replace every
placeholder. The manifest is checked by EACbot's manifest parser before an install is accepted.

Keep the package self-contained. Do not add install-time scripts, downloaded executables or undeclared network/file
permissions. A package directory must contain exactly one manifest; declared entries are relative paths inside the
package and may not use links.

The planned community repository publishes immutable artifacts and a signed catalog. Until that repository exists, use
the local development install API or a custom signed channel.
