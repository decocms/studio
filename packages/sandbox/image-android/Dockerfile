# The Android sandbox image: the standard sandbox PLUS an Android emulator, so
# an agent can build a mobile app, run it, tap through it and screenshot it.
#
#   docker build --platform linux/amd64 -t studio-sandbox-android:local \
#     --build-arg BASE_TAG=<studio-sandbox-go tag> \
#     -f packages/sandbox/image-android/Dockerfile packages/sandbox/image-android
#
# Derived, not forked: the base carries the daemon and the skills, so this image
# can never drift from the daemon it runs. The Flutter SDK lives only here; the
# default image has no use for it without a way to run the app.
#
# Why an emulator and not `flutter build web` / the Linux desktop target: a
# mobile app's startup path is full of plugins that exist only on Android and
# iOS (Firebase, push, attribution SDKs). Neither web nor desktop can run that
# `main()` unmodified; Android can, and the app is not ours to change.
#
# amd64 only: Google ships the Linux emulator for x86_64 alone. It needs
# /dev/kvm at RUNTIME — the chart schedules this image onto nodes launched with
# nested virtualization and requests the device; see values.yaml
# `imageVariants`. Without KVM `qa-android start` fails fast rather than
# crawling through a software-emulated boot.
ARG BASE_IMAGE=ghcr.io/decocms/studio/studio-sandbox-go
ARG BASE_TAG
FROM ${BASE_IMAGE}:${BASE_TAG}

USER root

ENV ANDROID_HOME=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}

# JDK 21 for Gradle; the rest are shared libraries the emulator binary links
# against even when it runs with -no-window.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       openjdk-21-jdk-headless \
       libpulse0 libnss3 libxcomposite1 libxcursor1 libxi6 libxtst6 \
       libasound2t64 libgl1 libxkbfile1 libx11-xcb1 libxdamage1 libxrandr2 \
       libdrm2 libgbm1 libbsd0 \
  && rm -rf /var/lib/apt/lists/*

# Everything Gradle would otherwise try to download INTO the SDK at build time,
# which it cannot do at runtime on a read-only rootfs. The app compiles against
# Flutter's defaults (compileSdk 36, NDK 28.2.13676358, cmake 3.22.1 for
# native plugins), but each plugin compiles against its OWN compileSdk —
# firebase_core pins 34 — so the recent platforms are all here. A repo needing
# something else fails its Gradle build naming the missing package.
ARG CMDLINE_TOOLS=commandlinetools-linux-16111833_latest.zip
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
  && curl -fsSL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS}" \
  && unzip -q /tmp/cmdline-tools.zip -d /tmp \
  && mv /tmp/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
  && rm /tmp/cmdline-tools.zip \
  && yes | sdkmanager --licenses >/dev/null \
  && sdkmanager --install \
       "platform-tools" "emulator" \
       "platforms;android-36" "platforms;android-35" "platforms;android-34" \
       "build-tools;36.0.0" "build-tools;35.0.0" \
       "ndk;28.2.13676358" "cmake;3.22.1" \
       "system-images;android-36;google_apis;x86_64" >/dev/null \
  # sdkmanager extracts binaries owner-only (0744); the sandbox user runs them.
  && chmod -R a+rX ${ANDROID_HOME}

# Flutter SDK. `--web` keeps `flutter build web` + `qa-screenshot --flutter`
# as a fallback for when the Android build fails for reasons outside the change.
#
# ⚠️ The version is a pin that DRIFTS: `flutter analyze` disagrees with itself
# across releases, so a repo whose CI pins another version gets findings its
# own gate would not produce. The skill makes the agent check the repo's pin
# against this and say so; bump here when that stops matching reality.
ARG FLUTTER_VERSION=3.41.2
#
# FLUTTER_SUPPRESS_ANALYTICS rather than `flutter --disable-analytics`: that
# command writes a per-user config file, and this layer runs as root while
# every run is the `sandbox` user.
#
# PUB_CACHE is set for THIS layer only (reset below): pub bakes absolute cache
# paths into flutter_tools' package_config.json and its snapshot, and the
# default /root/.pub-cache is 0700 — unreadable by the `sandbox` user, so the
# tool re-resolved its own deps on each invocation and died writing to the
# read-only SDK.
ENV FLUTTER_ROOT=/opt/flutter \
    FLUTTER_SUPPRESS_ANALYTICS=true \
    PUB_CACHE=/opt/pub-cache \
    PATH=/opt/flutter/bin:$PATH
# ponytail: the rm covers bases published before Flutter left them; a no-op after.
RUN rm -rf /opt/flutter /opt/pub-cache \
  && git clone --depth 1 -b "${FLUTTER_VERSION}" \
      https://github.com/flutter/flutter.git /opt/flutter \
  # git refuses to operate in a tree owned by another uid.
  && git config --system --add safe.directory /opt/flutter \
  && flutter precache --universal --web --android --no-ios --no-linux \
  # `bin/flutter` rewrites these three on EVERY invocation, under `set -e`, so
  # on the read-only rootfs every flutter command aborted before it started.
  # They are per-invocation state; point them at /tmp.
  && for f in engine.stamp engine.realm lockfile; do \
       rm -f "/opt/flutter/bin/cache/$f" \
       && ln -s "/tmp/flutter-$f" "/opt/flutter/bin/cache/$f"; \
     done \
  # Every Android build compiles Flutter's Gradle plugin as an included build in
  # place, writing .gradle/, build/ and .kotlin/ inside the SDK. Same fix;
  # qa-android creates the targets before it builds.
  && cd /opt/flutter/packages/flutter_tools/gradle \
  && rm -rf .gradle build .kotlin \
  && ln -s /tmp/flutter-gradle/dot-gradle .gradle \
  && ln -s /tmp/flutter-gradle/build build \
  && ln -s /tmp/flutter-gradle/kotlin .kotlin \
  && chown -R sandbox:sandbox /opt/flutter \
  && chmod -R a+rX /opt/pub-cache \
  # Debian's /etc/profile resets PATH, so `bash -lc flutter` needs these.
  && ln -sf /opt/flutter/bin/flutter /usr/local/bin/flutter \
  && ln -sf /opt/flutter/bin/dart /usr/local/bin/dart \
  && flutter --version \
  # That root run left the /tmp stamp targets root-owned, and `sandbox` cannot
  # overwrite them in sticky /tmp. Pods mount a fresh /tmp; this build does not.
  && rm -f /tmp/flutter-engine.stamp /tmp/flutter-engine.realm /tmp/flutter-lockfile
# A run's own `flutter pub get` must write somewhere writable; /opt/pub-cache is
# read-only baked SDK state. /home/sandbox is the per-pod ephemeral volume.
ENV PUB_CACHE=/home/sandbox/.pub-cache

COPY bin/qa-android /usr/local/bin/qa-android
RUN chmod 0755 /usr/local/bin/qa-android

USER sandbox
ENV STUDIO_SANDBOX_ANDROID_EMULATOR=1
