// TEST ONLY. Loaded with `node --import` by tests/helpers/sse-client.ts (startApiProcess, every API child). server.ts
// prints "Forge API listening" and only then installs its SIGTERM handler; a signal sent in between gets the default
// action (the child is killed, exit code null). This writes one marker line to stderr once a SIGTERM listener has been
// added with process.on, so the tests signal the child only after that. Nothing in apps/ references this file.
const originalOn = process.on;
let announced = false;
process.on = function on(event, listener) {
  const result = originalOn.call(this, event, listener);
  if (event === "SIGTERM" && !announced) {
    announced = true;
    process.stderr.write("[test-preload] SIGTERM handler installed\n");
  }
  return result;
};
