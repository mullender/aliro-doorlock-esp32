#!/usr/bin/env bash
# Build the Aliro release image for one variant against a pinned
# esp-matter checkout.
#
# The script does NOT touch the shared ~/Development/esp-matter checkout.
# It expects a caller-supplied clean source tree at ESP_MATTER_SRC that
# is checked out at the pinned commit (a git-archive extract is fine).
#
# Usage:
#   scripts/build_release.sh [--source-check] [--variant <id>]
#
# Options:
#   --source-check    apply and validate source patches, run the parser
#                     test, clean the source tree, and exit without idf.py
#   --variant <id>    build variant id; default nanoc6-thread. Values come
#                     from firmware/variants.json.
#
# Required environment:
#   ESP_MATTER_SRC   absolute path to a clean esp-matter source tree,
#                    already checked out at the pinned commit
#   IDF_PATH         set by ESP-IDF's export.sh (or by direnv). Required
#                    unless --source-check is set.
#
# Optional environment:
#   TAG              release tag; default aliro-v0.0.6-devkit. The variant
#                    is appended to per-artifact file names by
#                    scripts/prepare_release.sh.
#   ESP_MATTER_REVISION
#                    required when ESP_MATTER_SRC is a git archive
#
# Outputs:
#   $ESP_MATTER_SRC/examples/door_lock/build/              build tree
#   $ESP_MATTER_SRC/examples/door_lock/build/door_lock.bin app image

set -euo pipefail

: "${ESP_MATTER_SRC:?set to absolute path of a clean esp-matter source tree}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VARIANTS_JSON="$REPO_ROOT/firmware/variants.json"
if [[ ! -f "$VARIANTS_JSON" ]]; then
  echo "error: variants config not found at $VARIANTS_JSON" >&2
  exit 2
fi

SOURCE_CHECK_ONLY=0
VARIANT_ID="nanoc6-thread"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --source-check) SOURCE_CHECK_ONLY=1; shift ;;
    --variant) VARIANT_ID="${2:?--variant requires a value}"; shift 2 ;;
    --variant=*) VARIANT_ID="${1#--variant=}"; shift ;;
    -h|--help) sed -n '1,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 [--source-check] [--variant <id>]" >&2; exit 2 ;;
  esac
done
if [[ "$SOURCE_CHECK_ONLY" == "0" ]]; then
  : "${IDF_PATH:?ESP-IDF not exported. source \$IDF_PATH/export.sh first}"
fi

# Default TAG matches the last legacy release so scripts/prepare_release.sh
# (which still keys on aliro-c6-v0.0.5-devkit) keeps working for the
# nanoc6-thread variant. Set TAG=aliro-v0.0.6-devkit for a matrix release.
TAG="${TAG:-aliro-c6-v0.0.5-devkit}"

# Read the pinned esp-matter revision, connectedhomeip revision, and
# variant record from firmware/variants.json.
VARIANT_JSON="$(python3 - "$VARIANTS_JSON" "$VARIANT_ID" <<'PY'
import json, sys
with open(sys.argv[1]) as source:
    data = json.load(source)
variant_id = sys.argv[2]
variants = data.get("variants", {})
if variant_id not in variants:
    print(f"error: unknown variant '{variant_id}'", file=sys.stderr)
    print(f"       known variants: {', '.join(sorted(variants))}", file=sys.stderr)
    sys.exit(2)
entry = variants[variant_id]
entry["_esp_matter_pin"] = data.get("esp_matter_pin", "")
entry["_connectedhomeip_pin"] = data.get("connectedhomeip_pin", "")
entry["_release_tag_pattern"] = data.get("release_tag_pattern", "")
print(json.dumps(entry))
PY
)"

