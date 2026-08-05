# Aliro + Matter on ESP32-C6: Analysis

**Status:** working document — hypotheses and recommendations, revised as facts land.
**Date:** 2026-07-31
**Companion:** `aliro_matter_investigation.md` (evidence ledger — facts referenced as F<n>)

> Structural note: the deep-investigation template names this file `*_root_cause_analysis.md`.
> This is a feasibility study rather than a bug hunt, so the headings are adapted while keeping
> the core discipline — facts live in the ledger, everything speculative lives here with an
> explicit verification status.

---

## Executive Summary

**All four questions resolve favourably, but on different timescales.**

The reference implementation targets the exact hardware already on the desk, down to the I2C
pins (F1, F2). Matter-over-Thread and BLE commissioning are configured and working in
Espressif's own config (F3, F4). Android is *not* the blocker it first appeared — Aliro is
shipping in Google Wallet and Samsung Wallet today (F15). Home Assistant can already be the sole
controller (F22) but cannot yet manage Aliro credentials (F23, F24).

The real constraints are different from the ones expected:

1. **The Aliro protocol implementation is a binary blob** (F8). Everything else in the stack is
   source. For a project whose entire value so far has been an auditable, hand-verified reader,
   this is the significant trade.
2. **Who issues credentials to an Android friend is unresolved.** Android phones can *hold*
   Aliro credentials; whether the ecosystem you commission into will *issue* one to a Google
   Wallet user for a residential lock is unverified.
3. **Maturity.** The reference code is six weeks old (F25) and `M5Unit-NFC` is v0.1.0 with a
   dependency pinned to a moving branch (F11).

**On the M5 library question: no — don't swap the HomeKey driver.** Recommendation and reasoning
in its own section below.

---

## Goal 1: Provisioning — SOLVED

Matter's commissioning flow replaces the captive portal entirely.

- BLE peripheral is enabled in the Aliro config (F4); commissioning runs over BLE from the phone
  (F22), then the device is handed network credentials.
- On the Thread build there is **no WiFi credential at all** (F3) — the device joins a Thread
  network via the border router, so the entire class of "how does the device learn the WiFi
  password" problem disappears.
- HA commissions through the iOS or Android Companion app over Bluetooth (F22).

