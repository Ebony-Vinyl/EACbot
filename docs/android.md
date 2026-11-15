# Android client

The phone client for a self-hosted EACbot core. It is a native Kotlin app: one
credential per phone, one live stream, and the phone's own information
architecture rather than a shrunken desktop window.

`apps/android` is outside the pnpm workspace on purpose. It has its own Gradle
build and wrapper, and no Node tool is involved in producing the APK.

## Build

The project needs a JDK 17 and an Android SDK with platform 35 and build-tools
35.0.0. Nothing else.

```sh
scripts/android/build.sh --sdk /path/to/android-sdk          # tests, then a debug APK
scripts/android/build.sh --sdk /path/to/android-sdk --test-only
```

On Windows:

```bat
scripts\android\build.cmd
scripts\android\build.cmd test
```

The SDK is located from `--sdk`, then `ANDROID_HOME`, then `ANDROID_SDK_ROOT`,
then `apps/android/local.properties` (`sdk.dir=`). `scripts/android/install-sdk.sh`
installs the command-line tools and accepts their licences if no SDK exists yet.

Without either script:

```sh
cd apps/android
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew :core:test :app:assembleDebug
```

The APK lands in `apps/android/app/build/outputs/apk/debug/app-debug.apk`.
`minSdk` is 26 and `targetSdk` is 35.

The Gradle wrapper pins Gradle 8.9 and downloads it from `services.gradle.org`.
On a network that cannot reach that host, put the distribution in the wrapper's
own cache directory (`$GRADLE_USER_HOME/wrapper/dists/gradle-8.9-bin/<hash>/`)
and add the `.ok` marker file beside it.

## Modules

| Module | What it is |
|---|---|
| `:core` | Pure Kotlin/JVM. Wire models, the API client, SSE, the terminal protocol and ANSI screen, the conversation fold, and the notification policy. No Android type is imported, so every rule here is a unit test. |
| `:app` | Compose UI, the encrypted credential store, the WebView desktop viewer, and local notifications. |

`core` is a JVM module rather than an Android library because the protocol is
not platform-specific: the same parser runs in a test on a laptop and in the
app on a phone, and a bug in the wire format is found by `:core:test` alone.

## What it does

### Pairing

`POST /api/v1/pairing/claim` with the address the core printed and the one-time
code. The bearer it returns is written to `EncryptedSharedPreferences` (AES-256
GCM, key in the Android keystore); it is never in plain preferences, a log line
or a URL. If the keystore is unusable the app stores nothing and asks the person
to pair again, because a cleartext fallback would be worse than the retry.

A `401` from any request or from the live stream clears the credential and
returns to pairing. A `403` is a scope refusal and is shown as one: re-pairing
would not change it. Settings lists every device on the core, with revocation
for each; forgetting this phone revokes its own session first.

### Hermes conversation

`GET /api/v1/missions`, `/:id`, `/:id/tree`, `/:id/history`. The transcript is
folded from the append-only log: `run.output` with `stream = "assistant"`
accumulates into the agent's text, `run.tool_call` and `run.tool_result` become
one card, `run.approval_requested` and `run.waiting_input` become a decision
card that stays pending until it is resolved. Nothing is inferred that the log
did not record.

Every mutation carries a caller-chosen `commandId` and the revision on screen.
A retry reuses its id so the core replays rather than acting twice; a
`revision_conflict` carries `expected` and `actual`, and the screen refetches
the mission and adopts the revision from the command result instead of guessing
the next one.

`steer`, `interrupt`, `resume`, `cancel` and `approval.resolve` are offered only
while the mission's status allows them, which is the same table the authority
enforces.

### Live stream

`GET /api/v1/events` over SSE, with the device bearer. Each event's `id` is the
core's monotonic cursor, so a reconnect sends `Last-Event-ID` and the core
replays from exactly there. `stream.resync` means the cursor was too old to
replay: the app refetches a snapshot instead of treating the stream as
contiguous. A `401` on the stream is reported as an unauthenticated resync,
which signs the phone out.

The last cursor is persisted, so a cold start resumes rather than starting at
"now".

### Agent command centre

`GET /api/v1/agents` and `/agents/:kind/models`. A capability the engine did not
report is shown as off, because the authority will refuse it too. A model list
is only shown as known when the engine reported one: `reported = false` renders
as "unknown" and no model is sent, rather than inventing a plausible name that
would fail at native start.

Missions are filtered by working, waiting, finished or all, and the tree shows
parallel children indented with their counts. The event log shows each entry's
`seq` and source; a jump in `seq` is surfaced with a Resync action rather than
silently appended.

### Terminal

`POST /api/v1/terminals/:id/ticket`, then a WebSocket to the ticket's own
`path` with the ticket in the query string, because a WebSocket cannot carry an
Authorization header.

