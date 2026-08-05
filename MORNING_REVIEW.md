# Morning review — 2026-08-05

Everything from the autonomous overnight grind. Read this first, then
skim LEDGER.md, then decide what to touch.

## What exists now

Two local git repositories, nothing pushed to GitHub.

1. `~/Development/aliro-doorlock-esp32/`
   - New repository. Apache-2.0.
   - 9 commits on `main` including seven phase-branch merges (each
     phase is also its own branch, for reviewing per-phase diffs).
   - Ready to push to `mullender/aliro-doorlock-esp32`.
2. `~/Development/esp-web-tools-fork/`
   - Fork of `esphome/esp-web-tools` at tag `10.4.0`.
   - Two commits: (1) vendor 10.4.0 unchanged, (2) add awaited
     `onPostFlash` callback (single feature commit on branch
     `homekey-post-install-hook`).
   - Ready to push to `mullender/esp-web-tools`.

## Branches, commits, and what to look at

`git log --oneline --graph --all` on the aliro repo will show the full
tree. Ordered checkpoints:

| Branch | Commit | What it holds |
|---|---|---|
| `main` | 9786a03 | current state after all merges |
| `phase-1-hardware-proof` | 29f76c2 | bring-up scripts (preflight, build, flash+monitor, capture_boot_log) |
| `phase-2-qr-renderer` | 9f55699 | Matter payload validator, QR renderer, test vectors + browser test harness |
| `phase-3-pairing-ui` | 2a77687 | full installer/index.html with pairing panel, platform tabs, dev mode |
| `phase-4a-esp-web-tools-fork` | 6b2444c | scripts/setup_vendor.sh + installer/vendor/UPSTREAM.md (fork tracking) |
| `phase-4b-boot-parser` | 7c53fd5 | boot log parser + 10 fixture tests + installer wiring |
| `phase-4c-deploy-workflow` | 6fffc0f | .github/workflows/deploy-installer.yml |
| `phase-5-firmware-overlay` | 6851c8d | firmware/DESIGN.md (stub, no code) |

## Things I actually ran end-to-end

- **Verhoeff check-digit self-test**: passed via node for the Matter
  shared example (`3497011233` body → check digit `2`).
- **Base38 alphabet check** of both known MT: encodings for the shared
  example: passed.
- **Boot log parser regexes** against 10 synthetic fixtures: 10/10
  passed via node.
- **esp-web-tools fork build**: `script/build` produced
  `dist/web/install-button.js` and per-chip loaders successfully after
  the callback patch was applied.

## Things I could not run

Hardware and GitHub. Specifically:

- Actual flashing of a NanoC6 (no bench access).
- Any phone commissioning through Apple/Google/HA.
- Pushing either local repo to GitHub — needs your account.
- Testing `installer/index.html` in a real browser (no browser
  automation available).

## Concrete next steps for you

Ordered from cheapest to most valuable.

### Immediate (5–10 minutes each)

1. **Open the test harness locally** and confirm all green:
   ```
   open ~/Development/aliro-doorlock-esp32/installer/tests/index.html
   ```
   Everything ran green via node, but a real browser confirms the
   QR renders visually and there are no console errors.

2. **Open the installer in dev mode** to review the pairing UX:
   ```
   open ~/Development/aliro-doorlock-esp32/installer/index.html?dev=1
   ```
   You should see the shared-example QR and the manual code, plus
   the Apple / Google / HA tabs. This works without the vendored
   fork and without any device.

3. **Skim the plan docs** in `docs/`. Confirm the direction still
   matches what you want before pushing anything public. Especially:
   - `docs/post_flash_matter_thread_pairing_plan.md` (the master plan)
   - `docs/run_aliro_door_lock_on_nanoc6_plan.md` (bring-up procedure)

### Push (10 minutes)

4. Create the two empty repos on GitHub:
   - `mullender/aliro-doorlock-esp32`
   - `mullender/esp-web-tools`

