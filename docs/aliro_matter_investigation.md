# Aliro + Matter on ESP32-C6: Investigation

**Status:** working document — open investigation, facts added as verified.
**Last updated:** 2026-07-31

## Original Question

> Next I want to dig into https://github.com/espressif/esp-matter/tree/main/examples/door_lock
> their door lock example, which uses matter possibly over thread on my m5nanoc6? Anyway, they
> also support aliro the new cross platform 'homekey' standard. Together these could solve a few
> issues: provisioning (I believe matter has a BLE protocol to provision a device to thread or
> wifi), android support, so I can share house keys with all my friends :) direct home-assistant
> integration (no homekit hub required)
> see:
> - https://developer.espressif.com/blog/2026/07/espressif-aliro-solution/
> - https://www.espressif.com/en/news/ESP_Aliro_Release
> - https://www.home-assistant.io/actions/matter.get_lock_credential_status/
> - https://github.com/OpenHomeFoundation/goals/issues/17
>
> Find out what is possible

Follow-up: *"also should we update our homekit code to use the full m5nfc library?"*

## Scope

Three goals to assess, plus one engineering decision:

1. **Provisioning** — replace manual WiFi credential entry with a phone-driven flow.
2. **Android support** — issue house keys to non-Apple friends.
3. **Direct Home Assistant integration** — no HomeKit hub in the path.
4. **Decision:** should `HomeKey-ESP32`'s `St25r3916Reader` be replaced by M5Stack's NFC library?

Context: an ST25R3916 reader backend for `rednblkx/HomeKey-ESP32` was built and verified on
hardware (see `~/Development/homekey-pr-notes/`). That work is Apple-Home-Key-only, over WiFi,
using HomeSpan. This investigation asks whether the Matter+Aliro path supersedes it.

---

## Confirmed Facts

### 1. The esp-matter door_lock example targets exactly the hardware already owned
`examples/door_lock/README.md` names the required hardware for the Aliro feature:
M5Stack **NanoC6** (or NanoH2) plus **M5Unit-NFC**. Build command:
`idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro" set-target esp32c6 build`.

### 2. The reader pin configuration is identical to the existing HomeKey build
`examples/door_lock/sdkconfig.esp32c6.aliro`:
```
CONFIG_ST25R3916_PIN_SDA=2
CONFIG_ST25R3916_PIN_SCL=1
```
Same M5 Grove/HY2.0 port pinout already in use (SDA=2, SCL=1). M5 docs list the NanoC6
PORT.CUSTOM wires as Yellow=G2, White=G1, consistent with this assignment.

### 3. The Aliro configuration is genuine Matter-over-Thread, not WiFi
Same file:
```
CONFIG_OPENTHREAD_ENABLED=y
CONFIG_OPENTHREAD_MTD=y
CONFIG_ENABLE_WIFI_STATION=n     # "Disable Matter over Wi-Fi"
CONFIG_ENABLE_ROUTE_HOOK=n       # "unnecessary for Thread device"
```
Configured as a Minimal Thread Device (MTD).

### 4. BLE is enabled for commissioning
Same file: `CONFIG_BT_ENABLED=y`, `CONFIG_BT_NIMBLE_ENABLED=y`, with central/observer roles
disabled (peripheral only — the commissioning role).

### 5. M5NanoC6 hardware supports the required radios
ESP32-C6FH4, RISC-V single core @160 MHz, 4 MB flash, Thread 1.3 and Zigbee 3.0 (802.15.4),
WiFi 6. Ceramic onboard antenna, no u.FL connector. (M5Stack docs)

### 6. The firmware fits 4 MB flash with dual OTA
`examples/door_lock/partitions.csv`: two app slots of `0x1E0000` each, plus `esp_secure_cert`
(`0x2000`, encrypted), `nvs`, `nvs_keys` (encrypted), `fctry` (`0x6000` at `0x3E0000`) and a
`coredump` partition. Total reaches `0x3E6000` of `0x400000`.

