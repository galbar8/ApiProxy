# Rules: tests/**

- A reliability feature without a failure-path test is not implemented.
- Adversarial conditions are injected, never awaited. Duplicate delivery, reordering,
  crashes and replays are produced deliberately by the dispatcher so the test is
  deterministic (ADR-0009).
- A duplicate-delivery test must assert the _absence_ of a second business effect, not
  merely that the second call did not throw.
- Crash-window tests must kill between the two operations that matter and then assert
  the workflow still reaches a terminal state.
- Never weaken an assertion to make a suite green. If behaviour changed, either the
  behaviour is wrong or an invariant changed — and an invariant change needs an ADR.
- Emulator behaviour is not evidence about AWS behaviour. Assert the application's
  tolerance, not the emulator's quirks.
