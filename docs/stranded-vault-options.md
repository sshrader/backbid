# Stranded vault SOL: options

As of 15 November 2026. Status: undecided.

## The problem

A burn vault collects SOL from the first trade but only starts buying at
graduation. If a token never graduates, its vault SOL can never be spent. In
the prototype's example data that is about 0.025 SOL for a token that raised
4 SOL, so each case is small, but most launched tokens never graduate.

## Options

| Option | How it works | For | Against |
| --- | --- | --- | --- |
| A. Admin vault wallet | The admin can send SOL out of any vault when needed | Simplest to build; handles any future problem | Breaks the "no withdrawal path" promise that the whole design rests on. One stolen or misused key can drain every vault. Adds custody and legal exposure |
| B. Buy from the curve and burn | After the expiry deadline, anyone can trigger the vault of a non-graduated token to buy its own token on the curve and burn it | Keeps the rule that a vault only ever buys and burns. No admin power. Helps the remaining holders | One more Raydium call to build and test. A trader can buy just before the trigger and sell just after, though each leg costs the 1.5% fee |
| C. Refund holders pro rata | At expiry, holders claim a share of the vault's SOL | Fairest to holders | Needs a snapshot and a claim system. Looks like a payout, which adds legal risk |
| D. Timelocked sweep to treasury | Only for expired, non-graduated tokens, only after a long delay such as 90 days, only to the treasury, stated up front | Simple. Far narrower than option A | The platform earns from failed tokens, which is a bad incentive and a bad look |
| E. Leave it stranded | Do nothing | No code, no risk | SOL is lost for good. BackBid appears to accept this |

## Recommendation

Option B. It is the only one that spends the SOL the way the vault always
promised to, and it needs no trusted party.

If B proves hard to build for the first version, ship E and add B later. The
program is upgradeable, so this can wait.

## On the vault wallet idea

A general-purpose wallet that can move vault funds is option A. It would work,
but it changes what the product is: users would be trusting the team not to
take the money, not the code. That is the same weakness BackBid's design avoids,
and it is the first thing an auditor or a cautious trader will look for.

If an emergency lever is still wanted, keep it narrow:

- Only for tokens past the expiry deadline that have not graduated
- Only after a public delay (a timelock), so anyone can see it coming
- Only signed by a multisig, never one key
- Only to one fixed destination written into the program

That is option D. A lever with those four limits cannot touch a live token's
vault.

## A second finding from the prototype

Vaults are small compared with the market they sit beside. With the default
settings, a token that graduates at 85 SOL has a vault of about 0.5 to 0.6 SOL.
The 2% per-sale cap then allows about 0.011 SOL per sale, which burns roughly
0.003% of supply each time.

That may be too weak to matter to traders. Levers to test on the prototype's
bench:

- Raise the share of fees that goes to the vault
- Raise the per-sale cap and the daily budget
- Raise the pool fee routed after graduation, since most volume comes later
- Lower the bid discount so more holders use the vault

BackBid has the same proportions, so this is a property of the fee level, not
of the burn design.
