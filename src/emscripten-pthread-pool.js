// Patch 0038: the host sizes the pthread Worker pool the glue creates at load.
//
// A --js-library of the `lean` link (src/CMakeLists.txt). -sPTHREAD_POOL_SIZE is a JS expression
// that emsdk emits verbatim in PThread.initMainThread,
//   var pthreadPoolSize = <value>; while (pthreadPoolSize--) PThread.allocateUnusedWorker();
// so the link passes the name of the variable below, which the glue initializes with the other
// library code, before any postset (`PThread.init()` is one) runs. `Module.pthreadPoolSize` is
// read once, when the glue is evaluated: an integer clamped to 0..64; absent, blank or not a
// number, 24, the pool this build has always had (0019). Each pool Worker is created, and loads
// the module, at start-up; a thread beyond the pool gets a Worker of its own when it starts
// (PROXY_TO_PTHREAD forces PTHREAD_POOL_SIZE_STRICT=0), as before. Every pthread Worker
// evaluates the same line against its own Module, where nothing uses it.
//
// `pthreadPoolSize` is not in -sINCOMING_MODULE_JS_API (src/CMakeLists.txt), on purpose: that
// list gates only Emscripten's own reads of Module; a plain Module["…"] read like this one works
// without it.
//
// Pinned to the build image's emsdk (docker-wasm64/Dockerfile): the verbatim emission, the order
// of library code and postsets, and `extraLibraryFuncs` are 6.0.5's. Another emsdk fails the link
// here until they are re-checked.
#if EMSCRIPTEN_VERSION != '6.0.5'
#error "src/emscripten-pthread-pool.js relies on emsdk 6.0.5's PTHREAD_POOL_SIZE emission and library order: re-check them, then move this pin"
#endif

// Only the emitted pool loop names the variable, and that is no library dependency: include it.
extraLibraryFuncs.push('$leanPthreadPoolTarget');

addToLibrary({
  // an integer in [lo, hi] from a host value; dflt when it is absent, blank or not a finite number
  $leanPoolInt: function(v, dflt, lo, hi) {
    if (v === undefined || v === null || String(v).trim() === '') return dflt;
    var n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  },

  // the value of -sPTHREAD_POOL_SIZE
  $leanPthreadPoolTarget__deps: ['$leanPoolInt'],
  $leanPthreadPoolTarget: '=leanPoolInt(Module["pthreadPoolSize"], 24, 0, 64)',
});
