# The Android sandbox image: the standard sandbox PLUS an Android emulator, so
# an agent can build a mobile app, run it, tap through it and screenshot it.
#
#   docker build --platform linux/amd64 -t studio-sandbox-android:local \
#     --build-arg BASE_TAG=<studio-sandbox-go tag> \
#     -f packages/sandbox/image-android/Dockerfile packages/sandbox/image-android
#
# Derived, not forked: the base already carries the Flutter SDK, the daemon and
# the skills, so everything below is additive and this image can never drift
# from the daemon it runs.
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
# which it cannot do at runtime on a read-only rootfs. The versions are the
# ones Flutter's Gradle plugin defaults to (compileSdk 36, NDK 28.2.13676358,
# cmake 3.22.1 for native plugins); a repo pinning something else fails its
# Gradle build naming the missing package.
ARG CMDLINE_TOOLS=commandlinetools-linux-16111833_latest.zip
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
  && curl -fsSL -o /tmp/cmdline-tools.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS}" \
  && unzip -q /tmp/cmdline-tools.zip -d /tmp \
  && mv /tmp/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
  && rm /tmp/cmdline-tools.zip \
  && yes | sdkmanager --licenses >/dev/null \
  && sdkmanager --install \
       "platform-tools" "emulator" \
       "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" \
       "ndk;28.2.13676358" "cmake;3.22.1" \
       "system-images;android-36;google_apis;x86_64" >/dev/null

COPY bin/qa-android /usr/local/bin/qa-android
# The base image's engine.stamp/realm/lockfile are symlinks into /tmp, and a
# root layer there left the targets root-owned; `sandbox` cannot overwrite them
# in sticky /tmp. Pods mount a fresh /tmp, so only this build trips on it.
RUN chmod 0755 /usr/local/bin/qa-android \
  && rm -f /tmp/flutter-engine.stamp /tmp/flutter-engine.realm /tmp/flutter-lockfile

USER sandbox
# /opt/flutter belongs to `sandbox` in the base image, so the Android engine
# artifacts land without a chown that would duplicate the whole SDK layer.
RUN flutter precache --android --no-ios --no-web --no-linux

ENV STUDIO_SANDBOX_ANDROID_EMULATOR=1
