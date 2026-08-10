# installer/vendor/ — upstream tracking

## `esp-web-tools/`

Git submodule pointing at `mullender/esp-web-tools`, branch
`feat/awaited-post-flash-callback`. This branch carries a single commit on
top of upstream `esphome/esp-web-tools` main:
[PR 733](https://github.com/esphome/esp-web-tools/pull/733) — an awaited
`onPostFlash` callback. No other custom commits are carried.

- **Upstream repository:** `https://github.com/esphome/esp-web-tools`
- **Fork:** `https://github.com/mullender/esp-web-tools`
- **Fork branch:** `feat/awaited-post-flash-callback`
- **Upstream base:** `esphome/esp-web-tools` main at commit
  `4b1ef27` (parent of PR 733)
- **Patch summary:** one commit — the PR 733 awaited `onPostFlash`
  callback that passes the reopened `SerialPort` to a user function
  before Improv initialization.

## Submodule state

This repository pins the submodule to PR 733 commit
`cf6936234a6a37a5028bd2e39eca899bed8a0cd9`. The deploy workflow builds
that commit and serves it from the same origin as the installer.

The installer uses only the standard ESP Web Tools APIs plus PR 733's
`onPostFlash`. All previous fork-only APIs — `eraseFirst` attribute
enforcement, `install-result` events, `flash_checks` manifest arrays,
declarative connection policies, and terminal-result events — have been
removed from this project.

## Pin-dependent DOM handling

`installer/js/update-dialog-guard.js` reaches into the ESP Web Tools
install-dialog's open shadow root to force the keep-setup path for the
Update button:

- It watches `document.body` for a newly added `ewt-install-dialog`
  whose `manifestPath` exactly matches the Update button's `manifest`
  attribute. Dialogs from any other button — including a Factory
  dialog opened after a canceled Update picker — are never touched.
- It injects a scoped `<style data-aliro-update-guard>` hiding
  `label.formfield` (the erase checkbox row).
- It sets `ew-checkbox.checked = false` and `ew-checkbox.disabled = true`
  on the `ASK_ERASE` render, so the dialog's own Next-button handler
  reads a false checkbox and calls the keep-setup install path.

The guard's contract with the vendor source is asserted by the
*"pinned esp-web-tools source keeps the update-dialog guard's contract"*
node test in `installer/tests/node-tests.mjs`: CI fails before deploy
if the pin drifts or the private DOM layout changes.

## Post-flash settings capture

`installer/js/install-controller.js` uses the PR 733 `onPostFlash` port
to send one `ALIRO/1 GET` then run a single timed reader. On timeout
it calls `reader.releaseLock()` (never `reader.cancel()`), so the
`ReadableStream` stays open for ESP Web Tools' Improv init and for a
later serial-monitor connection. Values captured this way are shown
read-only in the settings panel until the serial monitor emits
`serial-connected` — the page never edits settings over a port it does
not own.

## Upstream PR

- **PR:** [esphome/esp-web-tools#733](https://github.com/esphome/esp-web-tools/pull/733)
  ("Add an awaited post-flash callback").
- **State:** filed against `esphome/esp-web-tools`; not yet merged.

## Transition plan

- **If PR 733 merges into a released version (say `10.5.0`):** drop the
  submodule and the Node build step from
  `.github/workflows/deploy-installer.yml`. Replace the local script
  reference with a single `<script>` tag at unpkg pinned to that exact
  version. Do NOT re-adopt the moving `@10` tag.
- **If declined or in flight:** keep the vendored PR 733 branch. Review
  upstream releases quarterly and rebase the single PR 733 commit as
  needed.

## Why vendor at all

- ESP Web Tools 10.4.0 has no public post-install completion event.
- The library's Improv Wi-Fi flow does exactly what the callback would
  do (reopen port, run initialisation), so the shape is proven; PR 733
  generalises it into a callback.
- Loading from unpkg with the moving `@10` tag was silently at risk of
  an upstream minor release changing behaviour under our feet.
- When `onPostFlash` is unavailable in a deployed build, the serial
  monitor reconnect path re-parses setup codes from the live boot log
  and populates the same UI — see `installer/js/install-controller.js`
  and `installer/js/serial-monitor.js`.
