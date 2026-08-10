// Board pin map for the M5Stack NanoC6.
//
// This header is copied into the door-lock example as
// main/aliro_board_config.h by scripts/build_release.sh. The
// audited firmware source includes it and reads these macros for
// board-specific pins.
//
// One board header serves the nanoc6-thread and nanoc6-wifi variants.
// The transport differs, but the physical wiring, NFC unit pins, and
// on-board WS2812 wiring are identical.

#pragma once

#define ALIRO_BOARD_ID "nanoc6"
#define ALIRO_BOARD_LABEL "M5Stack NanoC6"

// Unit NFC Grove header
#define ALIRO_BOARD_NFC_SDA_GPIO 2
#define ALIRO_BOARD_NFC_SCL_GPIO 1

// On-board WS2812 RGB LED.
// The NanoC6 gates the RGB rail behind GPIO 19; the data line is GPIO 20.
#define ALIRO_BOARD_RGB_DATA_GPIO 20
#define ALIRO_BOARD_RGB_POWER_GPIO 19
#define ALIRO_BOARD_HAS_RGB_POWER 1

// User button (shared with the ROM BOOT strap on GPIO 9)
#define ALIRO_BOARD_USER_BUTTON_GPIO 9
#define ALIRO_BOARD_USER_BUTTON_ACTIVE_LOW 1