### 7. Aliro is part of the upstream Matter specification, not an Espressif extension
`connectedhomeip/src/app/clusters/door-lock-server/door-lock-server.h` defines
`AliroProvisioning`, `AliroBLEUWB`, `AliroReaderConfig`,
`AliroExpeditedTransactionSupportedProtocolVersions`, `AliroSupportedBLEUWBProtocolVersions`,
and the `SetAliroReaderConfig` / `ClearAliroReaderConfig` command handlers.

### 8. `esp_aliro_lib` is a precompiled binary blob
`components/esp_aliro_lib/` in `espressif/esp-aliro` contains only three public headers
(`esp_aliro.h`, `esp_aliro_types.h`, `esp_aliro_utils.h`) plus **prebuilt static libraries**:
`lib/<target>/libesp_aliro_idf{52,53,54,55,60}.a` for 10 targets
(esp32, c2, c3, c5, c6, c61, h2, p4, s2, s3). The esp32c6 archives are ~412–423 KB each.
The repository LICENSE is Apache-2.0, but **the Aliro protocol implementation itself is not
published as source**. Latest `esp_aliro_lib` on the component registry is v1.1.0, uploaded
2026-07-30; esp-matter currently pins `^1.0.1`.

### 9. The NFC stack, by contrast, is fully open source
Dependency chain from `examples/door_lock/main/idf_component.yml`:
- `m5nfc` — 176-line wrapper, from `espressif/esp-aliro`, path `examples/aliro_reader/components/m5nfc`
- → `m5stack/M5Unit-NFC` — **MIT**, 62 source files, 27,038 lines, v0.1.0.
  Covers NFC-A/B/F/V, MIFARE, Crypto1, ISO-DEP and card emulation for the ST25R3916.

### 10. M5's ISO-DEP implements chaining in both directions
`M5Unit-NFC/src/nfc/isoDEP/isoDEP.cpp`: `// Transmit chaining` (line 154),
`// ACK (chaining) -> next chunk` (288), `// Response chaining: send R-ACK and receive next
I-Block (WTX may appear)` (327). This is the limitation explicitly documented as absent in
the hand-written `St25r3916Reader` backend.

### 11. M5Unit-NFC is deeply coupled to the M5UnitUnified framework, but its ISO-DEP layer is not
- `idf_component.yml` declares a hard dependency on `m5stack/M5UnitUnified` pinned to
  **branch `main`** (unversioned/moving); `library.json` says `>=0.5.0`.
- 37 of 63 source files reference `M5UnitUnified` / `m5::unit` / `M5_LIB_LOG`.
- `src/unit/unit_ST25R3916.hpp` includes `<M5UnitComponent.hpp>`.
- **However** `src/nfc/isoDEP/isoDEP.hpp` (322 lines) includes only `<cstdint>` and `<vector>`,
  and talks to hardware through an abstract `NFCLayerInterface`. `isoDEP.cpp` (543 lines) adds
  only `M5Utility.hpp` (logging) beyond internal headers.

### 12. The Aliro door-lock delegate is a real implementation, not a stub
`examples/door_lock/main/lock/aliro_door_lock_delegate.cpp`:
- `GetNumberOfAliroCredentialIssuerKeysSupported()` → 8
- `GetNumberOfAliroEndpointKeysSupported()` → 8
- `SetAliroReaderConfig()` validates sizes: groupIdentifier 16 B, signingKey 32 B,
  verificationKey 65 B; persists to NVS via `ESP32Config::WriteConfigValueBin`.
- Reader keys are provisioned **over Matter by the ecosystem**, not compiled in.

### 13. Espressif's Aliro SDK is NFC-only today
The Espressif blog (2026-07) states the SDK ships "initial support for Aliro over NFC" and that
"Bluetooth LE and UWB support are planned for a future release." Aliro itself defines NFC,
BLE, and BLE+UWB transports. kormax independently notes only NFC transport type `0x5E` is
documented as current practice.

### 14. Aliro 1.0 was released 2026-02-26
CSA announcement. Certification programme and Authorized Test Labs exist (Allion Labs
announced Aliro 1.0 test capability). Expected early certifiers include Apple, Google, Samsung,
Allegion, Aqara, HID, Kastle, Kwikset, Nordic, NXP, Qorvo, ST.

