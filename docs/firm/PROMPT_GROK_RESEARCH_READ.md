# Prompt for Grok — adversarial pre-publication read of the research

**What to send.** Paste the block below the line, then paste the full contents
of `data/marketplace-health-report.md` underneath it.

**What has already been done, so you do not pay Grok to repeat it.** Every
headline figure was recomputed directly from `data/marketplace-health-2026-07-21.json`
on 2026-07-22 and all reproduce exactly:

| figure | claimed | recomputed |
|---|---|---|
| agents probed | 95 | 95 |
| dead or misrouted | 41 (43%) | 41 (43%) |
| verdict split | — | HTTP_ERROR 32, UNREACHABLE 9, X402_OK 42, NO_CHARGE 7, PRICE_MISMATCH 5 |
| live price above listing | 5 | 5 |
| Clawby #3209 ratio | 600× | 600× (listed 5000, live 3000000) |
| served free | 7, of which 5 advertise a fee | 7 / 5 |

That pass also found and fixed the report's biggest exposure: 9 of the 41
"dead" returned HTTP 400 (missing parameter) or 405 (wrong method), which point
at our request rather than their infrastructure — one of them, SignalLens AI
#3191, replied with the correct method to use. The headline now splits 32
hard failures from those 9 and names them.

So Grok is not being asked to check arithmetic. It is being asked the thing a
recomputation cannot answer: what would the accused say.

---

Copy everything below the line, then paste the report after it.

---

You are doing a pre-publication adversarial read of a research report that names
third parties. Read it as if you were hired by one of the agents it accuses.

We are about to publish this. It names specific agents on OKX's marketplace as
dead, as charging up to 600× their advertised price, and as serving free despite
listing a fee. These are reputational claims about other people's products,
published by a team that competes on the same marketplace. If any claim is
wrong, or reads as an accusation rather than a measurement, it damages us far
more than it helps.

The numbers have already been independently recomputed from the raw scan and all
reproduce. Do not spend effort re-deriving them, and do not assume an error
where none is shown. Assume the arithmetic is right and attack everything else.

**ONE QUESTION: which claims could a named agent's owner dispute, and what
exactly would they say?**

For each, give:
1. the claim, quoted from the report
2. the strongest good-faith rebuttal its subject could make, in their voice
3. whether the report's own stated method actually supports the claim
4. a specific replacement wording if it overreaches

Prioritise, most-likely-to-blow-up first. Focus on:

**a. The 600× Clawby claim.** The single most quotable and most damaging-if-
wrong number. What could make it unfair even though the arithmetic is right —
tiered pricing, a minimum charge, a listing the owner had already updated, a
promotional rate, a test endpoint? What would you say if you owned #3209?

**b. Method reach.** The report probes only the FIRST endpoint-bearing service
per agent, once, with the documented example body or `{}`. Does any claim reach
past what that method can support? The report knows about this and splits the
number — is the split sufficient, or does the framing still smuggle in more than
it proved?

**c. Tone.** We believe these are early-market failure modes, not bad actors,
and the text must never imply otherwise. Flag every sentence that could be read
as alleging deception, negligence or bad faith. Be sensitive: "advertises one
price and charges another" describes a measurement, but it is one word away from
alleging fraud.

**d. Competitive position.** We compete on this marketplace. A hostile reader
will say we published a report making our competitors look broken and ourselves
look necessary. Where is that reading most available, and what would defuse it
without gutting the finding?

**e. The Postscript.** A narrative section describing our own production run,
sourced from our job records rather than the scan. Check it for internal
consistency and overclaiming. It admits two of our own bugs — is that admission
doing real work, or does it read as performed humility?

**f. What we have not thought of.** Name any claim, framing or omission that
would embarrass us on publication that the questions above miss.

If the report is defensible, say which specific claims are load-bearing and why
they hold. Do not soften. We would rather be told now.
