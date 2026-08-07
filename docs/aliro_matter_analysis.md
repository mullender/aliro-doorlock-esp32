# Aliro + Matter on ESP32-C6: Analysis

**Status:** working document. Verified facts and proposals are marked separately.
**Date:** 2026-08-07
**Companion:** `aliro_matter_investigation.md` (evidence ledger — facts referenced as F<n>)

> Structural note: the deep-investigation template names this file `*_root_cause_analysis.md`.
> This is a feasibility study rather than a bug hunt, so the headings are adapted while keeping
> the core discipline — facts live in the ledger, everything speculative lives here with an
> explicit verification status.

---

## Executive Summary

**All four questions resolve favourably, but on different timescales.**

The NanoC6 path now works on hardware. The browser installer installs the
firmware. Apple Home commissions the device over Matter-over-Thread and adds a
Home Key to Apple Wallet. A valid tap unlocks the Matter lock (F26-F30). The
device reports two Apple fabric records (F31). The firmware source and
keep-setup manifests preserve NVS by design (F28). A keep-setup update on the
paired device, including retention of its Home Key, is not yet verified on
hardware. Aliro credentials are available in Google Wallet and Samsung Wallet
(F15). Home Assistant can be the only Matter controller (F22), but it cannot
manage Aliro credentials (F23, F24).

The real constraints are different from the ones expected:

1. **The Aliro protocol implementation is a binary blob** (F8). Everything else in the stack is
   source. For a project whose entire value so far has been an auditable, hand-verified reader,
   this is the significant trade.
2. **Who issues credentials to an Android friend is unresolved.** Android phones can *hold*
   Aliro credentials; whether the ecosystem you commission into will *issue* one to a Google
   Wallet user for a residential lock is unverified.
3. **Maturity.** The reference code is six weeks old (F25) and `M5Unit-NFC` is v0.1.0 with a
   dependency pinned to a moving branch (F11).

Release 0.0.4 is tap-to-unlock. It does not toggle the lock state (F30). The
requested rule for a later release is conditional. A valid tap always unlocks
a locked lock. If the lock is unlocked and auto-lock is off, a valid tap locks
it. If the lock is unlocked and auto-lock is on, a valid tap does not change
the state or restart the auto-lock timer. An active timer can lock it later.
This rule is a proposal. It needs a new build and a hardware test.

**On the M5 library question: do not swap the HomeKey driver.** The reasons are
in a separate section below.

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

**Verification status: VERIFIED end to end with Apple Home on the NanoC6**
(F26, F27). Google Home and Home Assistant commissioning are not verified.

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

**Hypothesis (UNVERIFIED):** Matter multi-admin can supply an Android user with
a key. Commission the lock into Apple Home and Google Home. Each service can
then provision an Aliro endpoint key to its wallet. The delegate supports 8
issuer keys and 8 endpoint keys (F12), which is consistent with multiple
administrators.

The NanoC6 boot log lists two Apple fabric records: Apple Home and Apple
Keychain (F31). This fact does not verify the hypothesis. No Google Home or
Home Assistant fabric was identified in the test, and the test did not show
two independent Aliro issuers.

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

## Proposal: separate Matter-over-Wi-Fi AtomS3 Lite build variant

**Recommendation: run a separate test build. Do not replace or rename the
NanoC6 variant.**

The verified dependencies support this proposal, but no S3 Aliro image has
been built or tested (F32).

### Verified inputs

- The AtomS3 Lite has an ESP32-S3 and 8 MB flash. It must use Wi-Fi for Matter
  because the ESP32-S3 has no Thread radio.
- The AtomS3 Lite and Unit NFC already work together on GPIO 2 and GPIO 1. The
  separate HomeKey-ESP32 work verified its browser install, Wi-Fi setup, Home
  Key taps, and GPIO 35 RGB LED.
- The pinned door-lock project has an ESP32-S3 target. Both `m5nfc` and the
  precompiled Aliro library include ESP32-S3 support.
- Matter can commission a Wi-Fi device over BLE. The phone supplies the Wi-Fi
  credentials during Matter commissioning. The S3 variant does not need a
  Thread border router.

### Proposed variant boundary

Create an independent `aliro-s3-*` development variant with these properties:

1. Use the same door-lock and Aliro source patches where they are portable.
2. Add an AtomS3 Lite overlay that enables Matter over Wi-Fi, keeps BLE
   commissioning, selects GPIO 2 and GPIO 1 for the Unit NFC, and uses GPIO 35
   for the RGB LED.
3. Give the S3 image its own release tag, build record, checksums, factory
   manifest, preserving-update manifest, and partition-layout identifier.
4. Add an explicit AtomS3 Lite choice to the Aliro installer. Keep the NanoC6
   choice and Thread instructions unchanged.