The wire, as the core fixes it:

- server text: `{type:"ready",terminalId,cols,rows,canControl}`, `title`,
  `status`, `exit`, `error`, `resync`;
- server binary: raw program output;
- client binary: raw input, only while this viewer holds control;
- client text: `{type:"resize",cols,rows}`, `{type:"credit",bytes}`,
  `{type:"close"}`.

`ready` and `resync` are repaint boundaries, so a reconnect never doubles text.
Credit starts at 256 KiB and is returned for bytes the screen has actually
drawn, not on receipt: a slow phone slows the stream instead of losing output.
A dropped stream mints a fresh ticket and reattaches, and never replays input.

Observe mode refuses both input and resize locally *and* relies on the server's
`canControl`; a `not_controller` refusal turns input off while leaving the
screen live. A role change is a reattach, because control is granted per stream.

The renderer is this project's own: a VT100/xterm subset (cursor addressing,
erase, SGR colour including 256 and true colour, the alternate screen, scroll
regions' common cases) drawn from a parsed grid. It is deliberately not a
WebView: the screen model is testable and the bytes never become HTML.

### Cloud desktop

The core's noVNC entry, loaded in a WebView scoped to that one screen. The
address is validated first: it must be same-origin with the core and use a
scheme the core itself uses, so a core that answered with somebody else's origin
cannot turn this screen into a browser for a third party. No remote script is
injected and no bridge exposes the app's own API. The viewer is a WebView; the
rest of the app is not.

When the connection drops the last frame stays with a Reconnecting bar and a
Retry action, because a blank rectangle hides the only thing the person can
still see. The screen offers zoom, a text field that goes to the system
clipboard for the viewer to read, full screen, and a handover notice while the
person is driving.

A core that publishes no viewer route is reported as such, which is a different
fact from "no computer is configured".

### Notifications

There is no server push in this release. While the app is running it folds the
live stream and posts a local notification for exactly two transitions: an agent
started waiting for a person, and an agent finished without waiting. Nothing
fires while the app is in the foreground, one mission's one kind of notification
is suppressed for a minute, and the body is a fixed phrase plus the mission
title. Prompt text, tool input and approval detail never reach a lock screen.

`PushSink` is the seam a later FCM receiver would use: it would call
`LocalPushSink.offer` with the same `NotificationDecision` the policy already
produces, so the redaction rule stays in one place.

## Visual design

The palette is EACbot's own: near-black ink for dark, warm paper for light, one
teal accent, a quiet amber for "needs you". It follows the same family as the
desktop skins without copying a wallpaper or a screenshot.

The structure is the phone's, from `docs/design/grokbot-ui-notes.md`: bot list →
conversation → that bot's computer card, with the full-screen desktop and a
terminal as pages under it. The desktop's three panes are not reproduced.

A status is always a dot *and* a word, because colour alone fails for a colour
vision deficiency and in bright light. Motion uses Compose animation at the
notes' timings (about 120 ms feedback, 160–180 ms for a card arriving with a
4 px rise and a 0.98 scale) and has a reduced-motion branch that cuts instead of
playing a faster version. There is no breathing loop.

No Boat, no cloud-computer purchase, no plan, no vendor advertising: this client
talks to the person's own core and nothing else.

## Tests

`:core:test` is the whole protocol and policy suite, with no device and no
network beyond a loopback `MockWebServer`:

- wire serialisation, including that one unreadable record does not hide its
  healthy siblings and that an unknown status is dropped rather than shown as
  running;
- command bodies, including that a mutation carries the revision and that a
  secret field is never sent;
- SSE parsing across chunk boundaries, and reconnect sending `Last-Event-ID`;
- terminal frame decoding, observe restrictions, credit accounting, and a
  reattach that does not replay input;
- the ANSI screen: wrapping, scrolling, SGR colour, the alternate screen, and a
  UTF-8 character split across chunks;
- the conversation fold: streaming text, tool pairing, pending approvals and
  questions, duplicate adapter sequences, and a `seq` gap;
- authentication expiry, scope refusal, and revision conflicts with the
  revision the server holds;
- the viewer address rules;
- the notification policy, including that the body never carries prompt text.

```sh
cd apps/android && ./gradlew :core:test
```

## Limits

- The terminal renderer is a subset. A full-screen TUI that depends on
  mouse reporting, sixel or Kitty graphics, or unusual scroll-region
  manipulations will draw less than a desktop terminal does.
- The desktop viewer depends on the core publishing a same-origin noVNC entry.
  A core that only exposes its viewer on another port is refused rather than
  loaded.
- No push while the app is closed; no FCM sender is configured.
- Android has no per-app reduced-motion API before API 26's animator scale
  being readable, and this build reads that scale at composition time, so
  changing it while the app is open needs a restart.
