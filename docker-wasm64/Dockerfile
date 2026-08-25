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

# emscripten-core/emscripten: $checkMailbox services proxied work on behalf of
# other threads (e.g. a pthread blocked in emscripten_proxy_sync), but wraps it
# in callUserCallback, whose maybeExit() tears the runtime down under
# EXIT_RUNTIME=1 when no keepalives are held (library-style embeddings that
# never run main). The proxied op executes, its ACK never reaches the caller,
# and the waiting thread is terminated. Hold a keepalive across the mailbox
# check. Upstream-shaped fix; see the PR/issue text in
# docs/LEAN4WEB-FEASIBILITY.md of the consuming repo.
RUN python3 - <<'PYEOF2'
path = '/emsdk/upstream/emscripten/src/lib/libpthread.js'
s = open(path).read()
old = """  $checkMailbox__deps: ['$callUserCallback',
                        'pthread_self',"""
assert old in s, 'checkMailbox deps anchor missing'
s = s.replace(old, """  $checkMailbox__deps: ['$callUserCallback',
                        '$runtimeKeepalivePush',
                        '$runtimeKeepalivePop',
                        'pthread_self',""", 1)
old2 = """    var pthread_ptr = _pthread_self();
    if (!pthread_ptr) return;
    callUserCallback(() => {"""
assert old2 in s, 'checkMailbox body anchor missing'
s = s.replace(old2, """    var pthread_ptr = _pthread_self();
    if (!pthread_ptr) return;
    // Servicing the mailbox executes proxied work on behalf of other threads
    // (e.g. a pthread blocked in emscripten_proxy_sync); it must not trigger
    // EXIT_RUNTIME teardown via callUserCallback's maybeExit, which would
    // terminate the waiting thread before it can consume the result.
    runtimeKeepalivePush();
    callUserCallback(() => {""", 1)
old3 = """      __emscripten_check_mailbox();
    });
  },"""
assert old3 in s, 'checkMailbox tail anchor missing'
s = s.replace(old3, """      __emscripten_check_mailbox();
    });
    runtimeKeepalivePop();
  },""", 1)
open(path, 'w').write(s)
print('libpthread.js checkMailbox keepalive-guarded')
PYEOF2