5. Describe Wi-Fi credentials as Matter commissioning data. Do not reuse the
   HomeKey-ESP32 Improv flow in the Aliro variant.

### Required tests before release

- Build the pinned door-lock application for ESP32-S3 and record image and
  partition sizes.
- Verify native USB boot logs and installer reset behavior on the AtomS3 Lite.
- Complete a factory install and Apple Home Matter-over-Wi-Fi commissioning.
- Confirm that Apple Home provisions the Aliro reader and that the Home Key
  unlock tap works.
- Complete a preserving update and confirm that the Wi-Fi network, Matter
  fabric, Aliro keys, and settings remain present.
- Verify the RGB pin and the valid, invalid, and non-Aliro tap results.

This board does not need a Thread border router. It does need Wi-Fi
credentials. It also needs its own release artifacts and hardware tests. A
separate variant keeps these differences separate from the NanoC6 build.

**Verification status: PROPOSED.** The dependencies and board wiring are
verified. The Matter-over-Wi-Fi Aliro build and its installer path are not.

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
| NanoC6 firmware builds and runs on the target hardware | VERIFIED | F26 |
| Apple Home accepts the test-attestation device and provisions Home Key | VERIFIED | F26, F27 |
| Browser factory install works on NanoC6 | VERIFIED | F29 |
| Firmware source and keep-setup manifests preserve NVS by design | VERIFIED | F28 |
| A paired keep-setup update retains fabrics, Thread and Aliro data, settings, and the Home Key | UNVERIFIED | Run the update on the commissioned NanoC6, confirm that both fabric records remain, and test the existing Home Key |
| A valid release 0.0.4 tap unlocks but does not toggle | VERIFIED | F30 |
| The boot log lists Apple Home and Apple Keychain fabrics | VERIFIED | F31 |
| **Matter multi-admin lets Apple + Google each issue Aliro keys** | **UNVERIFIED** | Add a non-Apple fabric and check whether its `SetAliroReaderConfig` call replaces the Apple configuration |
| **Google Home issues Aliro credentials for residential locks** | **UNVERIFIED** | The one concrete Google Wallet + Aliro artefact is Kastle's *corporate badge* — commercial, not home |
| **Android express tap works against this reader** | **UNVERIFIED** | F18 — Polling Loop Annotations vs ECP; needs a logic-analyser observation since the library is a blob |
| **A valid tap locks an unlocked lock when auto-lock is off** | **PROPOSED** | The requested rule is not part of release 0.0.4; build and hardware tests are required |
| **AtomS3 Lite can run this Aliro lock over Matter-over-Wi-Fi** | **PROPOSED** | F32 confirms compatible parts; build and hardware tests are still required |
| Uncertified accessories lose some Apple features | PLAUSIBLE | iOS strings warn an uncertified accessory may lose Approach to Unlock / Tap to Unlock (kormax) |

---

## Relation to the Original Question

The question asked whether the door_lock example could run Matter-over-Thread on an M5NanoC6 with
Aliro, and whether that combination solves provisioning, Android support, and hub-free HA
integration.

- **Thread on NanoC6:** yes, and the release now works on hardware (F3, F5, F26).
- **Provisioning:** solved and verified with Apple Home (F26, F27, F29).
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

1. **Add a non-Apple fabric** from Home Assistant or Google Home. Then read the
   Aliro reader configuration. The two observed Apple fabrics do not answer
   the multi-admin question.
2. **If the non-Apple fabric works, try a Google Wallet key** on an Android
   phone. This is the original Android goal.
3. **Test the paired keep-setup update.** Confirm that both Apple fabric
   records, Thread and Aliro data, settings, and the existing Home Key remain.
4. **Run the AtomS3 Lite test build.** Keep it as a separate Matter-over-Wi-Fi
   variant until all tests in the proposal pass.
5. **Build and test the proposed tap rule as a new release.** Keep the verified
   0.0.4 behavior in the evidence record.
6. **Watch OpenHomeFoundation #17 / core PR #161936.** HA Aliro credential support would remove
   the last dependency on an Apple or Google hub.
7. **Leave HomeKey-ESP32 alone.** Land the five PRs as they are. Revisit the ISO-DEP chaining
   question only if an attestation-flow failure is actually observed.

## Things That Would Change This Analysis

- If multi-admin `SetAliroReaderConfig` proves destructive, the Android goal needs a different
  mechanism entirely (or a Google-Home-only deployment, losing Apple).
- If HA ships Aliro credential management, this becomes strictly better than HomeKey-ESP32 on
  every axis except source availability of the crypto.
- If the S3 build does not fit its selected OTA layout, the Wi-Fi variant needs a
  different partition design or must be dropped.
- If Espressif open-sources `esp_aliro_lib`, the main objection disappears.
