#!/usr/bin/env bash
# Build the Aliro NanoC6 release image against a
# pinned esp-matter checkout.
#
# The script does NOT touch the shared ~/Development/esp-matter checkout.
# It expects a caller-supplied clean source tree at ESP_MATTER_SRC that
# is checked out at the pinned commit (a git-archive extract is fine).
#
# Usage:
#   scripts/build_release.sh
#
# Required environment:
#   ESP_MATTER_SRC   absolute path to a clean esp-matter source tree,
#                    already checked out at the pinned commit
#   IDF_PATH         set by ESP-IDF's export.sh (or by direnv). Script
#                    exits if unset.
#
# Optional environment:
#   TAG              release tag; default aliro-c6-v0.0.3-devkit
#   ESP_MATTER_REVISION
#                    required when ESP_MATTER_SRC is a git archive
#
# Outputs:
#   $ESP_MATTER_SRC/examples/door_lock/build/              build tree
#   $ESP_MATTER_SRC/examples/door_lock/build/door_lock.bin app image
#
# The merged 4 MB factory image and its .sha256 sidecar are produced by
# scripts/prepare_release.sh, which consumes the outputs of this script.

set -euo pipefail

: "${ESP_MATTER_SRC:?set to absolute path of a clean esp-matter source tree}"
: "${IDF_PATH:?ESP-IDF not exported. source \$IDF_PATH/export.sh first}"

TAG="${TAG:-aliro-c6-v0.0.3-devkit}"
PINNED_ESP_MATTER="85c76a1788c5b70b4b0811734af8616dda15e7ac"
PINNED_CONNECTEDHOMEIP="efefc94fee39d8d1fbbc3c27b9d7fc9025095887"

if [[ ! -f "$ESP_MATTER_SRC/examples/door_lock/sdkconfig.esp32c6.aliro" ]]; then
  echo "error: $ESP_MATTER_SRC does not look like an esp-matter tree" >&2
  exit 2
fi
if [[ ! "$TAG" =~ ^aliro-c6-[A-Za-z0-9._-]+$ ]]; then
  echo "error: invalid Aliro release tag: $TAG" >&2
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

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$REPO_ROOT/firmware/overlay/sdkconfig.release.nanoc6"
SOURCE_PATCHES=(
  "$REPO_ROOT/firmware/patches/0001-print-onboarding-codes.patch"
  "$REPO_ROOT/firmware/patches/0002-advertise-aliro-credentials-only.patch"
  "$REPO_ROOT/firmware/patches/0003-add-nanoc6-rgb-feedback.patch"
  "$REPO_ROOT/firmware/patches/0004-wire-aliro-ecp-and-generic-tags.patch"
)
DEPENDENCY_PATCHES=(
  "$REPO_ROOT/firmware/patches/0005-add-m5nfc-aliro-ecp.patch"
)
if [[ ! -f "$OVERLAY" ]]; then
  echo "error: overlay not found at $OVERLAY" >&2
  exit 2
fi
for PROJECT_PATCH in "${SOURCE_PATCHES[@]}" "${DEPENDENCY_PATCHES[@]}"; do
  if [[ ! -f "$PROJECT_PATCH" ]]; then
    echo "error: project patch not found at $PROJECT_PATCH" >&2
    exit 2
  fi
done

APP_DIR="$ESP_MATTER_SRC/examples/door_lock"
OVERLAY_LOCAL="$APP_DIR/sdkconfig.release.nanoc6"
APPLIED_PATCHES=()
OVERLAY_COPIED=0

cleanup() {
  # Restore the pristine example directory by removing artifacts the
  # build created (except build/, which is what the caller wants).
  # The overlay copy is ours; safe to delete.
  if [[ "$OVERLAY_COPIED" == "1" && -f "$OVERLAY_LOCAL" ]]; then
    command rm -f "$OVERLAY_LOCAL"
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

if [[ -e "$OVERLAY_LOCAL" ]]; then
  echo "error: refusing to overwrite existing $OVERLAY_LOCAL" >&2
  exit 2
fi

# Apply each audited project delta in file-name order. The reverse
# dry-run detects an existing patch. --forward stops patch from changing
# direction during this check. Add the patch to the cleanup list only
# after both dry-runs pass, but before the real apply. Cleanup can then
# reverse a partial real apply without changing caller-owned source.
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
  if ! grep -Fq 'CONFIG_ENABLE_ALIRO_OVER_NFC=y' "$APP_DIR/sdkconfig.esp32c6.aliro"; then
    echo "error: the Aliro release config does not enable Aliro over NFC" >&2
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
    'kStatusLedPowerPin = GPIO_NUM_19'
    'kStatusLedDataPin = GPIO_NUM_20'
    'strip_config.led_pixel_format = LED_PIXEL_FORMAT_GRB'
    'strip_config.led_model = LED_MODEL_WS2812'
    'QueueHandle_t g_status_led_queue = nullptr'
    'g_status_led_queue = xQueueCreate(1, sizeof(StatusLedResult))'
    'xTaskCreate(StatusLedTask, "aliro_led"'
    'xQueueReceive(g_status_led_queue, &next_result, pdMS_TO_TICKS(kStatusLedDurationMs))'
    'xQueueOverwrite(g_status_led_queue, &result)'
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
  echo "=== NanoC6 NFC: ECP enabled; green success, red failure, blue other tag ==="
}

validate_aliro_feature_map

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

echo "=== set-target esp32c6 with layered defaults ==="
idf.py \
  -D SDKCONFIG_DEFAULTS="sdkconfig.esp32c6.aliro;sdkconfig.release.nanoc6" \
  set-target esp32c6

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
idf.py build

echo "=== size ==="
idf.py size

echo
echo "Build complete."
echo "  APP_DIR       = $APP_DIR"
echo "  build/        = $APP_DIR/build"
echo "  target tag    = $TAG"
echo
echo "Next: scripts/prepare_release.sh $APP_DIR/build $TAG"
