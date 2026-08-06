# installer/vendor/ — upstream tracking

## `esp-web-tools/`

Git submodule pointing at `mullender/esp-web-tools`, branch
`homekey-post-install-hook`. Base is the upstream `10.4.0` release tag,
plus focused install-lifecycle and safety patches.

- **Upstream repository:** `https://github.com/esphome/esp-web-tools`
- **Fork:** `https://github.com/mullender/esp-web-tools`
- **Fork branch:** `homekey-post-install-hook`
- **Upstream base:** tag `10.4.0`
- **Patch summary:** awaited `onPostFlash`, typed terminal results,
  declarative erase policy, preflight flash checks, app-only erase
  rejection, and connection locking.

## Submodule state

The fork repository and the `homekey-post-install-hook` branch exist. This
repository pins the submodule to commit
`21e9cdcbd7a43244a016b56550ae2b2b1015986a`. The deploy workflow builds that
commit and serves it from the same origin as the installer.

The terminal order is fixed: completed flash, reopened serial port,
awaited `onPostFlash`, then one `install-result`. A rejected callback
produces `post_flash_failed` and does not produce success.

The fork also supports a generic `flash_checks` manifest array. Each
entry has `offset`, `size`, and `sha256`. All checks must pass before
the first erase or write.

## Upstream PR

- **Issue:** to be filed on `esphome/esp-web-tools` after Phase 4b lands.
  Frame the callback, terminal result, policy, and flash-check APIs as
  generic installer safety features, not Matter features.
- **PR:** to follow the issue, using the fork branch verbatim.
- **State:** not filed yet.

Record the upstream issue and PR URLs here when they exist:

- Issue: <TODO>
- PR: <TODO>
- Merged in: <TODO — target upstream version if merged>

## Transition plan (post-Phase 4)

- **If the upstream PR merges into a released version (say `10.5.0`):**
  drop the submodule and the Node build step from
  `.github/workflows/deploy-installer.yml`. Replace the local script
  reference with a single `<script>` tag at unpkg pinned to the exact
  merged version. Do NOT re-adopt the moving `@10` tag.
- **If declined or in flight:** keep the fork vendored. Review upstream
  releases quarterly and rebase the callback patch as needed. Update
  the "Upstream base" note here on every rebase.

## Why vendor at all

- ESP Web Tools 10.4.0 has no public post-install completion event.
- The library's Improv Wi-Fi flow does exactly what the callback would
  do (reopen port, run initialisation), so the shape is proven; the
  patch just generalises it.
- Loading from unpkg with the moving `@10` tag was silently at risk of
  an upstream minor release changing behaviour under our feet — see
  the pairing plan's Main Constraint #1.
