#!/usr/bin/env bash
# Build and test the Android client from the repository root.
#
# The project lives in apps/android and is deliberately outside the pnpm
# workspace: it has its own Gradle build, its own wrapper and its own
# dependency graph, and no Node tool is involved in producing the APK.
#
# Usage:
#   scripts/android/build.sh                 # unit tests, then a debug APK
#   scripts/android/build.sh --test-only
#   scripts/android/build.sh --sdk <path>    # Android SDK root
#
# The SDK is located from --sdk, then ANDROID_HOME, then ANDROID_SDK_ROOT, then
# apps/android/local.properties.
#
# Gradle keeps its project cache in apps/android/.gradle by default. On a
# checkout where that directory cannot be atomically replaced (a filesystem
# filter, a network share, some antivirus drivers), Gradle fails before it
# compiles anything with "Could not move temporary workspace". The script
# retries once with a project cache outside the checkout and says so, rather
# than leaving a failure that looks like a code problem.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$ROOT/apps/android"
MODE="build"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test-only) MODE="test"; shift ;;
    --sdk) SDK="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SDK" && -f "$PROJECT/local.properties" ]]; then
  SDK="$(sed -n 's/^sdk\.dir=//p' "$PROJECT/local.properties" | head -1)"
fi
if [[ -z "$SDK" ]]; then
  echo "No Android SDK found. Pass --sdk <path> or set ANDROID_HOME." >&2
  exit 1
fi
if [[ ! -d "$SDK/platforms" ]]; then
  echo "Android SDK at $SDK has no platforms directory." >&2
  exit 1
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"

cd "$PROJECT"

if [[ -n "${JAVA_HOME:-}" ]]; then
  echo "Using JAVA_HOME=$JAVA_HOME"
else
  echo "JAVA_HOME is not set; Gradle will use the JDK on PATH."
fi

# Runs Gradle, retrying once outside the checkout when the project cache cannot
# be replaced in place.
run_gradle() {
  local log
  log="$(mktemp)"
  if ./gradlew "$@" --console=plain 2>&1 | tee "$log"; then
    rm -f "$log"
    return 0
  fi
  if ! grep -q "Could not move temporary workspace" "$log"; then
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  local fallback="${TMPDIR:-/tmp}/eacbot-android-cache"
  echo
  echo "The checkout's .gradle directory cannot be replaced atomically."
  echo "Retrying with the project cache at $fallback"
  ./gradlew "$@" --console=plain --project-cache-dir "$fallback"
}

echo "== unit tests (:core)"
run_gradle :core:test

if [[ "$MODE" == "test" ]]; then
  echo "Unit tests passed. Skipping the APK."
  exit 0
fi

echo "== debug APK (:app)"
run_gradle :app:assembleDebug

APK="$PROJECT/app/build/outputs/apk/debug/app-debug.apk"
if [[ ! -f "$APK" ]]; then
  echo "Expected an APK at $APK" >&2
  exit 1
fi
echo "Built $APK ($(wc -c < "$APK") bytes)"
