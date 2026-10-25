// r4 shutdown: one process-wide counter for the shutdown phase lines (shutdown.ts and plugins/sse-shutdown.ts), so
// their order can be read back from the log. The order the lines arrive on stdout is not the order they were logged
// in: pino's default destination writes asynchronously, and at process exit pino's exit hook writes the queued lines
// synchronously while an earlier chunk can still be in flight (sonic-boom flushSync skips it), so that chunk lands
// later. Sort by phaseSeq to get the real order.

let last = 0;

/** The next phase number: 1 for the first phase line of the process, then strictly increasing. */
export function nextPhaseSeq(): number {
  last += 1;
  return last;
}