This directly answers the reminder item raised earlier ("provisioning WiFi credentials through
HomeKit, scan barcode transfer"). Matter's answer is better than the HomeKit equivalent: it is
standardised, works from both iOS and Android, and on Thread removes the credential entirely.

**Verification status: VERIFIED by configuration, UNVERIFIED end-to-end** (not yet built/run).

---

## Goal 2: Android support — POSSIBLE, WITH AN UNRESOLVED LINK

This is where my initial read was wrong and needs correcting.

### What is now established (F15, F16)

Android is not a future promise. Google Play Services has registered both Aliro AIDs
(`A000000909ACCE5501` / `...5502`) since at least May 2024, declared as **host-based HCE** with
`requireDeviceUnlock="false"` — i.e. express-style tap without unlocking. kormax observes Aliro
credentials live in **Google Wallet (protocol v0.9)** and **Samsung Wallet (v1.0)**, alongside
Apple Wallet (v0.9, and v1.0 since iOS 26.4). Android 15 ships an Aliro UWB support library
mirroring the CCC Digital Car Key structure exactly.

The HCE detail matters: in other UnifiedAccess protocols the credential applet lives on the
secure element. Aliro declaring both AIDs host-based suggests deliberately broad Android reach,
since many Android devices lack an SE but have a TEE.

### Reconciling F19 and F20 (the apparent contradiction)

CSA says key sharing is *not* in 1.0 (F20). kormax documents evictable endpoint keys, access
schedules and offline sharing (F19). These are not actually in conflict:

- **Within an ecosystem**, sharing exists — Apple routes it through HomeKit Guest, and the
  credential model (`kAliroEvictableEndpointKey`) is built for it. iOS 18 ships "Access Schedule"
  UI strings.
- **Across ecosystems** — an iPhone owner sharing a key to a friend's Google Wallet — is what
  CSA defers to a future phase.

**Hypothesis (UNVERIFIED):** the practical path to an Android friend's key is not cross-ecosystem
sharing but **Matter multi-admin**. Commission the lock into both Apple Home and Google Home;
each fabric provisions its own Aliro endpoint keys into its own wallet. The delegate supports 8
issuer keys and 8 endpoint keys (F12), which is consistent with multiple administrators.

**What would break this:** `SetAliroReaderConfig` sets a *single* reader config — one signing
key, one group identifier (F12). If the second fabric overwrites the first's reader config rather
than adding credentials alongside it, multi-admin Aliro would clobber the Apple keys. This is the
single most important thing to test and I have not verified it either way.

### The express-mode gap (F17, F18)

Even with a credential issued, tap-to-unlock behaviour differs by platform:

- Aliro readers use ECP TCI `204220`, distinct from HomeKey's `021100`, and the Aliro applet is
  **not available when express mode is triggered with the HomeKey TCI** (F17). A reader cannot
  serve both from one trigger — it must poll for both.
- Android's Observe Mode wants **Polling Loop Annotations** (Android 15), not ECP (F18). kormax
  records it as an open question whether Google/Samsung reuse ECP or require an Android-specific
  format, and whether that is even in-spec or a per-OEM arrangement.

So an Android tap may require reader-side work that Espressif's SDK may or may not do. Worth
checking `esp_aliro_lib`'s polling behaviour — though being a blob (F8), that means observing it
on a logic analyser rather than reading it.

**Verification status: PARTIALLY VERIFIED.** Android *can* hold Aliro credentials (F15,
confirmed by independent reverse engineering). Whether *your* lock can issue one, and whether
express tap works on Android, is UNVERIFIED.

---

## Goal 3: Direct Home Assistant integration — HALF SOLVED

**Control: solved today.** HA is a full Matter controller with its own fabric, commissions over
BLE via the Companion app, and can be its own Thread border router using a ZBT-1/ZBT-2 — no
Apple or Google hardware anywhere in the path (F22). Lock/unlock, state, and automations work
through the standard Matter Door Lock cluster.

**Aliro credential management: not yet.** HA's documented lock actions
(`set_lock_credential`, `get_lock_credential_status`, …) are PIN-oriented and Aliro is not
mentioned (F23). OpenHomeFoundation goals #17 lists Aliro as **Epic 2, "evaluate"** — high
priority, explicitly aiming "to become first Open Source platform to support it", but unstarted.
The active work (Phase 1, core PR #161936) is generic Matter lock credentials (F24).

**Implication:** if you commission the lock *only* into HA today, you get a Matter lock you can
automate — but nothing puts a key in anyone's wallet, because no one is issuing Aliro
credentials. You would need Apple Home (or Google Home) in the fabric as the credential issuer,
with HA alongside via multi-admin.

That is a meaningful caveat against the "no HomeKit hub required" goal: hub-free *control*, yes;
hub-free *key issuance*, not yet. The generic Matter lock credential work landing first (F24)
suggests Aliro credential support is a plausible 2026 addition, and #17 explicitly wants HA to
be first — but it is a roadmap item, not a capability.

**Verification status: VERIFIED for control, VERIFIED-ABSENT for Aliro credentials.**

---

## Decision: should HomeKey-ESP32 adopt the M5 NFC library?

**Recommendation: no — not for the PRs now in flight, and probably not at all in that form.
Consider harvesting only the ISO-DEP layer, later, if the attestation flow needs it.**

### Against adoption

| Concern | Evidence |
|---|---|
| Dependency weight is enormous relative to the problem | 27,038 lines across 62 files replacing a self-contained 793-line backend (F9, F11) |
| Hard dependency on a **moving branch** | `M5Unit-NFC/idf_component.yml` pins `m5stack/M5UnitUnified` to `main`, unversioned (F11) — an unpinned upstream in a lock's firmware |
| Not separable | 37 of 63 files reference the M5 framework; `unit_ST25R3916.hpp` requires `<M5UnitComponent.hpp>` (F11) |
| Maturity | M5Unit-NFC is **v0.1.0** (F9) |
| Directly contradicts the target repo's contribution rules | `HomeKey-ESP32/CONTRIBUTING.md` states "no unnecessary dependencies". The `qrcode-generator` addition (~7.7 KB, zero deps) is already a likely review point; a 27k-line vendor framework is a different order of magnitude |
| Would discard verified work | The current backend is measured and hardware-verified: FAST-flow auth 130–160 ms, full transaction 155–190 ms, clean build, real iPhone end-to-end. A swap invalidates all of it |
| Buys little for this use case | The backend already handles RATS, I-block framing, block-number toggling, S(WTX) and R(NAK) recovery |

### For adoption — the one genuine gap

M5's ISO-DEP implements **chaining in both directions** (F10), which the hand-written backend
does not. The PR text already documents this honestly: every Home Key command observed fits the
card's 256-byte FSC, but the **attestation flow has not been exercised**. If ATTESTATION turns
out to exceed FSC, chaining becomes necessary rather than theoretical.

### The middle path

`isoDEP.hpp` includes only `<cstdint>` and `<vector>`, and reaches hardware through an abstract
`NFCLayerInterface`; `isoDEP.cpp` adds only `M5Utility.hpp` for logging (F11). The layer is
**865 lines and genuinely decoupled** from the M5 framework. If chaining is ever needed, adapting
that one layer — or simply reading it as a reference implementation while writing ~80 lines of
chaining into the existing `exchangeApdu()` — is far cheaper than adopting the whole library.

Note the licence asymmetry: M5Unit-NFC is MIT, HomeKey-ESP32 is GPL-family. MIT code can be
incorporated with attribution; check the direction before copying anything verbatim.

### Strategic point

If the Matter+Aliro path proves out, HomeKey-ESP32 becomes the legacy Apple-only route and the
M5 library arrives *for free* on the Aliro side (F9) without touching HomeKey at all. Investing
in a large driver swap on the path being superseded is doubly unattractive.

**Verification status: VERIFIED** (dependency structure inspected directly).

---

## Verification Status Summary

| Claim | Status | Evidence / what's needed |
|---|---|---|
| Reference implementation targets NanoC6 + Unit NFC on the same pins | VERIFIED | F1, F2 |
| Aliro config is Matter-over-Thread with BLE commissioning | VERIFIED | F3, F4 |
| Firmware fits 4 MB with dual OTA | VERIFIED | F6 |
| Aliro protocol library is closed-source | VERIFIED | F8 |
| NFC stack is open source, with ISO-DEP chaining | VERIFIED | F9, F10 |
| M5 library is not a viable drop-in for HomeKey-ESP32 | VERIFIED | F11 |
| Aliro credentials ship in Google and Samsung Wallets | VERIFIED (third-party RE) | F15 — kormax; independently corroborated by Play Services manifest + Android UWB module |
| HA can control the lock with no Apple/Google hub | VERIFIED | F22 |
| HA cannot manage Aliro credentials | VERIFIED (absent) | F23, F24 |
| **Matter multi-admin lets Apple + Google each issue Aliro keys** | **UNVERIFIED** | Test: commission into two fabrics, check whether the second `SetAliroReaderConfig` clobbers the first |
| **A test-DAC device can be commissioned into Apple Home** | **UNVERIFIED** | Only evidence is connectedhomeip issue #25743 (Mar 2023): Apple accepted test attestation, Google Home rejected a custom VID. Dated, single report, still open, no maintainer response |
| **Google Home issues Aliro credentials for residential locks** | **UNVERIFIED** | The one concrete Google Wallet + Aliro artefact is Kastle's *corporate badge* — commercial, not home |
| **Android express tap works against this reader** | **UNVERIFIED** | F18 — Polling Loop Annotations vs ECP; needs a logic-analyser observation since the library is a blob |
| **The example builds and runs on the NanoC6** | **UNVERIFIED** | Just build it |
| Uncertified accessories lose some Apple features | PLAUSIBLE | iOS strings warn an uncertified accessory may lose Approach to Unlock / Tap to Unlock (kormax) |

---

## Relation to the Original Question

The question asked whether the door_lock example could run Matter-over-Thread on an M5NanoC6 with
Aliro, and whether that combination solves provisioning, Android support, and hub-free HA
integration.

- **Thread on NanoC6:** yes, and it is Espressif's default for the Aliro build (F3, F5).
- **Provisioning:** solved, and more cleanly than the HomeKit equivalent originally imagined.
- **Android:** the standard and the phones are ready (F15); the *issuance* path for a residential
  lock is the open question, not the phone.
- **HA without a HomeKit hub:** control yes, key issuance not yet (F22–F24).

The investigation diverged in one respect worth flagging: the expected blocker was Android
platform support, and that turned out to be largely solved. The actual blockers are the
**closed-source protocol library** and the **credential-issuance path**, neither of which was in
the original framing.

---

## Recommended Next Steps

Ordered by information gained per unit of effort.

1. **Build it.** `idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro" set-target esp32c6 build`
   in `~/Development/esp-matter/examples/door_lock`. Costs nothing but time, and settles the
   "does it fit and compile" question. Needs the ESP-IDF version esp-matter pins (check its CI,
   as the HomeKey repo taught us — its `idf_component.yml` claim was wrong).
2. **Flash the NanoC6 and commission into Apple Home.** Settles the test-DAC question and the
   headline claim that a key auto-appears in Apple Wallet. The Unit NFC would need freeing from
   the AtomS3.
3. **Then commission into a second fabric** (HA, and Google Home if available) and re-read the
   Aliro reader config. This is the multi-admin question — the one that decides whether the
   Android goal is reachable at all.
4. **If step 3 works, try a Google Wallet key** on an Android phone. This is the actual goal.
5. **Watch OpenHomeFoundation #17 / core PR #161936.** HA Aliro credential support would remove
   the last dependency on an Apple or Google hub.
6. **Leave HomeKey-ESP32 alone.** Land the five PRs as they are. Revisit the ISO-DEP chaining
   question only if an attestation-flow failure is actually observed.

## Things That Would Change This Analysis

- If multi-admin `SetAliroReaderConfig` proves destructive, the Android goal needs a different
  mechanism entirely (or a Google-Home-only deployment, losing Apple).
- If Apple Home rejects test DACs, the whole path needs either a real DAC or a
  Google-Home/HA-only deployment.
- If HA ships Aliro credential management, this becomes strictly better than HomeKey-ESP32 on
  every axis except source availability of the crypto.
- If Espressif open-sources `esp_aliro_lib`, the main objection disappears.
