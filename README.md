# backbid (working name)

A Solana token launchpad built on Raydium LaunchLab. Each token's trading fees
fund a vault that buys tokens from holders and burns them, and the creator's
fee share is locked until graduation and then vested.

"backbid" is a placeholder taken from the site that inspired the design
(backbid.fun). The project will be renamed before anything is public.

## Status

Design stage, with a simulated prototype and a first devnet integration (launch, buy, sell through Raydium LaunchLab). The burn vault program is not written yet.

## Layout

| Path | Contents |
| --- | --- |
| `docs/program-spec.md` | Program spec: fee flow, lifecycle, accounts, instructions, parameters, invariants |
| `docs/stranded-vault-options.md` | Options for vault SOL of tokens that never graduate; undecided |
| `docs/backbid-reference.md` | Reference notes on backbid.fun, the site this design is based on |
| `programs/` | On-chain program (Rust, Anchor) |
| `api/` | Devnet-only server that builds Raydium LaunchLab transactions for wallets to sign |
| `docs/devnet-setup.md` | Steps to run real launches on Solana devnet |
| `web/index.html` | The live devnet app: connect a wallet, launch, buy, sell, claim platform fees |
| `web/prototype.html` | Simulator with made-up data, for testing the burn vault design and parameters |
| `web/` | The website. Static files, no build step |

## Before mainnet

- Independent audit of the program
- Multisig upgrade authority and treasury
- Legal review of the product and its risk disclosures
