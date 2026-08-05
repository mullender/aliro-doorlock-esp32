# installer/vendor/ — upstream tracking

## `esp-web-tools/`

Git submodule pointing at `mullender/esp-web-tools`, branch
`homekey-post-install-hook`. Base is the upstream `10.4.0` release tag,
plus one patch that adds an awaited `onPostFlash` callback.

- **Upstream repository:** `https://github.com/esphome/esp-web-tools`
- **Fork:** `https://github.com/mullender/esp-web-tools` (needs to be
  created on GitHub before the submodule reference resolves)
- **Fork branch:** `homekey-post-install-hook`
- **Upstream base:** tag `10.4.0`
- **Patch summary:** `feat: add awaited onPostFlash callback` — the
  single commit on the fork branch on top of the vendored 10.4.0.

## Local fork bootstrap

The fork exists on disk at
`/Users/mullender/Development/esp-web-tools-fork` (created during the
autonomous scaffold session on 2026-08-04/05). Both commits are in
local git; nothing has been pushed to GitHub yet.

To finish the bootstrap:

1. Create `mullender/esp-web-tools` (empty) on GitHub.
2. From `~/Development/esp-web-tools-fork`:
   ```
   git remote add origin https://github.com/mullender/esp-web-tools.git
   git push -u origin main homekey-post-install-hook
   ```
3. From `~/Development/aliro-doorlock-esp32`:
   ```
   git submodule add -b homekey-post-install-hook \
     https://github.com/mullender/esp-web-tools.git \
     installer/vendor/esp-web-tools
   git commit -m "vendor: add esp-web-tools fork submodule"
   ```

`scripts/setup_vendor.sh` walks through these steps.

## Upstream PR

- **Issue:** to be filed on `esphome/esp-web-tools` after Phase 4b lands.
  Frame as a generic serial-callback hook, not a Matter feature.
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