### 15. Aliro is shipping in all three major wallets — including Android
From kormax's research (`kormax/aliro`), protocol versions observed in the wild:
- **v0.9** — Apple Wallet and **Google Wallet**
- **v1.0** — Apple Wallet (since iOS 26.4) and **Samsung Wallet**

Screenshots in the repo show an Aliro Home Key with UWB settings in Apple Wallet, a Home Key in
Samsung Wallet, and a card in Google Wallet. Google Play Services (May 2024 build) registers
both Aliro AIDs — `A000000909ACCE5501` (primary) and `A000000909ACCE5502` (step-up) — as a
`host-apdu-service` with `requireDeviceUnlock="false"` and `requireDeviceScreenOn="false"`.
Notably **both AIDs are declared host-based (HCE)**, unlike other UnifiedAccess protocols where
applet #1 lives on the secure element. Android 15 also ships an Aliro UWB support library
(`packages/modules/Uwb/.../support/aliro/`) mirroring the CCC Digital Car Key structure exactly.

### 16. Aliro's protocol is a UnifiedAccess relative of Apple Home Key
kormax: ISO7816 APDUs over NFC/BLE, "closely following UnifiedAccess-family protocols
(CCC CarKey, Apple HomeKey) but with different cryptography, command parameters, and some
expanded capabilities." Command set: SELECT `A4`, AUTH0 `80`, LOAD CERTIFICATE `D1`,
AUTH1 `81`, EXCHANGE `C9`, CONTROL FLOW `3C`, ENVELOPE `C3`, GET RESPONSE `C0`.
Reader identity = 16-byte group ID + 16-byte instance ID. FAST path derives from a stored
endpoint persistent key; readers must brute-force candidate persistent keys until match.
Crypto is AES-GCM secure messaging with directional keys and per-direction counters; ECDSA
signatures over BER-TLV preimages.

### 17. Matter-based Aliro locks use a different ECP TCI from Home Key
kormax: Aliro uses ECP TCI `204220`; HomeKey uses `021100`. The two applets can coexist in one
pass but are **mutually exclusive per trigger** — the Aliro applet is not available when express
mode is triggered with the HomeKey TCI. As with HomeKey, the final 8 bytes of the ECP frame must
carry the reader group identifier.

### 18. Android express/tap-to-unlock needs a different polling mechanism than ECP
kormax: for Android's Observe Mode, readers need **Polling Loop Annotations** (added in
Android 15), not Apple's ECP. "Samsung and Google wallets may reuse ECP or a custom
Android-only format." He records this as an open question — whether it sits outside the spec
(requiring per-OEM deals) or converges on a shared format.

### 19. Aliro's design includes credential sharing and revocation primitives
kormax, from Matter + iOS symbols: credential types are `kAliroCredentialIssuerKey`,
`kAliroEvictableEndpointKey`, `kAliroNonEvictableEndpointKey`, all 65 bytes
(`DOOR_LOCK_ALIRO_CREDENTIAL_SIZE = 65`). Claimed feature set includes offline sharing of an
`EvictableEndpoint`, automatic credential generation for devices joining a Matter home
(`Issuer -> NonEvictableEndpoint`), and constraints by time of day, day of week, and limited
use by date or count. iOS 18 strings confirm scheduling on Apple's side
(`PASS_DETAILS_SHOW_ACCESS_SCHEDULE_TITLE` = "Access Schedule"), which the author reads as
evidence of sharing, likely routed through HomeKit's Guest feature.

### 20. CSA states cross-ecosystem key sharing is not in Aliro 1.0
The CSA 1.0 announcement calls 1.0 "the foundation of a living standard, not a one-time effort,"
with future phases targeting "expanded use cases like secure key sharing." Note this is in
tension with fact 19 — see the analysis document for how the two are reconciled.

### 21. Apple's provisioning for home keys is local; commercial keys are server-mediated
kormax, from PassKit symbols: `createAliroHomeKey(seid, readerIdentifier, readerPublicKey,
homeIdentifier)` versus `createAliroHydraKey(seid, serverParameters)`. `Hydra` is the codename
for non-home UnifiedAccess passes. Home credentials provision locally; commercial ones involve
a server, read by the author as a paid path.