5. Push:
   ```
   cd ~/Development/aliro-doorlock-esp32
   git remote add origin git@github.com:mullender/aliro-doorlock-esp32.git
   git push -u origin main
   git push origin phase-1-hardware-proof phase-2-qr-renderer \
     phase-3-pairing-ui phase-4a-esp-web-tools-fork \
     phase-4b-boot-parser phase-4c-deploy-workflow phase-5-firmware-overlay

   cd ~/Development/esp-web-tools-fork
   git remote add origin git@github.com:mullender/esp-web-tools.git
   git push -u origin main homekey-post-install-hook
   ```

6. Run `scripts/setup_vendor.sh` in the aliro repo to attach the
   submodule and commit:
   ```
   cd ~/Development/aliro-doorlock-esp32
   scripts/setup_vendor.sh
   git commit -m "vendor: add esp-web-tools fork submodule"
   git push
   ```

### Hardware bring-up (this is the fun part)

7. Follow `docs/run_aliro_door_lock_on_nanoc6_plan.md` step by step.
   Every step has a check-off criterion. Record the boot log verbatim
   into a `lab_notes/YYYY-MM-DD-<slug>.md` file — that log becomes
   another fixture for the parser.

8. On first successful commissioning, publish an
   `aliro-c6-v0.0.1-devkit` GitHub Release with the built factory
   binary + its .sha256 sidecar. That release triggers the deploy
   workflow, which publishes the installer to Pages.

### Upstream esp-web-tools PR (whenever you have time)

9. File a `esphome/esp-web-tools` issue proposing the generic
   post-install serial callback. Link to the fork branch. If the
   maintainers say yes, follow with a PR from the fork branch.
10. Record the issue/PR URLs in
    `installer/vendor/UPSTREAM.md`.

## Known landmines I saw but did not fix

- **`installer/index.html`** falls back to the unpkg-CDN
  `esp-web-tools@10.4.0` if the vendored build is missing (Phase
  4a submodule not yet attached). The fallback prints a console
  warning and the pairing panel does not appear on flash — this is
  by design so the page loads at all during setup. Once the
  submodule is attached and `scripts/setup_vendor.sh` runs, the
  fallback never fires.

- **`matter onboardingcodes` fallback** in the boot parser requires
  `CONFIG_ENABLE_CHIP_SHELL=y` in the Aliro C6 build. Add to the
  bring-up plan's shopping list of things to confirm in Phase 1.

- **The `push` trigger** on `deploy-installer.yml` republishes on
  every commit to `installer/**`. If you want a stable Pages site
  during dev, either drop the `push` trigger or narrow the paths.

- **The workflow tolerates "no release yet"** so the first push
  publishes an empty-manifest site rather than failing. Once you
  cut `aliro-c6-v0.0.1-devkit`, the manifest becomes populated on
  the next workflow run.

- **The GitHub Actions license path** for vendoring:
  ESP Web Tools is Apache-2.0. Our repo is Apache-2.0. Vendoring
  with attribution in `installer/vendor/UPSTREAM.md` is compliant.
  `esp_aliro_lib` (Phase 5, firmware side) is a separate concern
  and needs a licence check before firmware binaries publish.

## Things I explicitly did NOT do

- No commits pushed anywhere.
- No PRs opened.
- No GitHub repos created.
- No firmware binaries built (that needs your bench).
- No secret/credential files created.
- No changes to `mullender/HomeKey-ESP32`.
- No changes to your old `~/Development/aliro-investigation/`
  directory (the plan docs still live there as originals; the copies
  in `docs/` are the ones that matter now).

## Confidence

- **High confidence:** the Matter payload validators, the boot log
  parser regexes, and the deploy workflow structure. All exercised
  against fixtures or against the actual esp-web-tools 10.4.0 source.
- **Medium confidence:** the pairing UI's platform-specific instructions
  (Apple/Google/HA) are written from the pairing plan text and public
  docs, not from live testing. Expect wording tweaks after real
  commissioning attempts.
- **Lower confidence:** the assumption that the Aliro C6 image will
  fit and boot cleanly under the currently-pinned esp-matter — the
  bring-up plan calls this out as Phase 1's whole reason for existing.

Any question, the answer is in `LEDGER.md` or `docs/`.
