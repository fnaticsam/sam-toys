// Timers and listeners are owned by a single operation and always disposed.
export function deadline(ms, parent) {
  const controller = new AbortController();
  const expiresAt = performance.now() + ms;
  const abort = () => controller.abort(parent.reason);
  const timeout = () => controller.abort(new DOMException('Operation timed out', 'TimeoutError'));
  const timer = setTimeout(timeout, ms);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    assertActive() {
      if (performance.now() >= expiresAt && !controller.signal.aborted) timeout();
      controller.signal.throwIfAborted();
    },
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', abort); },
  };
}

// Some SDKs wait through retry backoff before observing an AbortSignal. Race the
// entire operation, while still aborting it and observing any late rejection.
export async function withinDeadline(ms, parent, operation) {
  const scope = deadline(ms, parent);
  try {
    return await new Promise((resolve, reject) => {
      const clean = () => scope.signal.removeEventListener('abort', abort);
      const abort = () => { clean(); reject(scope.signal.reason); };
      scope.signal.addEventListener('abort', abort, { once: true });
      try { scope.assertActive(); } catch (error) { clean(); reject(error); return; }
      Promise.resolve().then(() => {
        scope.assertActive();
        return operation(scope.signal, scope.assertActive);
      }).then(value => {
        clean();
        try { scope.assertActive(); resolve(value); } catch (error) { reject(error); }
      }, error => { clean(); reject(error); });
    });
  } finally { scope.dispose(); }
}

export function pause(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