### 22. Home Assistant is a full Matter controller and can be its own Thread border router
HA docs: HA runs its own Matter fabric via the Matter Server add-on; devices can be commissioned
directly to HA rather than shared in from Apple/Google. Commissioning goes through the iOS or
Android Companion app over Bluetooth. A Thread border router is needed only for Thread devices
and can be HA itself via OpenThread Border Router with Connect ZBT-1, ZBT-2 or SkyConnect —
Apple/Google hardware is not required.

### 23. Home Assistant has Matter lock credential actions, but not Aliro
HA documents `matter.get_lock_info`, `get_lock_users`, `set_lock_user`, `clear_lock_user`,
`set_lock_credential`, `get_lock_credential_status`, `clear_lock_credential`. Examples given are
PINs. **Aliro is not mentioned** in the Matter integration documentation.

### 24. Home Assistant Aliro support is planned but unstarted
`OpenHomeFoundation/goals` issue #17 ("Leverage a more consistent credential management
approach"), opened 2025-12-18 by mkerstner, Open, 3 of 5 sub-issues complete.
**Epic 2 is "evaluate Aliro" (Priority: High)** — "to become first Open Source platform to
support it," noting Aliro is "aiming for an official launch in 2026."
Progress recorded: Jan 2026 alignment on Matter-locks-only support; Feb 2026 decision to use
that as the technical baseline, Phase 1 = core PR #161936; credentials to be attached to a
device rather than an HA user. Frontend work is PR #28672, gated on backend.
Also noted: Z-Wave "is not yet supported by Aliro."

### 25. Aliro landed in esp-matter six weeks ago
`git log examples/door_lock`:
```
2026-07-20 5189bd8d examples/door_lock: conditionally gate m5nfc component
2026-07-17 ed818ee1 examples/door_lock: use shared m5nfc component
2026-06-15 705e3be6 add aliro feature for door lock example
```
The first Aliro-referencing PR in connectedhomeip was #31144 (January, per kormax).

---

## Architecture (relevant paths)

**Reader firmware (esp-matter door_lock, Aliro build):**
```
examples/door_lock/main/app_main.cpp
  └─ lock/aliro_door_lock_delegate.cpp     implements chip::app::Clusters::DoorLock::Delegate
       ├─ esp_aliro.h            → libesp_aliro_<target>_idf<ver>.a   [BINARY BLOB]
       └─ m5nfc.h                → m5nfc.cpp (176 lines, Espressif)   [SOURCE]
            └─ M5Unit-NFC (MIT, 27k lines)                            [SOURCE]
                 ├─ unit/unit_ST25R3916.cpp      chip driver
                 ├─ nfc/layer/a/nfc_layer_a_*    NFC-A, anticollision
                 └─ nfc/isoDEP/isoDEP.cpp        ISO-DEP + chaining + WTX
```

**Credential flow:**
```
Ecosystem admin (Apple Home / Google Home / HA)
  │  Matter: SetAliroReaderConfig(signingKey 32B, verificationKey 65B,
  │                               groupIdentifier 16B, [groupResolvingKey 16B])
  ▼
Reader NVS  ──►  esp_aliro_reader handle
  │
  │  Matter: credential add — kAliroCredentialIssuerKey / kAliroEvictableEndpointKey
  │                         / kAliroNonEvictableEndpointKey  (65 B each, max 8 + 8)
  ▼
Phone wallet (Apple / Google / Samsung) holds endpoint key
  │
  ▼  NFC tap: SELECT A000000909ACCE5501 → AUTH0 → [LOAD CERT] → AUTH1 → EXCHANGE → CONTROL FLOW
Reader grants access
```

