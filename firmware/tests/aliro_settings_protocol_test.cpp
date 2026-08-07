#include "aliro_settings_protocol.h"

#include <assert.h>
#include <string.h>

namespace {

AliroParseError Parse(const char *text, const AliroSettingsSnapshot &current, AliroParsedRequest &request)
{
    char line[256];
    assert(strlen(text) < sizeof(line));
    strcpy(line, text);
    return AliroParseRequest(line, current, request);
}

} // namespace

int main()
{
    AliroParsedRequest request;
    AliroSettingsSnapshot current = kAliroDefaultSettings;

    assert(Parse("ALIRO/1 GET", current, request) == AliroParseError::kNone);
    assert(request.kind == AliroRequestKind::kGet);
    assert(request.settings.auto_relock_seconds == 5);

    assert(Parse("ALIRO/1 SET auto_relock_seconds=0 success_rgb=a1B2c3 success_ms=10000", current, request) ==
           AliroParseError::kNone);
    assert(request.kind == AliroRequestKind::kSet);
    assert(request.settings.auto_relock_seconds == 0);
    assert(request.settings.success_rgb == 0xA1B2C3);
    assert(request.settings.success_ms == 10000);
    assert(request.settings.failure_rgb == current.failure_rgb);

    assert(Parse("ALIRO/1 SET auto_relock_seconds=3600 failure_ms=0 other_rgb=000000", current, request) ==
           AliroParseError::kNone);
    assert(request.settings.auto_relock_seconds == 3600);
    assert(request.settings.failure_ms == 0);
    assert(request.settings.other_rgb == 0);

    assert(Parse("ALIRO/1 SET failure_rgb=010203 other_rgb=040506 failure_ms=7 other_ms=8", current, request) ==
           AliroParseError::kNone);
    assert(request.settings.failure_rgb == 0x010203);
    assert(request.settings.other_rgb == 0x040506);
    assert(request.settings.failure_ms == 7);
    assert(request.settings.other_ms == 8);

    assert(Parse("ALIRO/1 SET auto_relock_seconds=3601", current, request) == AliroParseError::kInvalidValue);
    assert(Parse("ALIRO/1 SET auto_relock_seconds=42949672960", current, request) ==
           AliroParseError::kInvalidValue);
    assert(Parse("ALIRO/1 SET success_ms=10001", current, request) == AliroParseError::kInvalidValue);
    assert(Parse("ALIRO/1 SET success_rgb=FFFFF", current, request) == AliroParseError::kInvalidValue);
    assert(Parse("ALIRO/1 SET success_rgb=GG0000", current, request) == AliroParseError::kInvalidValue);
    assert(Parse("ALIRO/1 SET unknown=1", current, request) == AliroParseError::kUnknownKey);
    assert(Parse("ALIRO/1 SET success_ms=1 success_ms=2", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 SET success_ms=1 failure_rgb=broken", current, request) ==
           AliroParseError::kInvalidValue);
    assert(current.success_ms == 1000);
    assert(Parse("ALIRO/1 SET", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 SET success_ms=1 ", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 SET  success_ms=1", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 SET success_ms=1  failure_ms=2", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 SET =1", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 SET success_ms=", current, request) == AliroParseError::kBadRequest);
    assert(Parse("ALIRO/1 GET extra", current, request) == AliroParseError::kBadRequest);
    assert(Parse("help", current, request) == AliroParseError::kBadRequest);
    assert(AliroParseRequest(nullptr, current, request) == AliroParseError::kBadRequest);

    assert(strcmp(AliroParseErrorCode(AliroParseError::kBadRequest), "bad_request") == 0);
    assert(strcmp(AliroParseErrorCode(AliroParseError::kUnknownKey), "unknown_key") == 0);
    assert(strcmp(AliroParseErrorCode(AliroParseError::kInvalidValue), "invalid_value") == 0);
    assert(strcmp(AliroParseErrorCode(AliroParseError::kNone), "internal") == 0);

    return 0;
}
