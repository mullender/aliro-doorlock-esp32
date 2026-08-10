// Board pin map for the M5Stack AtomS3 Lite.
//
// This header is copied into the door-lock example as
// main/aliro_board_config.h by scripts/build_release.sh. The audited
// firmware source includes it and reads these macros for board-specific
// pins.
//
// The AtomS3 Lite drives its on-board WS2812 directly from GPIO 35 with
// no separate power rail, so ALIRO_BOARD_HAS_RGB_POWER is 0 and the
// firmware skips the power-pin setup.

#pragma once

#define ALIRO_BOARD_ID "atoms3-lite"
#define ALIRO_BOARD_LABEL "M5Stack AtomS3 Lite"

// Unit NFC Grove header
#define ALIRO_BOARD_NFC_SDA_GPIO 2
#define ALIRO_BOARD_NFC_SCL_GPIO 1

// On-board WS2812 RGB LED.
// The AtomS3 Lite wires the LED to GPIO 35 with no power-enable pin.
#define ALIRO_BOARD_RGB_DATA_GPIO 35
#define ALIRO_BOARD_HAS_RGB_POWER 0

// User button (front button labelled "BTN")
#define ALIRO_BOARD_USER_BUTTON_GPIO 41
#define ALIRO_BOARD_USER_BUTTON_ACTIVE_LOW 1