# Extract needed fields into shell variables.
eval "$(VARIANT_JSON="$VARIANT_JSON" python3 - <<'PY'
import json, os, shlex
entry = json.loads(os.environ["VARIANT_JSON"])
keys = [
    "id",
    "project_name",
    "chip",
    "chip_family",
    "flash_size",
    "transport",
    "base_sdkconfig",
    "base_sdkconfig_source",
    "release_overlay",
    "board_config_header",
    "partition_layout_id",
    "partition_table_sha256",
    "_esp_matter_pin",
    "_connectedhomeip_pin",
    "_release_tag_pattern",
]
for key in keys:
    value = entry.get(key, "")
    if value is None:
        value = ""
    print(f'VARIANT_{key.upper().lstrip("_")}={shlex.quote(str(value))}')
patches = entry.get("source_patches", [])
print("VARIANT_SOURCE_PATCHES=(" + " ".join(shlex.quote(str(p)) for p in patches) + ")")
dep_patches = entry.get("dependency_patches", [])
print("VARIANT_DEPENDENCY_PATCHES=(" + " ".join(shlex.quote(str(p)) for p in dep_patches) + ")")
PY
)"

PINNED_ESP_MATTER="$VARIANT_ESP_MATTER_PIN"
PINNED_CONNECTEDHOMEIP="$VARIANT_CONNECTEDHOMEIP_PIN"

if [[ ! "$TAG" =~ $VARIANT_RELEASE_TAG_PATTERN ]]; then
  echo "error: invalid Aliro release tag: $TAG" >&2
  echo "       expected pattern: $VARIANT_RELEASE_TAG_PATTERN" >&2
  exit 2
fi
# Accept the legacy `aliro-c6-v` and the matrix `aliro-v` prefixes.
FIRMWARE_VERSION="${TAG#aliro-c6-v}"
FIRMWARE_VERSION="${FIRMWARE_VERSION#aliro-v}"
if [[ "$FIRMWARE_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  FIRMWARE_VERSION_NUMBER="${BASH_REMATCH[3]}"
else
  echo "error: could not read patch number from $FIRMWARE_VERSION" >&2
  exit 2
fi
if [[ "${#FIRMWARE_VERSION}" -gt 31 ]]; then
  echo "error: firmware version exceeds the 31-character app descriptor limit: $FIRMWARE_VERSION" >&2
  exit 2
fi

if [[ ! -f "$ESP_MATTER_SRC/examples/door_lock/sdkconfig.esp32c6.aliro" ]]; then
  echo "error: $ESP_MATTER_SRC does not look like an esp-matter tree" >&2
  exit 2
fi

SOURCE_ROOT="$(cd "$ESP_MATTER_SRC" && pwd -P)"
GIT_ROOT="$(git -C "$ESP_MATTER_SRC" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$GIT_ROOT" && "$(cd "$GIT_ROOT" && pwd -P)" == "$SOURCE_ROOT" ]]; then
  ESP_MATTER_REVISION="$(git -C "$ESP_MATTER_SRC" rev-parse HEAD)"
  if [[ -n "$(git -C "$ESP_MATTER_SRC" status --porcelain --untracked-files=no)" ]]; then
    echo "error: esp-matter source tree has tracked changes" >&2
    echo "       use a clean tree or a git-archive source snapshot" >&2
    exit 2
  fi
else
  : "${ESP_MATTER_REVISION:?set to the pinned commit for a git-archive source tree}"
fi
if [[ "$ESP_MATTER_REVISION" != "$PINNED_ESP_MATTER" ]]; then
  echo "error: esp-matter revision is $ESP_MATTER_REVISION" >&2
  echo "       expected $PINNED_ESP_MATTER" >&2
  exit 2
fi

if [[ ! -e "$ESP_MATTER_SRC/connectedhomeip/connectedhomeip/BUILD.gn" ]]; then
  echo "error: connectedhomeip submodule not populated under $ESP_MATTER_SRC" >&2
  echo "       (a symlink to the shared submodule is fine)" >&2
  exit 2
