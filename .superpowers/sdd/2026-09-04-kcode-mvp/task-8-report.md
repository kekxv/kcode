# Task 8 report — framed disposable VM execution

Implemented nonce-framed shell execution in `/work`, streaming output sanitization, fixed execution deadlines, cancellation, and Side Panel native-worker containment.

## Containment properties

- The execution controller parses framing incrementally, including arbitrary chunk boundaries. It never forwards `KCODE_*` control frames to terminal output.
- Every end frame, including a forged or malformed end frame, destroys the v86 runtime before resolving a terminal result. Cancellation, timeout, and output-limit failure also destroy it without waiting for guest cooperation.
- Retained output is capped at 1 MiB; total sanitized stream output is capped at 8 MiB. The Side Panel independently counts stream bytes and native-terminates a worker on timeout, heartbeat failure, output overflow, disconnect, or cancel.
- VM result events now include truncation, duration, transaction ID, and journal summary. The destroyed emulator cannot execute again; the retained Task 7 journal can only be committed or rolled back, after which the Worker closes.
- VM request guards restrict shell commands to 32 KiB UTF-8 and timeouts to 1,000–600,000 ms. Worker and watchdog generations discard late messages/controls.

## Verification

Run on 2026-09-04:

```text
npm run test:run -- tests/unit/exec-controller.test.ts tests/unit/vm-watchdog.test.ts tests/security/process-containment.test.ts tests/unit/protocol.test.ts tests/unit/vm-worker.test.ts tests/unit/vm-client.test.ts
# 6 files passed, 43 tests passed

npm run typecheck
# passed

npm run assets:verify
# VM asset verification passed
```

The test suite verifies the framing and hostile-process cases using controlled runtime doubles. No browser-hosted real-v86 guest command was run in this task; the existing 256 MiB v86 asset set and the `/work` mount topology were preserved and asset verification passed.

## Commit

```text
git commit -m "feat: contain shell calls in disposable vm"
# 14 files changed, 660 insertions(+), 50 deletions(-)
```
