@echo off
rem Build and test the Android client on Windows.
rem
rem The project is apps\android and has its own Gradle wrapper; no Node tool is
rem involved in producing the APK.
rem
rem Usage:
rem   scripts\android\build.cmd            unit tests, then a debug APK
rem   scripts\android\build.cmd test       unit tests only
rem
rem The SDK comes from ANDROID_HOME, then ANDROID_SDK_ROOT, then
rem apps\android\local.properties.

setlocal enabledelayedexpansion

set "ROOT=%~dp0..\.."
set "PROJECT=%ROOT%\apps\android"
set "MODE=build"
if /I "%~1"=="test" set "MODE=test"

if not defined ANDROID_HOME (
  if defined ANDROID_SDK_ROOT (
    set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
  ) else if exist "%PROJECT%\local.properties" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%PROJECT%\local.properties") do (
      if /I "%%A"=="sdk.dir" set "ANDROID_HOME=%%B"
    )
  )
)

if not defined ANDROID_HOME (
  echo No Android SDK found. Set ANDROID_HOME or add sdk.dir to apps\android\local.properties.
  exit /b 1
)

set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
if not defined GRADLE_USER_HOME set "GRADLE_USER_HOME=%USERPROFILE%\.gradle"

cd /d "%PROJECT%" || exit /b 1

echo == unit tests ^(:core^)
call gradlew.bat :core:test --console=plain
if errorlevel 1 (
  echo.
  echo Gradle failed. If the message was "Could not move temporary workspace",
  echo the checkout's .gradle directory cannot be replaced atomically; retry with
  echo   gradlew.bat :core:test --project-cache-dir %%TEMP%%\eacbot-android-cache
  exit /b 1
)

if /I "%MODE%"=="test" (
  echo Unit tests passed. Skipping the APK.
  exit /b 0
)

echo == debug APK ^(:app^)
call gradlew.bat :app:assembleDebug --console=plain
if errorlevel 1 exit /b 1

if not exist "%PROJECT%\app\build\outputs\apk\debug\app-debug.apk" (
  echo Expected an APK at app\build\outputs\apk\debug\app-debug.apk
  exit /b 1
)
echo Built app\build\outputs\apk\debug\app-debug.apk
exit /b 0
