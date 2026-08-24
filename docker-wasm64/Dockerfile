FROM emscripten/emsdk:6.0.5

# Native stage0 needs the host libuv headers/library. The wasm stage builds its
# own patched libuv through Emscripten.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ccache \
      libssl-dev \
      libuv1-dev \
      pkg-config \
 && rm -rf /var/lib/apt/lists/*

