# Devnet setup

How to get real launches working on Solana devnet through Raydium LaunchLab.
Devnet is Solana's free test network: the SOL and tokens there have no value.

This is stage 1. It gives you a registered LaunchLab platform, real token
launches, and buying and selling on the bonding curve. It does not include the
burn vault or the creator stream; those need the on-chain program in
`program-spec.md`.

## What was added

| Path | What it is |
| --- | --- |
| `api/` | A small Node server. It builds Raydium transactions and returns them unsigned for the wallet to sign. It refuses to start unless its RPC is devnet |
| `web/app.html` | A page that connects a wallet and talks to the API: register a platform, launch, buy, sell, claim fees |
| `web/config.js` | Where the API's address is set for the page |

The simulated prototype (`web/index.html`) is unchanged.

## Status: written, not yet run

The code follows Raydium's own example scripts and was checked against the SDK
source, and the page was tested against a stand-in API. It has not been run
against devnet, because the workspace it was written in cannot install
packages. Expect to fix a thing or two on the first real run.

## Steps

### 1. Wallet

1. Install a Solana wallet such as Phantom.
2. Switch it to devnet. In Phantom: Settings, Developer Settings, Testnet Mode.
3. Get free devnet SOL from https://faucet.solana.com. About 2 SOL is plenty.

Use a fresh wallet for testing, not one that holds real funds.

### 2. Deploy the API on Railway

1. In the same Railway project, add a new service from this GitHub repo.
2. In that service's Settings, set Root Directory to `api`.
3. In its Variables tab, add:
   - `RPC_URL` = `https://api.devnet.solana.com` (or a devnet URL from an RPC
     provider, which is more reliable)
   - `CORS_ORIGIN` = `*` for now
4. Under Networking, generate a public domain. That address is your API address.
5. Open `<API address>/health`. It should show `{"ok":true}`.

### 3. Point the page at the API

Open `<your site>/app.html` and paste the API address into step 1 on the page.
The page remembers it in your browser. To set it for everyone, put the address
in `web/config.js`.

### 4. Register your platform

On the page, connect your wallet, fill in the platform form and approve the
transaction. The page then shows your platform ID.

Copy that ID into the API service's Variables as `PLATFORM_ID`. Until you do,
the ID is kept in a file on the server and is lost on the next deploy.

A wallet can register only one platform, and the registering wallet receives
the platform's fees.

### 5. Launch and trade

Launch a token from the page, then buy and sell it. Each action shows a link to
the transaction on Solana Explorer.

## Known limits

- **Token list, metadata and images are kept in files.** Attach a Railway
  volume to the API service (mount path `/data`) and set `DATA_DIR=/data`, or
  they are lost on every redeploy. The tokens themselves stay on devnet either
  way.
- **Set `PUBLIC_URL`** on the API service to its own address. Token metadata
  and image links are built from it and are written into each token for good.
- **Trading stops at graduation.** Once a token moves to its Raydium pool, this
  page cannot trade it. Pool trading comes later.
- **The platform fee may be capped.** Raydium added a cap on platform fee rates
  in August 2026. If registering at 1.25% fails, try 1%.
- **No sign-in or rate limiting.** Fine for devnet, not for mainnet.

## If something fails

Copy the error from the page, and the API service's logs from Railway, and
bring both back. The most likely first-run problems are a Raydium SDK version
difference or a devnet config that is not where the code expects it.

## Not for mainnet

Do not point this at mainnet. Before real money is involved the project needs
the audit, the multisig and the legal review listed in the README.
