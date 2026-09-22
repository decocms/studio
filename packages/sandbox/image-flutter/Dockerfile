# The Flutter sandbox image: the standard sandbox PLUS the ability to run a
# real Flutter app and look at it.
#
#   docker build -t studio-sandbox-flutter:local \
#     --build-arg BASE_TAG=<studio-sandbox-go tag> \
#     -f packages/sandbox/image-flutter/Dockerfile packages/sandbox/image-flutter
#
# Derived, not forked: the base already carries the Flutter SDK, the daemon,
# the skills and qa-screenshot, so everything below is additive and this image
# can never drift from the daemon it runs. Its own layer is ~1.3GB of apt,
# which is exactly why it is a separate image rather than more weight on the
# one every sandbox pulls.
#
# What the extra layer buys: `flutter build web` is the base image's only way
# to see a UI, and a repo whose dependency graph cannot compile to JS has no
# way at all — Studio hit this on a real app whose transitive deps use 64-bit
# int literals (dart2js) and `dart:html` (dart2wasm). The Linux desktop target
# has neither problem because it is native, and it runs the app's actual
# main(), so routing, state and navigation are real rather than a widget
# rendered in isolation.
ARG BASE_IMAGE=ghcr.io/decocms/studio/studio-sandbox-go
ARG BASE_TAG
FROM ${BASE_IMAGE}:${BASE_TAG}

USER root

# Three groups:
#  - Flutter's linux-desktop toolchain. `lld` and `llvm` are NOT optional and
#    not obvious: the native-assets build step resolves its linker and archiver
#    ONLY under /usr/lib/llvm-<N>/bin, so binutils' /usr/bin/ld is invisible to
#    it and any repo with a native-assets dependency dies on
#    "Failed to find any of [ld.lld, ld]".
#  - A headless X server with software GL. Sandbox nodes have no GPU, so
#    llvmpipe via LIBGL_ALWAYS_SOFTWARE is the renderer.
#  - Input synthesis and screen capture. `xdg-user-dirs` belongs to this group
#    for a non-obvious reason: path_provider_linux shells out to `xdg-user-dir`,
#    and without it every plugin that resolves an app directory throws
#    MissingPlatformDirectoryException — which reads exactly like "this plugin
#    has no Linux implementation" and is not.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       clang cmake ninja-build pkg-config libgtk-3-dev liblzma-dev \
       lld llvm \
       xvfb libgl1-mesa-dri libegl1 libgles2 \
       xdotool x11-utils imagemagick xdg-user-dirs \
  && rm -rf /var/lib/apt/lists/* \
  && flutter config --enable-linux-desktop --no-analytics \
  && flutter precache --linux \
  && chown -R sandbox:sandbox /opt/flutter

COPY --chown=sandbox:sandbox bin/qa-app /usr/local/bin/qa-app
RUN chmod 0755 /usr/local/bin/qa-app

# The display qa-app serves on. LIBGL_ALWAYS_SOFTWARE is load-bearing: without
# it the GTK embedder tries a real GL context and the app never paints.
ENV DISPLAY=:99 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    STUDIO_SANDBOX_FLUTTER_DESKTOP=1

USER sandbox
