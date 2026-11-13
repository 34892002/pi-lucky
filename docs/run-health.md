# Run health protection

The Pi SDK driver monitors each active run independently. It uses Pi's existing
cancellation operation and does not retry prompts or start a replacement runtime.

## Detection

- Inactivity defaults to 45 minutes without meaningful assistant text/thinking or
  tool activity. `PiSdkDriverOptions.runInactivityTimeoutMs` changes it; `0`
  disables inactivity detection but leaves repeated-read detection enabled.
- Waiting for a host dialog pauses the inactivity budget. Usage refreshes and
  session-status events do not refresh it. Tool execution is subject to the same
  deadline, so a silent tool can eventually be interrupted; long-running tools
  should publish progress or use a larger configured deadline.
- Timers run in slices of at most one minute. Large scheduling gaps (sleep,
  suspend, or clock changes) reset the budget instead of immediately firing.
- Thirty consecutive successful `read`, `grep`, `find`, or `ls` results with
  identical tool name, input, and complete output cause an interruption when
  consecutive results arrive less than 30 seconds apart. Different results,
  other tools, errors, and paced calls break the streak. Nested script calls are
  excluded because they are not independent model attempts.
- Fingerprints use canonical JSON and SHA-256. Unsupported, cyclic, oversized,
  or excessively deep data is skipped rather than compared using truncated
  evidence. Pending comparisons are bounded. No evidence is sent to another
  model or service.

This intentionally does not classify arbitrary shell commands, alternating
investigations, or repeated failures as loops. Those require additional evidence
to distinguish useful iteration from wasted work.

## Cancellation and ownership

A detected problem emits a `runFailed` event with `TURN_STALLED` or
`TOOL_LOOP_DETECTED`, stops monitoring, clears queued input, and requests Pi
cancellation. Checkpoint capture records automatic interruption separately from
a user's Stop. A later settlement cannot emit successful completion for that run.

The session remains unavailable until the captured cancellation call resolves,
Pi reports settlement, prompt preflight has returned, and streaming has stopped.
After `runStopTimeoutMs` (default 15 seconds), an unconfirmed cancellation also
produces a warning. Runtime references and the session-file lease remain owned;
reopen, reload, session replacement, and workspace removal must not bypass this
state. The session can be used again after confirmed cancellation. If it never
confirms, restarting the app is the supported recovery.

The SDK executes in the sidecar process. An in-process timer cannot detect or
terminate code that blocks that process's JavaScript event loop. Hard termination
of such work requires a separate process/worker boundary and external supervision.
Automatic replacement of an unconfirmed in-process runtime could leave the old
runtime writing the same transcript and is deliberately avoided.

## Module boundaries

- `run-health-monitor.ts` owns detection, fingerprints, and inactivity budgets.
- `session-run-health.ts` adapts Pi events and owns monitor lifecycle, interruption
  epochs, cancellation deadlines, and cancellation confirmation. It receives a
  narrow session-state view and callbacks rather than the supervisor or record.
- `session-supervisor.ts` owns queue changes, persisted/emitted outcomes, and
  runtime/lease operations. Those operations consult the controller's reuse guard.

Cancellation confirmation never releases a lease or replaces a runtime itself.

## Validation

Monitor and controller tests use deterministic clocks and timers. Supervisor regressions cover
unresponsive and throwing aborts, late events, settlement ordering, handled input,
queue edits crossing cancellation, session isolation, and ownership preservation.
With Node 22.14, run `.mts` tests with type stripping:

```sh
npm run build --workspace=@pi-gui/pi-sdk-driver
node --experimental-strip-types --test --test-concurrency=1 "packages/pi-sdk-driver/test/**/*.test.mts"
```
