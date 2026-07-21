# Firm hackathon demo

Run the filmable proof from the repository root:

```bash
pnpm -F @firm/demo film:paced
```

The command is safe to rehearse. It does not import a signer, load a wallet key,
or settle a payment. Its three segments are deliberately labeled:

1. `LIVE / UNPAID` probes the current marketplace shortlist and reads each 402
   challenge without signing it.
2. `REAL / SETTLED` prints the two previously settled outbound transactions and
   their OKLink explorer links. They are procurement costs, not revenue.
3. `SIMULATED` demonstrates failure, replacement, and absorbed margin using the
   deterministic vendor fixtures. It does not assert that a real vendor failed.

Use `pnpm -F @firm/demo film` for an unpaced rehearsal. The live results can
change when vendors repair endpoints or prices; narrate the values printed by
the current run rather than memorizing the July 21 snapshot.

Suggested recording framing: keep the terminal at roughly 110 columns, start
recording before the command, and narrate the three truth labels rather than
reading every candidate row. The command itself normally completes in seconds,
leaving most of the 90-second limit for narration and the opening/closing shot.
