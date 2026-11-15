# Stage 2 feasibility results (devnet, 2026-11-15)

## 1. Can a program-derived address (PDA) be the platform's fee wallet? Yes.

A small test program (`experiment/pda-claim`) was deployed to devnet. A platform was registered with the
program's PDA `["claimer"]` as `platformClaimFeeWallet`. After a token launch and buy built up fees, the
program called LaunchLab's `claim_platform_fee_from_vault` with `invoke_signed`. The claim succeeded:
0.01 SOL moved from the platform fee vault into the PDA's wrapped-SOL account.

Consequence: the vault program can own the platform's fee rights, so the fee split can be enforced by code.

Still to test: the post-graduation fee share (`platformLockNftWallet`, `platformVestingWallet`) with a PDA
as owner, and harvesting those fees through a program-signed call to the pool program.

## 2. TWAP source: the pool's own observation account works, with limits.

CPMM keeps a 100-slot ring buffer of cumulative prices per pool, at PDA `["observation", pool]`.
On the MIG test pool it held 3 samples covering 218 minutes (a quiet pool: samples are written only on swaps).

- Quiet pools: history reaches back for hours, so a long window is available.
- Busy pools: slots turn over quickly, so the guaranteed window may be as short as about 25 minutes.
- Plan: read the pool's observations for the TWAP, and add a permissionless `snapshot` instruction that
  records the price into the vault's own account so the window never depends on pool traffic.

## Build notes (for the real program)

- Use the standalone `cargo-build-sbf` (current version) with `--arch v0`; devnet does not yet accept newer SBPF versions.
- Deploy with Solana CLI 3.0.x. The CLI bundled builder and old CLI versions fail on current crate versions.
- The workflow at `.github/workflows/pda-experiment.yml` is a working template.

## Burnpad milestone 1 on devnet (2026-11-15)

Program `4n4LbjhT266eSR58gReHfE1ukjP6aYSij9C4TKhp1rFZ` (115 KB, SBPF v0). Run by `.github/workflows/burnpad-devnet.yml`:

- `create_launch` made a per-token LaunchLab platform whose admin and fee wallet is the program's authority PDA.
- LaunchLab's create-pool and first buy worked on that platform.
- `harvest_fees` claimed 0.00625 SOL through the PDA and split it 0.003125 vault / 0.0015625 creator stream / 0.0015625 treasury. Exactly 50/25/25.

Not yet tested on devnet: `mark_graduated`, `claim_creator`, `expire_creator` (need a graduated token and time), the post-graduation fee share, and the burn vault itself (milestone 2).

## Burnpad milestone 2: the burn vault on devnet (2026-11-15)

Program `9maH9DVCxUd4bjfCNnANW673Xt2YMXaWwQr8UEqAi1ZL`. Full path, run by `.github/workflows/burnpad-devnet.yml`:

- Token launched on its own program-owned platform with a 2 SOL graduation target, bought to graduation, migrated by Raydium to a CPMM pool.
- `mark_graduated` verified the pool on-chain and recorded it.
- `harvest_fees` filled the vault (0.01269 SOL).
- `sell_to_vault` priced from the pool's observation history (60 s window on devnet), paid the holder
  0.000183 SOL for 20,283.33 tokens (about 7.5% under market, as set), burned the tokens, and debited the vault by exactly the amount paid.

Notes:
- Raydium's `minFundRaisingB` on devnet is 1 lamport, not a usable target. Use an explicit target.
- Devnet allows a 60 s price window and zero reserve for testing; mainnet bounds (10 min, 0.05 SOL) are enforced by the `mainnet` feature.
- Still untested live: `claim_creator` (vesting is 30 days), `expire_creator`, a refused sale (guard, caps), pause.
