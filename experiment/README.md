# Stage 2 experiment: can a program own the platform's fee wallet?

Everything here is devnet only and uses a throwaway wallet that the workflow creates.

- `pda-claim/`: a small Rust program. Its PDA `["claimer"]` is set as the LaunchLab platform's `platformClaimFeeWallet`. One instruction calls LaunchLab's `claim_platform_fee_from_vault` and signs as that PDA.
- `run.mjs`: registers a platform with the PDA as fee wallet, launches and buys a token so fees build up, then calls the program to claim them. If given a pool, it also reports how far back the pool's price history (TWAP buffer) reaches.
- `.github/workflows/pda-experiment.yml`: builds the program, deploys it, and runs the script.

## Run it

1. GitHub, Actions tab, "PDA fee-claim experiment (devnet)", Run workflow.
2. First run stops and shows a wallet address on the run summary. Send it 3 devnet SOL.
3. Run it again. The output shows PASS or FAIL for the PDA claim.
4. Optional: paste a graduated token's pool address into `pool_id` to check the TWAP buffer.
