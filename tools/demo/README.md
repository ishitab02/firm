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
3. `REAL / REFUNDED` is a real paid job that hired five vendors, fired all of
   them, refunded the buyer automatically and absorbed the vendor cost. Both
   transactions resolve on X Layer.
4. `REAL / DELIVERED` is the same job type completing in ~12s once ranking
   stopped favouring dead endpoints, with its reconciled economics.

There is no SIMULATED segment any more. Until 2026-07-22 the failure sequence
was a deterministic fixture, carried because no real incident existed to film.
One does now.

**Every inbound purchase shown was made by this team from its own wallet as
QA.** The output labels it `OUR OWN WALLET — QA`. Narrate it that way. It is not
revenue, not demand, not traction, and a judge who goes looking for an
undisclosed self-purchase should find nothing.

Use `pnpm -F @firm/demo film` for an unpaced rehearsal. The live results can
change when vendors repair endpoints or prices; narrate the values printed by
the current run rather than memorizing the July 21 snapshot.

Suggested recording framing: keep the terminal at roughly 110 columns, start
recording before the command, and narrate the three truth labels rather than
reading every candidate row. The command itself normally completes in seconds,
leaving most of the 90-second limit for narration and the opening/closing shot.