fi
CONNECTEDHOMEIP_REVISION="$(git -C "$ESP_MATTER_SRC/connectedhomeip/connectedhomeip" rev-parse HEAD)"
if [[ "$CONNECTEDHOMEIP_REVISION" != "$PINNED_CONNECTEDHOMEIP" ]]; then
  echo "error: connectedhomeip revision is $CONNECTEDHOMEIP_REVISION" >&2
  echo "       expected $PINNED_CONNECTEDHOMEIP" >&2
  exit 2
fi

OVERLAY="$REPO_ROOT/$VARIANT_RELEASE_OVERLAY"
SOURCE_PATCHES=()
for rel in "${VARIANT_SOURCE_PATCHES[@]}"; do
  SOURCE_PATCHES+=("$REPO_ROOT/$rel")
done
DEPENDENCY_PATCHES=()
for rel in "${VARIANT_DEPENDENCY_PATCHES[@]}"; do
  DEPENDENCY_PATCHES+=("$REPO_ROOT/$rel")
done
BOARD_CONFIG_HEADER="$REPO_ROOT/$VARIANT_BOARD_CONFIG_HEADER"

if [[ ! -f "$OVERLAY" ]]; then
  echo "error: overlay not found at $OVERLAY" >&2
  exit 2
fi
if [[ -n "$VARIANT_BOARD_CONFIG_HEADER" && ! -f "$BOARD_CONFIG_HEADER" ]]; then
  echo "error: board config header not found at $BOARD_CONFIG_HEADER" >&2
  exit 2
fi
for PROJECT_PATCH in "${SOURCE_PATCHES[@]}" "${DEPENDENCY_PATCHES[@]}"; do
  if [[ ! -f "$PROJECT_PATCH" ]]; then
    echo "error: project patch not found at $PROJECT_PATCH" >&2
    exit 2
  fi
done

APP_DIR="$ESP_MATTER_SRC/examples/door_lock"
OVERLAY_LOCAL="$APP_DIR/$(basename "$OVERLAY")"
BOARD_CONFIG_LOCAL="$APP_DIR/main/aliro_board_config.h"
BASE_CONFIG_LOCAL="$APP_DIR/$VARIANT_BASE_SDKCONFIG"
BASE_CONFIG_STAGED=0
APPLIED_PATCHES=()
OVERLAY_COPIED=0
BOARD_CONFIG_COPIED=0

