# BackBid launchpad reference notes

Snapshot of backbid.fun, read 14 to 15 November 2026, captured as a reference
for building a similar launchpad.

## What it is

[BackBid](https://backbid.fun/) is a Solana token launchpad built on Raydium.
Its distinguishing feature is that every launched token gets its own on-chain
OTC Liquidity Vault, a program account that can buy the token back from holders
after graduation.

A second product, the OTC market, handles fixed-price sales and buy requests
for any Solana token.

## Launch mechanics

Tokens start on Raydium's bonding curve and graduate to a locked CPMM pool at
85 SOL raised.

| Item | Value |
| --- | --- |
| Bonding-curve trade fee | 1.5% per trade |
| Fee recipients | 1.25% BackBid, 0.25% Raydium |
| Creator fee | 0% |
| Split of BackBid's SOL fees | 50% token vault, 50% treasury, fixed at launch |
| Graduation threshold | 85 SOL raised |
| After graduation | Raydium CPMM pool, liquidity locked permanently, vault opens |
| Post-graduation vault income | Token-side pool fees |
| Cost to launch | About 0.0389 SOL in rent, plus network fees |

## Vault rules

The vault quotes a formula-based bid and ask off the pool price, and has no
withdrawal path.

| Rule | Value |
| --- | --- |
| Bid | 10% below the lower of spot and the 20-minute TWAP |
| Ask | 3% above the higher of spot and the 20-minute TWAP |
| Circuit breaker | Trading halts if spot moves more than 15% from TWAP |
| Per-sale cap | 2% of the vault's SOL |
| Daily budget | 10% of the vault's SOL |
| Reserve | 0.1 SOL |
| Token holdings cap | 50% of vault value |

- The vault never sells into the pool.
- Funds leave only to a holder selling to the vault or a buyer paying the ask.
- The admin can pause vaults and tune parameters within bounds set by the
  program.
- These limits are defaults; each vault's values can differ within those bounds.

## OTC market

Sellers list a block at a fixed price, and buyers post funded buy requests. An
escrow program holds the tokens and swaps them for payment in one transaction.

- Buyer fee: 1% on top of the price
- Seller fee: 1% taken from proceeds
- Listing deposit: 0.0031 SOL, refundable

## Inner pages

### Launch form

[The launch page](https://backbid.fun/launch/) is one form with a live preview
and cost breakdown beside it.

- **Fields:** image (PNG, JPG, WebP or GIF, up to 2 MB, square preferred),
  name, ticker, description (optional, 500 characters), website, X and Telegram
  links (all optional).
- **First buy:** an optional SOL amount bought in the same transaction, with
  slippage choices of 1%, 3% or 5%.
- **Preview card:** token name, ticker and description, vault balance, and a
  progress bar toward 85 SOL.
- **What you pay:** account rent of about 0.0389 SOL (not refundable), the
  first buy and its 1.5% fee, and a network fee under 0.001 SOL.
- **Fee summary:** the per-trade fees and the 50/50 split are restated before
  the "Review launch" button.

### How a launch works under the hood

From [How it works](https://backbid.fun/how-it-works/) and
[Security](https://backbid.fun/security/):

- One transaction creates the mint on a Raydium bonding curve, the token's
  vault, and its fee routing.
- The server generates the mint keypair, co-signs, and discards the key.
- Metadata is stored off-chain by BackBid's API and linked on-chain, and cannot
  be changed later.
- Each token gets its own Raydium platform config, administered by a program
  address called `launch_auth`.
- At graduation the LP is locked in Raydium's LP lock; `launch_auth` holds the
  fee key, so LP fees follow the same split.
- Fee harvesting is permissionless. BackBid's server runs it regularly and
  records per-token totals.
- BackBid's API builds and simulates each transaction, and the user signs an
  unsigned transaction after a simulation review.
- The Raydium SDK runs only on the server. Sign-in uses Sign-in with Solana,
  with optional Google sign-in to sync settings.
- Supported wallets: Phantom, Solflare, Backpack, and any Wallet Standard
  wallet.

### Vault formulas

- `bid = min(TWAP, spot) × (1 − 0.10)`
- `ask = max(TWAP, spot) × (1 + 0.03)`
- The TWAP is read on-chain from the Raydium pool at every vault trade; no
  stored or external price is used.
- The daily budget is 10% of vault SOL at the start of each 24-hour window.
- The inventory cap counts total value as SOL plus tokens priced at TWAP.
- Vault trades carry no platform fee; the spread stays in the vault.
- Each vault's discount, premium and limits can differ from the defaults. The
  admin tunes them within hard-coded bounds, which are not published.

### Vault leaderboard

[The vaults page](https://backbid.fun/vaults/) shows four totals (SOL in
vaults, 24-hour vault volume, fees harvested, graduated vaults open) above a
ranked list.

Each row shows rank, token name and ticker, vault SOL, a status of Accumulating
or Open, graduation progress as a percentage, a dollar figure that looks like
market cap, and two further SOL figures.

When read, the site was small: 4 tokens, 1 graduated, 2.96 SOL across all
vaults, and 5.93 SOL in fees harvested.

### OTC details

- Payment is in SOL or USDC, and offers can be filled partially.
- Offer states: listed, partially filled, sold out, cancelled, ended, reclaimed.
- Interest-only buy requests are free; funded ones lock the payment plus the 1%
  buyer fee.
- Rejected tokens: active freeze authority, non-transferable, and Token-2022
  tokens with permanent delegate, transfer hook, transfer fee, confidential
  transfers or pause extensions.
- Seller prices are not checked; each offer shows how it compares to market.

### Program and trust

- Program ID on Solana mainnet: `79nCYbsLEMaeGFv3DHBSGE26ZbFrVV8879T9AudcYnvA`
- The program is upgradeable, tested on devnet with an automated suite, and not
  audited.
- An emergency pause exists and never blocks cancels or refunds.
- Calls into Raydium use pinned program IDs, so callers cannot substitute
  accounts.
- The whole design depends on Raydium's launch, curve and pool programs.

### FAQ structure

[The FAQ](https://backbid.fun/faq/) has 34 questions behind seven filter tabs:
Basics, Launching, Vault, Trading, OTC, Fees, and Safety. It also mentions
safety badges on tokens and a scam-report flow.

## Page layout and style

The homepage is a single dark-themed page, near-black, that runs top to bottom
in this order.

1. **Header:** logo, token search by name or mint address, links for Tokens,
   Vaults and OTC market, a "Launch a token" button, Help, and Sign in.
2. **Hero:** the headline "Launch a token with its own OTC Liquidity Vault", a
   short explainer, buttons to launch and to read how the vault works, and a
   link to the fee page.
3. **Stats bar:** tokens launched, graduated tokens, SOL in vaults, fees
   harvested, and 24-hour vault volume.
4. **Token list:** tabs for New, Trending, About to graduate, and Graduated,
   plus a link to the vault leaderboard.
5. **How it works:** four numbered steps (fees fill the vault, it opens at
   graduation, posted bid and ask, no withdraw key) with a flow diagram of
   traders, treasury, vault, and holders and buyers.
6. **OTC section:** a summary with links to the OTC market and the listing page.
7. **FAQ preview:** a handful of questions with a link to the full set of 34.
8. **Footer:** Product, Learn (including Security and Changelog), and Legal
   links (Terms, Privacy, Risk Disclosure), plus a non-custodial and
   not-financial-advice disclaimer.

## Notes for my own build

BackBid discloses two weaknesses that a new launchpad could improve on: the
program is unaudited, and a single wallet rather than a multisig holds the
upgrade authority.

The site also warns that the vault may be unable to buy and that prices are
formula-based, not guaranteed. A similar product needs the same kind of risk
disclosure.

Still not captured:

- [ ] Token detail and trading screen (the page timed out, then the site
  refused further loads)
- [ ] OTC market, buy requests and listing pages
- [ ] Token cards on the homepage list
- [ ] Changelog, Terms, Privacy and Risk Disclosure

## Sources

- [BackBid homepage](https://backbid.fun/), plus its launch, vaults,
  how-it-works, fees, security and FAQ pages
