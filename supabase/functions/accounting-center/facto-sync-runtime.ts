/** Bounded lifetime for the existing manual consolidation; never a second worker. */
export function startFactoSyncRuntime(
  renew: () => Promise<unknown>,
  options: { heartbeatMs?: number; deadlineMs?: number } = {},
) {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const deadline = setTimeout(() => controller.abort(new Error("FACTO_SYNC_DEADLINE")), options.deadlineMs ?? 600_000);
  const heartbeat = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = renew().then(() => undefined).catch(() => {
      controller.abort(new Error("FACTO_SYNC_LEASE_UNCONFIRMED"));
    }).finally(() => { pending = undefined; });
  }, options.heartbeatMs ?? 30_000);
  return {
    signal: controller.signal,
    async stop() {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      await pending;
    },
  };
}

export async function boundedFactoFetch(
  url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error("FACTO_SYNC_ABORTED"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("FACTO_SYNC_REQUEST_TIMEOUT")), timeoutMs);
  try {
    // Consume the body while the timeout is active, not just the response headers.
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
