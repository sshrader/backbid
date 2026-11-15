# backbid (working name)

A Solana token launchpad built on Raydium LaunchLab. Each token's trading fees
fund a vault that buys tokens from holders and burns them, and the creator's
fee share is locked until graduation and then vested.

"backbid" is a placeholder taken from the site that inspired the design
(backbid.fun). The project will be renamed before anything is public.

## Status

Design stage. No code yet.

## Layout

| Path | Contents |
| --- | --- |
| `docs/program-spec.md` | Program spec: fee flow, lifecycle, accounts, instructions, parameters, invariants |
| `docs/backbid-reference.md` | Reference notes on backbid.fun, the site this design is based on |
| `programs/` | On-chain program (Rust, Anchor) |
| `api/` | Server that builds and simulates transactions, stores metadata, runs the fee harvester |
| `web/` | Web app |

## Before mainnet

- Independent audit of the program
- Multisig upgrade authority and treasury
- Legal review of the product and its risk disclosures