**Comparison with the existing HomeKey-ESP32 stack:**
```
HomeKey-ESP32 (current)                 esp-matter door_lock + Aliro
─────────────────────────────────────   ─────────────────────────────────────
HomeSpan (HAP), WiFi                    Matter, Thread (or WiFi)
Apple Home Key only                     Aliro: Apple + Google + Samsung wallets
ECP TCI 021100                          ECP TCI 204220 (+ Android polling annotations)
St25r3916Reader.cpp (793 lines, ours)   M5Unit-NFC (27k lines, MIT, vendor)
All source, auditable                   Aliro crypto is a binary blob
No ISO-DEP chaining                     ISO-DEP chaining both directions
WiFi credentials via captive portal     BLE commissioning
Verified working on hardware            Not yet built or run here
```

---

## Timeline

| Date | Event | Impact |
|---|---|---|
| 2024-05 | Aliro AIDs found in Google Play Services (kormax) | Android HCE support in place early |
| 2025-01 | connectedhomeip PR #31144, first Aliro reference | Matter cluster work begins |
| 2025-08 | Kastle announces first corporate badge in Google Wallet to support Aliro | Google Wallet + Aliro, commercial |
| 2025-12-18 | OpenHomeFoundation goals #17 opened | HA credential management effort starts |
| 2026-02 | HA decides Matter-lock-only baseline, Phase 1 = core PR #161936 | Aliro still only "evaluate" |
| 2026-02-26 | **CSA releases Aliro 1.0** | Spec final; certification opens |
| 2026-06-15 | `add aliro feature for door lock example` (esp-matter 705e3be6) | Reference implementation lands |
| 2026-07-17/20 | m5nfc component shared and gated (ed818ee1, 5189bd8d) | Refinement |
| ~2026-07-30 | `esp_aliro_lib` v1.1.0 published | esp-matter still pins ^1.0.1 |
| 2026-07-31 | This investigation | — |

---

## Things Excluded

| # | Theory | Why excluded |
|---|---|---|
| 1 | "The ST25R3916 driver would need porting to the Matter stack" | Fact 9 — M5Stack ships an MIT ST25R3916 driver and Espressif already wraps it in `m5nfc`. No porting required. |
| 2 | "Aliro's cryptography would need implementing" | Fact 8 — `esp_aliro_lib` provides it. (At the cost of being closed-source.) |
| 3 | "The M5NanoC6 can't do Thread" | Fact 5 — ESP32-C6 has an 802.15.4 radio; M5 documents Thread 1.3. |
| 4 | "A HomeKit hub / Apple TV is required" | Fact 22 — HA runs its own Matter fabric and can be its own Thread border router. |
| 5 | "Provisioning still needs WiFi credentials typed into a captive portal" | Facts 3, 4, 22 — BLE commissioning; on Thread there is no WiFi credential at all. |
| 6 | "Aliro is Apple-only in practice, like Home Key" | Fact 15 — Google Wallet (v0.9) and Samsung Wallet (v1.0) have shipping implementations; Play Services registers both AIDs as HCE. |
| 7 | "Aliro is still a draft / not finalised" | Fact 14 — 1.0 released 2026-02-26 with a certification programme. |
| 8 | "Home Assistant can already manage Aliro credentials" | Facts 23, 24 — HA's lock credential actions are PIN-oriented; Aliro is Epic 2 "evaluate", unstarted. |
| 9 | "Adopting M5Unit-NFC in HomeKey-ESP32 is a drop-in swap" | Fact 11 — hard dependency on M5UnitUnified pinned to a moving `main` branch; 37/63 files framework-coupled. |
| 10 | "The reader must be certified to be useful at home" | Not excluded — see UNVERIFIED items in the analysis document. Certification affects *distribution*, and possibly some Apple features (fact: iOS strings warn an uncertified accessory may lose Approach to Unlock / Tap to Unlock). |

---

## Open Questions (not yet facts)

Tracked in the analysis document with verification steps:

- Can a self-built device with test attestation certificates be commissioned into Apple Home?
  Into Google Home? Into HA?
- Which ecosystems can provision an Aliro credential to a **Google Wallet** or **Samsung Wallet**
  user for a *residential* lock (as opposed to Kastle-style commercial deployments)?
- Does Google Home support Aliro credential management today?
- Does the `sdkconfig.esp32c6.aliro` build actually fit and run on the NanoC6?
- Does Espressif's reader implement Android Polling Loop Annotations (fact 18), or only ECP?
