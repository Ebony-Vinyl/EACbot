# Install the Android SDK command-line tools into a chosen directory.
#
# Nothing here needs a full Android Studio install: the command-line tools plus
# one platform and one build-tools release are enough to compile this client.
#
# Usage:
#   scripts/android/install-sdk.sh [--sdk <path>]
#
# It accepts the licences non-interactively, which is what the official
# instructions do; it downloads only from dl.google.com.

set -euo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sdk) SDK="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SDK" ]]; then
  echo "Pass --sdk <path> or set ANDROID_HOME." >&2
  exit 1
fi

COMMAND_LINE_TOOLS_VERSION="11076708"
ZIP="commandlinetools-linux-${COMMAND_LINE_TOOLS_VERSION}_latest.zip"
URL="https://dl.google.com/android/repository/${ZIP}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$SDK/cmdline-tools"
if [[ -d "$SDK/cmdline-tools/latest/bin" ]]; then
  echo "Command-line tools already present in $SDK."
else
  echo "Downloading $ZIP"
  curl -fsSL -o "$WORK/$ZIP" "$URL"
  unzip -q "$WORK/$ZIP" -d "$WORK"
  mv "$WORK/cmdline-tools" "$SDK/cmdline-tools/latest"
fi

SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
if [[ ! -x "$SDKMANAGER" ]]; then
  echo "sdkmanager not found at $SDKMANAGER" >&2
  exit 1
fi

yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null || true
"$SDKMANAGER" --sdk_root="$SDK" \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0"

echo
echo "Android SDK ready at $SDK"
echo "Next: scripts/android/build.sh --sdk \"$SDK\""