cleanup() {
  if [[ "$OVERLAY_COPIED" == "1" && -f "$OVERLAY_LOCAL" ]]; then
    command rm -f "$OVERLAY_LOCAL"
  fi
  if [[ "$BOARD_CONFIG_COPIED" == "1" && -f "$BOARD_CONFIG_LOCAL" ]]; then
    command rm -f "$BOARD_CONFIG_LOCAL"
  fi
  if [[ "$BASE_CONFIG_STAGED" == "1" && -f "$BASE_CONFIG_LOCAL" ]]; then
    command rm -f "$BASE_CONFIG_LOCAL"
  fi
  local patch_index
  for ((patch_index = ${#APPLIED_PATCHES[@]} - 1; patch_index >= 0; patch_index--)); do
    if ! patch --batch --reverse -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" \
        < "${APPLIED_PATCHES[$patch_index]}" >/dev/null; then
      echo "warning: could not remove source patch ${APPLIED_PATCHES[$patch_index]}" >&2
    fi
  done
}
trap cleanup EXIT

# For variants whose base sdkconfig lives outside esp-matter (currently
# only atoms3-lite-wifi), stage the base config into the example dir so
# SDKCONFIG_DEFAULTS resolves it relative to the app directory. Refuse
# to overwrite an existing file so a caller-owned config is never lost.
if [[ "$VARIANT_BASE_SDKCONFIG_SOURCE" != "upstream" ]]; then
  BASE_SOURCE="$REPO_ROOT/$VARIANT_BASE_SDKCONFIG_SOURCE"
  if [[ ! -f "$BASE_SOURCE" ]]; then
    echo "error: base sdkconfig source not found at $BASE_SOURCE" >&2
    exit 2
  fi
  if [[ -e "$BASE_CONFIG_LOCAL" ]]; then
    echo "error: refusing to overwrite existing $BASE_CONFIG_LOCAL" >&2
    exit 2
  fi
  cp "$BASE_SOURCE" "$BASE_CONFIG_LOCAL"
  BASE_CONFIG_STAGED=1
fi

# Copy the variant board config header into the source tree. Refuse to
# overwrite an existing file. Do this BEFORE patch application so
# patches that include it can rely on it being present.
if [[ -n "$VARIANT_BOARD_CONFIG_HEADER" ]]; then
  if [[ -e "$BOARD_CONFIG_LOCAL" ]]; then
    echo "error: refusing to overwrite existing $BOARD_CONFIG_LOCAL" >&2
    exit 2
  fi
  cp "$BOARD_CONFIG_HEADER" "$BOARD_CONFIG_LOCAL"
  BOARD_CONFIG_COPIED=1
fi

if [[ -e "$OVERLAY_LOCAL" ]]; then
  echo "error: refusing to overwrite existing $OVERLAY_LOCAL" >&2
  exit 2
fi

# Apply each audited project delta in file-name order.
for SOURCE_PATCH in "${SOURCE_PATCHES[@]}"; do
  if patch --batch --reverse --forward --dry-run -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" \
      < "$SOURCE_PATCH" >/dev/null 2>&1; then
    echo "error: source patch already appears to be applied: $SOURCE_PATCH" >&2
    exit 2
  fi
  if ! patch --batch --forward --dry-run -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" < "$SOURCE_PATCH"; then
    echo "error: source patch dry-run failed: $SOURCE_PATCH" >&2
    exit 2
  fi
  APPLIED_PATCHES+=("$SOURCE_PATCH")
  if ! patch --batch --forward -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" < "$SOURCE_PATCH"; then
    echo "error: could not apply source patch $SOURCE_PATCH" >&2
    exit 2
  fi
done

validate_aliro_feature_map() {
  local app_source="$APP_DIR/main/app_main.cpp"
  local feature_source="$ESP_MATTER_SRC/components/esp_matter/data_model/legacy/esp_matter_feature.cpp"
  local feature_enum="$ESP_MATTER_SRC/connectedhomeip/connectedhomeip/zzz_generated/app-common/clusters/DoorLock/Enums.h"
  local feature_adds
  local expected_adds
  local user_feature
  local aliro_feature
  local feature_map
  local feature_map_hex

  feature_adds="$(
    sed -n '/cluster_t \*door_lock_cluster/,/create_auto_relock_time/p' "$app_source" |
      sed -n 's/.*cluster::door_lock::feature::\([a-z_]*\)::add.*/\1/p'
  )"
  expected_adds="$(printf '%s\n%s' aliro_provisioning user)"
  if [[ "$feature_adds" != "$expected_adds" ]]; then
    echo "error: release Door Lock features are not exactly ALIRO then USR" >&2
    printf 'found:\n%s\n' "$feature_adds" >&2
    return 2
  fi

  if ! grep -Fq 'feature & (pin | rid | fgp | face | aliro)' "$feature_source"; then
    echo "error: USR validation does not accept the ALIRO feature" >&2
    return 2
  fi
  if ! grep -Fq 'CONFIG_ENABLE_ALIRO_OVER_NFC=y' "$APP_DIR/$VARIANT_BASE_SDKCONFIG"; then
    echo "error: the Aliro base config does not enable Aliro over NFC" >&2
    return 2
  fi

  user_feature="$(awk '$1 == "kUser" { gsub(/,/, "", $3); print $3; exit }' "$feature_enum")"
  aliro_feature="$(awk '$1 == "kAliroProvisioning" { gsub(/,/, "", $3); print $3; exit }' "$feature_enum")"
  if [[ -z "$user_feature" || -z "$aliro_feature" ]]; then
    echo "error: could not read USR and ALIRO feature values" >&2
    return 2
  fi

  feature_map=$((user_feature | aliro_feature))
  printf -v feature_map_hex '0x%X' "$feature_map"
  if [[ "$feature_map_hex" != "0x2100" ]]; then
    echo "error: release Door Lock FeatureMap is $feature_map_hex, expected 0x2100" >&2
    return 2
  fi
  echo "=== Door Lock FeatureMap: $feature_map_hex (USR + ALIRO) ==="
}

validate_nanoc6_nfc_feedback() {
  local delegate_source="$APP_DIR/main/lock/aliro_door_lock_delegate.cpp"
  local m5nfc_source="$APP_DIR/managed_components/m5nfc/m5nfc.cpp"
  local dependency_lock="$APP_DIR/dependencies.lock"
  local required_delegate_text=(
    'kStatusLedDataPin = static_cast<gpio_num_t>(ALIRO_BOARD_RGB_DATA_GPIO)'
    'kStatusLedPowerPin = static_cast<gpio_num_t>(ALIRO_BOARD_RGB_POWER_GPIO)'
    '#include "aliro_board_config.h"'
    '#if ALIRO_BOARD_HAS_RGB_POWER'
    'strip_config.led_pixel_format = LED_PIXEL_FORMAT_GRB'
    'strip_config.led_model = LED_MODEL_WS2812'
    'QueueHandle_t g_status_led_queue = nullptr'
    'g_status_led_queue = xQueueCreate(1, sizeof(StatusLedCommand))'
    'xTaskCreate(StatusLedTask, "aliro_led"'
    'xQueueReceive(g_status_led_queue, &next_command, pdMS_TO_TICKS(command.duration_ms))'
    'xQueueOverwrite(g_status_led_queue, &command)'
    'const AliroSettingsSnapshot settings = AliroSettingsGet()'
    'kFciTemplateTag = 0x6F'
    'kDedicatedFileNameTag = 0x84'
    'response_len < status_len'
    'response[response_len - 2] != 0x90'
    'response[response_len - 1] != 0x00'
    'response[1] != fci_len - fci_header_len'
    'response[fci_header_len] != kDedicatedFileNameTag'
    'response[fci_header_len + 1] != sizeof(kAliroExpeditedAid)'
    'aid_offset + sizeof(kAliroExpeditedAid) > fci_len'
    'BytesEqual(response + aid_offset, kAliroExpeditedAid'
    'class ScopedSemaphoreLock'
    'xSemaphoreTake(m_semaphore, portMAX_DELAY)'
    'xSemaphoreGive(m_semaphore)'
    'g_aliro_reader_mutex = xSemaphoreCreateMutex()'
    'xTaskCreate(NfcDetectTask, "nfc_detect"'
    'g_aliro_select_rejected = err == ESP_OK && !g_aliro_applet_selected'
    'ShowStatusLed(StatusLedResult::kSuccess)'
    'ShowStatusLed(StatusLedResult::kFailure)'
    'ShowStatusLed(StatusLedResult::kOtherTag)'
    'm5nfc_set_ecp_identifier(groupIdentifier.data(), 8)'
    'm5nfc_set_ecp_identifier(nullptr, 0)'
    'm5nfc_set_ecp_identifier(reader_config.group_identifier, 8)'
    'activation == M5NFC_ACTIVATION_NON_ISO_DEP'
  )
  local required_m5nfc_text=(
    'constexpr size_t kEcpIdentifierSize = 8'
    'std::array<uint8_t, 16> g_aliro_ecp_frame'
    '0x6A, 0x02, 0xCB, 0x02, 0x06, 0x20, 0x42, 0x20'
    'std::copy_n(identifier, kEcpIdentifierSize, g_aliro_ecp_frame.begin() + 8)'
    '(void)g_nfca.transceive(&response, response_len, frame.data(), frame.size(), kEcpResponseTimeoutMs)'
    'vTaskDelay(std::max<TickType_t>(1, pdMS_TO_TICKS(kEcpSettleTimeMs)))'
    'return M5NFC_ACTIVATION_NON_ISO_DEP'
  )
  local required_text
  local led_clear_count
  local reader_lock_count
  local mutex_create_line
  local nfc_task_create_line
  local ecp_line
  local request_line

  for required_text in "${required_delegate_text[@]}"; do
    if ! grep -Fq "$required_text" "$delegate_source"; then
      echo "error: NanoC6 feedback source is missing: $required_text" >&2
      return 2
    fi
  done
  for required_text in 'esp_timer_handle_t' 'esp_timer_create(' 'esp_timer_start_once('; do
    if grep -Fq "$required_text" "$delegate_source"; then
      echo "error: NanoC6 feedback source still uses an LED timer: $required_text" >&2
      return 2
    fi
  done
  if [[ "$(grep -Fc 'led_strip_set_pixel(' "$delegate_source")" -ne 1 ||
        "$(grep -Fc 'led_strip_refresh(' "$delegate_source")" -ne 1 ]]; then
    echo "error: RGB writes must have one worker-owned source path" >&2
    return 2
  fi
  led_clear_count="$(grep -Fc 'led_strip_clear(' "$delegate_source")"
  if [[ "$led_clear_count" -ne 2 ]]; then
    echo "error: RGB clear calls must stay in the LED worker" >&2
    return 2
  fi
  reader_lock_count="$(grep -Fc 'ScopedSemaphoreLock reader_lock(g_aliro_reader_mutex);' "$delegate_source")"
  if [[ "$reader_lock_count" -ne 3 ]]; then
    echo "error: reader mutex must cover Set, Clear, and the NFC session" >&2
    return 2
  fi
  mutex_create_line="$(grep -n -F 'g_aliro_reader_mutex = xSemaphoreCreateMutex()' "$delegate_source" | cut -d: -f1)"
  nfc_task_create_line="$(grep -n -F 'xTaskCreate(NfcDetectTask, "nfc_detect"' "$delegate_source" | cut -d: -f1)"
  if [[ -z "$mutex_create_line" || -z "$nfc_task_create_line" || "$mutex_create_line" -ge "$nfc_task_create_line" ]]; then
    echo "error: reader mutex must exist before the NFC task starts" >&2
    return 2
  fi
  for required_text in "${required_m5nfc_text[@]}"; do
    if ! grep -Fq "$required_text" "$m5nfc_source"; then
      echo "error: managed m5nfc source is missing: $required_text" >&2
      return 2
    fi
  done
  if ! grep -Fq 'version: 0d00697342a8a13a13e0fb53f76e370c88845891' "$dependency_lock"; then
    echo "error: managed m5nfc is not at the audited revision" >&2
    return 2
  fi
  ecp_line="$(grep -n -F 'if (send_aliro_ecp())' "$m5nfc_source" | cut -d: -f1)"
  request_line="$(grep -n -F 'g_nfca.request(picc.atqa)' "$m5nfc_source" | cut -d: -f1)"
  if [[ -z "$ecp_line" || -z "$request_line" || "$ecp_line" -ge "$request_line" ]]; then
    echo "error: Aliro ECP must run before the NFC-A request" >&2
    return 2
  fi
  echo "=== NanoC6 NFC: ECP and configurable RGB feedback enabled ==="
}

validate_aliro_settings() {
  local cmake_source="$APP_DIR/CMakeLists.txt"
  local app_source="$APP_DIR/main/app_main.cpp"
  local settings_source="$APP_DIR/main/aliro_settings.cpp"
  local protocol_source="$APP_DIR/main/aliro_settings_protocol.cpp"
  local parser_test="$REPO_ROOT/firmware/tests/aliro_settings_protocol_test.cpp"
  local parser_binary
  local required_text
  local required_settings_text=(
    'kNvsNamespace[] = "aliro_settings"'
    'kSettingsSchemaVersion = 1'
    'esp_app_get_description()->version'
    'ALIRO/1 STATUS firmware=%s protocol=1'
    'variant=%s transport=%s'
    'ALIRO_VARIANT_ID, ALIRO_TRANSPORT_ID'
    'esp_matter::attribute::update(g_door_lock_endpoint_id, DoorLock::Id'
    'xTaskCreate(SerialTask, "aliro_serial"'
  )

  for required_text in \
      'set(PROJECT_VER "0.0.5-devkit")' \
      'set(PROJECT_VER_NUMBER 5)' \
      'set(PROJECT_VER "${CLI_PROJECT_VER}")' \
      'set(PROJECT_VER_NUMBER "${CLI_PROJECT_VER_NUMBER}")' \
      'set(CLI_ALIRO_VARIANT_ID "nanoc6-thread")' \
      'set(CLI_ALIRO_TRANSPORT_ID "thread")' \
      'add_compile_definitions(ALIRO_VARIANT_ID="${CLI_ALIRO_VARIANT_ID}")' \
      'add_compile_definitions(ALIRO_TRANSPORT_ID="${CLI_ALIRO_TRANSPORT_ID}")'; do
    if ! grep -Fq "$required_text" "$cmake_source"; then
      echo "error: project version source is missing: $required_text" >&2
      return 2
    fi
  done
  for required_text in \
      'AliroSettingsInit()' \
      'create_auto_relock_time(door_lock_cluster, settings.auto_relock_seconds)' \
      'AliroSettingsStartSerial(door_lock_endpoint_id)'; do
    if ! grep -Fq "$required_text" "$app_source"; then
      echo "error: Aliro settings integration is missing: $required_text" >&2
      return 2
    fi
  done
  for required_text in "${required_settings_text[@]}"; do
    if ! grep -Fq "$required_text" "$settings_source"; then
      echo "error: Aliro settings source is missing: $required_text" >&2
      return 2
    fi
  done
  if [[ ! -f "$parser_test" ]]; then
    echo "error: parser test not found at $parser_test" >&2
    return 2
  fi
  parser_binary="$(mktemp "${TMPDIR:-/tmp}/aliro-settings-parser.XXXXXX")"
  if ! "${CXX:-c++}" -std=gnu++17 -Wall -Wextra -Werror \
      -I "$APP_DIR/main" "$protocol_source" "$parser_test" -o "$parser_binary"; then
    command rm -f "$parser_binary"
    echo "error: Aliro settings parser test did not compile" >&2
    return 2
  fi
  if ! "$parser_binary"; then
    command rm -f "$parser_binary"
    echo "error: Aliro settings parser test failed" >&2
    return 2
  fi
  command rm -f "$parser_binary"
  echo "=== Aliro settings: source contract and parser test passed ==="
}

validate_aliro_tap_toggle() {
  local delegate_source="$APP_DIR/main/lock/aliro_door_lock_delegate.cpp"
  local required_text
  local required_tap_text=(
    'DoorLock::Attributes::LockState::Get(door_lock_endpoint_id, lock_state)'
    'lock_state.Value() == DoorLock::DlLockState::kLocked'
    'BoltLockMgr().Unlock(door_lock_endpoint_id, DoorLock::OperationSourceEnum::kAliro)'
    'lock_state.Value() != DoorLock::DlLockState::kUnlocked'
    '::DoorLockServer::Instance().GetAutoRelockTime(door_lock_endpoint_id, auto_relock_seconds)'
    'auto_relock_seconds != 0'
    'BoltLockMgr().Lock(door_lock_endpoint_id, DoorLock::OperationSourceEnum::kAliro)'
    'ApplyAliroTapLockAction()'
  )

  for required_text in "${required_tap_text[@]}"; do
    if ! grep -Fq "$required_text" "$delegate_source"; then
      echo "error: Aliro tap-toggle source is missing: $required_text" >&2
      return 2
    fi
  done
  if grep -Fq 'DoorLock::DoorLockServer::' "$delegate_source"; then
    echo "error: DoorLockServer must use its global namespace" >&2
    return 2
  fi
  if [[ "$(grep -Fc 'BoltLockMgr().Unlock(' "$delegate_source")" -ne 2 ||
        "$(grep -Fc 'BoltLockMgr().Lock(' "$delegate_source")" -ne 1 ]]; then
    echo "error: Aliro taps must have one lock path and two unlock paths" >&2
    return 2
  fi
  echo "=== Aliro tap: lock toggle contract passed ==="
}

validate_aliro_feature_map
validate_aliro_settings
validate_aliro_tap_toggle

if [[ "$SOURCE_CHECK_ONLY" == "1" ]]; then
  echo "=== Source patch check complete for variant $VARIANT_ID; idf.py was not run ==="
  exit 0
fi

# Copy the overlay into the example dir so idf.py's SDKCONFIG_DEFAULTS
# search resolves it relative to the app directory.
cp "$OVERLAY" "$OVERLAY_LOCAL"
OVERLAY_COPIED=1

cd "$APP_DIR"

echo "=== esp-matter env ==="
if [[ -f "$ESP_MATTER_SRC/export.sh" ]]; then
  # export.sh reads this variable without a default value. Set it before
  # sourcing the file because this script enables nounset.
  export ESP_MATTER_PATH="$ESP_MATTER_SRC"
  # shellcheck disable=SC1091
  . "$ESP_MATTER_SRC/export.sh"
fi

echo "=== set-target $VARIANT_CHIP with layered defaults (variant=$VARIANT_ID) ==="
idf.py \
  -D CLI_PROJECT_VER="$FIRMWARE_VERSION" \
  -D CLI_PROJECT_VER_NUMBER="$FIRMWARE_VERSION_NUMBER" \
  -D CLI_ALIRO_VARIANT_ID="$VARIANT_ID" \
  -D CLI_ALIRO_TRANSPORT_ID="$VARIANT_TRANSPORT" \
  -D SDKCONFIG_DEFAULTS="$VARIANT_BASE_SDKCONFIG;$(basename "$OVERLAY")" \
  set-target "$VARIANT_CHIP"

# Managed components exist only after dependency resolution. Apply their
# audited patch now and include it in reverse-order cleanup.
for DEPENDENCY_PATCH in "${DEPENDENCY_PATCHES[@]}"; do
  if patch --batch --reverse --forward --dry-run -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" \
      < "$DEPENDENCY_PATCH" >/dev/null 2>&1; then
    echo "error: dependency patch already appears to be applied: $DEPENDENCY_PATCH" >&2
    exit 2
  fi
  if ! patch --batch --forward --dry-run -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" < "$DEPENDENCY_PATCH"; then
    echo "error: dependency patch dry-run failed: $DEPENDENCY_PATCH" >&2
    exit 2
  fi
  APPLIED_PATCHES+=("$DEPENDENCY_PATCH")
  if ! patch --batch --forward -V none -r /dev/null -p1 -d "$ESP_MATTER_SRC" < "$DEPENDENCY_PATCH"; then
    echo "error: could not apply dependency patch $DEPENDENCY_PATCH" >&2
    exit 2
  fi
done

validate_nanoc6_nfc_feedback

echo "=== build ==="
idf.py \
  -D CLI_PROJECT_VER="$FIRMWARE_VERSION" \
  -D CLI_PROJECT_VER_NUMBER="$FIRMWARE_VERSION_NUMBER" \
  -D CLI_ALIRO_VARIANT_ID="$VARIANT_ID" \
  -D CLI_ALIRO_TRANSPORT_ID="$VARIANT_TRANSPORT" \
  build

echo "=== size ==="
idf.py size

echo
echo "Build complete."
echo "  APP_DIR       = $APP_DIR"
echo "  build/        = $APP_DIR/build"
echo "  variant       = $VARIANT_ID"
echo "  target tag    = $TAG"
echo
echo "Next: scripts/prepare_release.sh $APP_DIR/build --variant $VARIANT_ID [--tag $TAG]"
