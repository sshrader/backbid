/*
 * Devnet-only API. It builds Raydium LaunchLab transactions and returns them unsigned,
 * so the user's wallet signs every one. It never holds a user's key. The only key it
 * ever creates is the one-time mint keypair for a new token, which it uses to co-sign
 * the launch and then drops.
 *
 * Call shapes follow Raydium's own examples (raydium-io/raydium-sdk-V2-demo, src/launchpad).
 */
const fs = require('fs')
const path = require('path')
const express = require('express')
const cors = require('cors')
const BN = require('bn.js')
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js')
const { NATIVE_MINT } = require('@solana/spl-token')
const {
  Raydium,
  TxVersion,
  DEV_API_URLS,
  DEVNET_PROGRAM_ID,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadPoolId,
  LaunchpadConfig,
  PlatformConfig,
  Curve,
  toTransferFeeConfig,
} = require('@raydium-io/raydium-sdk-v2')

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const PROGRAM = DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM
const TOKEN_DECIMALS = 6
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const STORE = path.join(DATA_DIR, 'store.json')
const PORT = process.env.PORT || 3000

const connection = new Connection(RPC_URL, 'confirmed')

/* ---------- Store: token list, metadata and the saved platform ID ---------- */
let store = { platformId: null, tokens: {} }
try {
  store = { ...store, ...JSON.parse(fs.readFileSync(STORE, 'utf8')) }
} catch (e) {
  /* first run */
}
const IMAGES = path.join(DATA_DIR, 'images')
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  // Write to a temporary file first so a crash mid-write cannot corrupt the store.
  fs.writeFileSync(STORE + '.tmp', JSON.stringify(store, null, 2))
  fs.renameSync(STORE + '.tmp', STORE)
}
/** Drop launches that were built but never signed, along with any image saved for them. */
function prune() {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const t of Object.values(store.tokens)) {
    if (t.confirmed || t.createdAt > cutoff) continue
    if (t.imageFile) fs.rmSync(path.join(IMAGES, t.imageFile), { force: true })
    delete store.tokens[t.mint]
  }
}

const IMAGE_TYPES = [
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
]
/** Decode an uploaded image and check its real type from its first bytes, not from what the browser claims. */
function readImage(dataUrl) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl))
  need(m, 'The image could not be read. Use a PNG, JPG, WebP or GIF file.')
  const bytes = Buffer.from(m[1], 'base64')
  need(bytes.length <= 2 * 1024 * 1024, 'The image is larger than 2 MB. Choose a smaller file.')
  const type = IMAGE_TYPES.find((t) => t.test(bytes))
  need(type, 'That file is not a PNG, JPG, WebP or GIF image.')
  return { bytes, ext: type.ext }
}
const platformId = () => process.env.PLATFORM_ID || store.platformId || null

/* ---------- Helpers ---------- */
class Bad extends Error {}
const need = (cond, msg) => {
  if (!cond) throw new Bad(msg)
}
function pubkey(value, label) {
  try {
    return new PublicKey(String(value))
  } catch (e) {
    throw new Bad(label + ' is not a valid Solana address.')
  }
}
/** "1.5" with 9 decimals -> BN(1500000000). Works on strings so no precision is lost. */
function parseUnits(value, decimals, label) {
  const s = String(value == null ? '' : value).trim()
  need(/^\d+(\.\d+)?$/.test(s), label + ' must be a positive number.')
  const [whole, frac = ''] = s.split('.')
  const bn = new BN(whole + frac.padEnd(decimals, '0').slice(0, decimals))
  need(bn.gtn(0), label + ' must be more than zero.')
  return bn
}
const fromUnits = (bn, decimals) => Number(bn.toString()) / 10 ** decimals
const toB64 = (tx) => Buffer.from(tx.serialize()).toString('base64')

/** Sign with `keypair` only if the transaction lists it as a required signer. */
function coSign(tx, keypair) {
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures)
  if (signers.some((k) => k.equals(keypair.publicKey))) tx.sign([keypair])
}

/** A fresh SDK instance per request, so one user's cached accounts never leak into another's. */
function sdkFor(owner) {
  return Raydium.load({
    owner,
    connection,
    cluster: 'devnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'finalized',
    urlConfigs: {
      ...DEV_API_URLS,
      BASE_HOST: 'https://api-v3-devnet.raydium.io',
      OWNER_BASE_HOST: 'https://owner-v1-devnet.raydium.io',
      SWAP_HOST: 'https://transaction-v1-devnet.raydium.io',
      CPMM_LOCK: 'https://dynamic-ipfs-devnet.raydium.io/lock/cpmm/position',
    },
  })
}
let reader
const readSdk = async () => (reader = reader || (await sdkFor(undefined)))

async function loadPool(raydium, mint) {
  const poolId = getPdaLaunchpadPoolId(PROGRAM, mint, NATIVE_MINT).publicKey
  const poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId })
  const account = await connection.getAccountInfo(poolInfo.platformId)
  need(account, 'This token’s platform account was not found on devnet.')
  return { poolId, poolInfo, platformInfo: PlatformConfig.decode(account.data) }
}

const poolCache = new Map() // mint -> { at, data }; a few seconds, so a busy list page does not hammer the RPC
async function describe(mintStr) {
  const hit = poolCache.get(mintStr)
  if (hit && Date.now() - hit.at < 4000) return hit.data
  const data = await describeFresh(mintStr)
  poolCache.set(mintStr, { at: Date.now(), data })
  return data
}
async function describeFresh(mintStr) {
  const raydium = await readSdk()
  const { poolId, poolInfo } = await loadPool(raydium, new PublicKey(mintStr))
  let price = null
  try {
    price = Curve.getPrice({
      poolInfo,
      curveType: poolInfo.configInfo.curveType,
      decimalA: poolInfo.mintDecimalsA,
      decimalB: poolInfo.mintDecimalsB,
    }).toNumber()
  } catch (e) {
    /* price is optional */
  }
  return {
    poolId: poolId.toBase58(),
    status: Number(poolInfo.status), // 0 = trading on the curve; anything else = migrating or migrated
    raisedSol: fromUnits(poolInfo.realB, 9),
    targetSol: fromUnits(poolInfo.totalFundRaisingB, 9),
    soldTokens: fromUnits(poolInfo.realA, poolInfo.mintDecimalsA),
    curveTokens: fromUnits(poolInfo.totalSellA, poolInfo.mintDecimalsA),
    supply: fromUnits(poolInfo.supply, poolInfo.mintDecimalsA),
    creator: poolInfo.creator.toBase58(),
    price,
    platformId: poolInfo.platformId.toBase58(),
  }
}

/** The platform's fee rate and the SOL sitting in its fee vault. Trading fees go straight to this vault. */
async function platformStatus() {
  const id = platformId()
  if (!id) return null
  const key = new PublicKey(id)
  const out = { feePercent: null, claimableSol: 0 }
  const account = await connection.getAccountInfo(key)
  if (account) out.feePercent = Number(PlatformConfig.decode(account.data).feeRate.toString()) / 10000
  const vault = PublicKey.findProgramAddressSync([key.toBuffer(), NATIVE_MINT.toBuffer()], PROGRAM)[0]
  try {
    out.claimableSol = Number((await connection.getTokenAccountBalance(vault)).value.uiAmountString)
  } catch (e) {
    /* the vault account does not exist until the first fee arrives */
  }
  return out
}

const publicUrl = (req) => (process.env.PUBLIC_URL || req.protocol + '://' + req.get('host')).replace(/\/$/, '')
const text = (value, max, label, required) => {
  const s = String(value == null ? '' : value).trim()
  need(!required || s, label + ' is required.')
  need(s.length <= max, label + ' must be ' + max + ' characters or fewer.')
  return s
}
const httpUrl = (value, label) => {
  const s = text(value, 300, label)
  need(!s || /^https:\/\//i.test(s), label + ' must start with https://')
  return s
}

/* ---------- App ---------- */
const app = express()
app.set('trust proxy', true)
app.use(cors({ origin: process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*' ? process.env.CORS_ORIGIN.split(',') : true }))
app.use(express.json({ limit: '4mb' })) // room for a 2 MB image sent as base64
const route = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    if (!(e instanceof Bad)) console.error(e)
    res.status(e instanceof Bad ? 400 : 500).json({ error: e instanceof Bad ? e.message : 'Server error: ' + (e.message || String(e)) })
  })

app.get('/health', (req, res) => res.json({ ok: true }))

app.get(
  '/config',
  route(async (req, res) => {
    let platform = null
    try {
      platform = await platformStatus()
    } catch (e) {
      console.error('platform status:', e.message)
    }
    res.json({ cluster: 'devnet', programId: PROGRAM.toBase58(), platformId: platformId(), platformFromEnv: Boolean(process.env.PLATFORM_ID), platform })
  })
)

/* Token metadata, served at the URI written into each token. */
app.get('/metadata/:file', (req, res) => {
  const t = store.tokens[req.params.file.replace(/\.json$/, '')]
  if (!t) return res.status(404).json({ error: 'Unknown token.' })
  res.json({ name: t.name, symbol: t.symbol, description: t.description, image: t.image, external_url: t.website || undefined })
})

/* Uploaded token images. Only names this server generated are served. */
app.get('/images/:file', (req, res) => {
  const m = /^[1-9A-HJ-NP-Za-km-z]{32,44}\.(png|jpg|gif|webp)$/.exec(req.params.file)
  const type = m && IMAGE_TYPES.find((t) => t.ext === m[1])
  const file = path.join(IMAGES, req.params.file)
  if (!type || !fs.existsSync(file)) return res.status(404).json({ error: 'Unknown image.' })
  res.set({ 'Content-Type': type.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=86400' })
  fs.createReadStream(file).pipe(res)
})

app.get(
  '/tokens',
  route(async (req, res) => {
    const list = Object.values(store.tokens)
      .filter((t) => t.confirmed)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
    const rows = await Promise.all(
      list.map(async (t) => {
        try {
          return { ...t, pool: await describe(t.mint) }
        } catch (e) {
          return { ...t, pool: null, poolError: e.message }
        }
      })
    )
    res.json({ tokens: rows })
  })
)

app.get(
  '/tokens/:mint',
  route(async (req, res) => {
    const mint = pubkey(req.params.mint, 'Mint').toBase58()
    res.json({ ...(store.tokens[mint] || { mint }), pool: await describe(mint) })
  })
)

app.get(
  '/balance',
  route(async (req, res) => {
    const owner = pubkey(req.query.owner, 'Owner')
    const out = { sol: (await connection.getBalance(owner)) / 1e9, tokens: null }
    if (req.query.mint) {
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: pubkey(req.query.mint, 'Mint') })
      out.tokens = accounts.value.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmountString), 0)
    }
    res.json(out)
  })
)

/* Price quote for a curve trade, using the same curve maths the program runs. */
app.post(
  '/quote',
  route(async (req, res) => {
    const mintA = pubkey(req.body.mint, 'Mint')
    const raydium = await readSdk()
    const { poolInfo, platformInfo } = await loadPool(raydium, mintA)
    need(Number(poolInfo.status) === 0, 'This token has left the bonding curve.')
    const common = {
      poolInfo,
      protocolFeeRate: poolInfo.configInfo.tradeFeeRate,
      platformFeeRate: platformInfo.feeRate,
      curveType: poolInfo.configInfo.curveType,
      shareFeeRate: new BN(0),
      creatorFeeRate: platformInfo.creatorFeeRate,
      transferFeeConfigA: undefined,
      transferFeeConfigB: undefined,
      slot: await connection.getSlot(),
    }
    if (req.body.side === 'sell') {
      const r = Curve.sellExactIn({ ...common, amountA: parseUnits(req.body.amount, TOKEN_DECIMALS, 'Amount') })
      return res.json({ side: 'sell', sol: fromUnits(r.amountB, 9) })
    }
    const r = Curve.buyExactIn({ ...common, amountB: parseUnits(req.body.amount, 9, 'Amount') })
    res.json({ side: 'buy', tokens: fromUnits(r.amountA.amount.sub(r.amountA.fee || new BN(0)), TOKEN_DECIMALS) })
  })
)

/* Register a LaunchLab platform. One per wallet. The wallet that signs becomes its admin and fee wallet. */
app.post(
  '/tx/create-platform',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const name = text(req.body.name, 60, 'Platform name', true)
    const web = httpUrl(req.body.web, 'Website')
    const feePercent = Number(req.body.feePercent)
    need(feePercent >= 0 && feePercent <= 5, 'Platform fee must be between 0 and 5 percent.')

    const configs = await (await fetch('https://api-v3-devnet.raydium.io/main/cpmm-config')).json()
    const cpConfig = (configs.data || []).slice().sort((a, b) => a.index - b.index)[0]
    need(cpConfig, 'Could not read Raydium’s devnet pool configs. Try again shortly.')

    const raydium = await sdkFor(owner)
    const { transaction, extInfo } = await raydium.launchpad.createPlatformConfig({
      programId: PROGRAM,
      platformAdmin: owner,
      platformClaimFeeWallet: owner,
      platformLockNftWallet: owner,
      platformVestingWallet: owner,
      cpConfigId: new PublicKey(cpConfig.id),
      transferFeeExtensionAuth: owner,
      creatorFeeRate: new BN(0),
      // All pool liquidity is locked at graduation and the platform holds the fee rights.
      migrateCpLockNftScale: { platformScale: new BN(1000000), creatorScale: new BN(0), burnScale: new BN(0) },
      feeRate: new BN(Math.round(feePercent * 10000)), // out of 1,000,000
      name,
      web: web || 'https://example.com',
      img: web || 'https://example.com',
      txVersion: TxVersion.V0,
    })
    res.json({ transactions: [toB64(transaction)], platformId: extInfo.platformId.toBase58() })
  })
)

app.post(
  '/tx/launch',
  route(async (req, res) => {
    const platform = platformId()
    need(platform, 'Register your platform first, then launch.')
    const owner = pubkey(req.body.owner, 'Owner')
    const name = text(req.body.name, 32, 'Name', true)
    const symbol = text(req.body.symbol, 10, 'Ticker', true).toUpperCase()
    const description = text(req.body.description, 500, 'Description')
    const upload = req.body.imageData ? readImage(req.body.imageData) : null
    const website = httpUrl(req.body.website, 'Website')
    const firstBuy = req.body.firstBuySol ? parseUnits(req.body.firstBuySol, 9, 'First buy') : null

    const pair = Keypair.generate()
    const mint = pair.publicKey.toBase58()
    const raydium = await sdkFor(owner)
    const configId = getPdaLaunchpadConfigId(PROGRAM, NATIVE_MINT, 0, 0).publicKey
    const configAccount = await connection.getAccountInfo(configId)
    need(configAccount, 'Raydium’s devnet launch config was not found.')
    const configInfo = LaunchpadConfig.decode(configAccount.data)
    const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB)

    const { transactions } = await raydium.launchpad.createLaunchpad({
      programId: PROGRAM,
      mintA: pair.publicKey,
      decimals: TOKEN_DECIMALS,
      name,
      symbol,
      migrateType: 'cpmm',
      uri: publicUrl(req) + '/metadata/' + mint + '.json',
      configId,
      configInfo,
      mintBDecimals: mintBInfo.decimals,
      mintBProgram: new PublicKey(mintBInfo.programId),
      platformId: new PublicKey(platform),
      txVersion: TxVersion.V0,
      slippage: new BN(100), // 1%
      buyAmount: firstBuy || new BN(1),
      createOnly: !firstBuy,
      extraSigners: [pair],
    })
    for (const tx of transactions) coSign(tx, pair)

    let image = '', imageFile = null
    if (upload) {
      imageFile = mint + '.' + upload.ext
      fs.mkdirSync(IMAGES, { recursive: true })
      fs.writeFileSync(path.join(IMAGES, imageFile), upload.bytes)
      image = publicUrl(req) + '/images/' + imageFile
    }
    prune()
    store.tokens[mint] = { mint, name, symbol, description, image, imageFile, website, creator: owner.toBase58(), createdAt: Date.now(), confirmed: false }
    save()
    res.json({ mint, transactions: transactions.map(toB64) })
  })
)

app.post(
  '/tx/buy',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mintA = pubkey(req.body.mint, 'Mint')
    const buyAmount = parseUnits(req.body.sol, 9, 'Amount')
    const raydium = await sdkFor(owner)
    const { poolInfo, platformInfo } = await loadPool(raydium, mintA)
    need(Number(poolInfo.status) === 0, 'This token has left the bonding curve. It now trades on its Raydium pool.')
    const mintInfo = await raydium.token.getTokenInfo(mintA)
    const mintBInfo = await raydium.token.getTokenInfo(poolInfo.mintB)
    const epoch = (await connection.getEpochInfo()).epoch

    const { transaction, extInfo } = await raydium.launchpad.buyToken({
      programId: PROGRAM,
      mintA,
      mintAProgram: new PublicKey(mintInfo.programId),
      poolInfo,
      mintB: poolInfo.mintB,
      mintBProgram: new PublicKey(mintBInfo.programId),
      transferFeeConfigB: mintBInfo.extensions && mintBInfo.extensions.feeConfig ? toTransferFeeConfig(mintBInfo, epoch) : undefined,
      slippage: new BN(100),
      configInfo: poolInfo.configInfo,
      platformFeeRate: platformInfo.feeRate,
      txVersion: TxVersion.V0,
      buyAmount,
    })
    res.json({ transactions: [toB64(transaction)], expectedTokens: extInfo && extInfo.decimalOutAmount ? extInfo.decimalOutAmount.toString() : null })
  })
)

app.post(
  '/tx/sell',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mintA = pubkey(req.body.mint, 'Mint')
    const sellAmount = parseUnits(req.body.tokens, TOKEN_DECIMALS, 'Amount')
    const raydium = await sdkFor(owner)
    const { poolInfo, platformInfo } = await loadPool(raydium, mintA)
    need(Number(poolInfo.status) === 0, 'This token has left the bonding curve. It now trades on its Raydium pool.')
    const mintInfo = await raydium.token.getTokenInfo(mintA)
    const mintBInfo = await raydium.token.getTokenInfo(poolInfo.mintB)
    const epoch = (await connection.getEpochInfo()).epoch

    const { transaction } = await raydium.launchpad.sellToken({
      programId: PROGRAM,
      mintA,
      mintAProgram: new PublicKey(mintInfo.programId),
      mintB: poolInfo.mintB,
      mintBProgram: new PublicKey(mintBInfo.programId),
      transferFeeConfigB: mintBInfo.extensions && mintBInfo.extensions.feeConfig ? toTransferFeeConfig(mintBInfo, epoch) : undefined,
      poolInfo,
      configInfo: poolInfo.configInfo,
      platformFeeRate: platformInfo.feeRate,
      txVersion: TxVersion.V0,
      sellAmount,
    })
    res.json({ transactions: [toB64(transaction)] })
  })
)

/* Collect the platform's fees. Only the platform's fee wallet can sign this. */
app.post(
  '/tx/claim-fees',
  route(async (req, res) => {
    const platform = platformId()
    need(platform, 'No platform is registered yet.')
    const owner = pubkey(req.body.owner, 'Owner')
    const status = await platformStatus()
    need(status.claimableSol > 0, 'There are no platform fees to claim yet. Fees build up as people buy and sell.')
    const raydium = await sdkFor(owner)
    const { transaction } = await raydium.launchpad.claimVaultPlatformFee({
      programId: PROGRAM,
      platformId: new PublicKey(platform),
      claimFeeWallet: owner,
      mintB: NATIVE_MINT,
      txVersion: TxVersion.V0,
    })
    res.json({ transactions: [toB64(transaction)] })
  })
)

/* Relay wallet-signed transactions to devnet, in order, and wait for each to confirm. */
app.post(
  '/tx/send',
  route(async (req, res) => {
    const list = req.body.transactions
    need(Array.isArray(list) && list.length > 0 && list.length <= 4, 'Send between one and four signed transactions.')
    const signatures = []
    for (const b64 of list) {
      const raw = Buffer.from(String(b64), 'base64')
      VersionedTransaction.deserialize(raw) // throws if it is not a transaction
      let signature
      try {
        signature = await connection.sendRawTransaction(raw, { maxRetries: 3 })
      } catch (e) {
        throw new Bad('Devnet rejected the transaction: ' + (e.message || e))
      }
      const latest = await connection.getLatestBlockhash()
      const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
      need(!result.value.err, 'Transaction ' + signature + ' failed on-chain: ' + JSON.stringify(result.value.err))
      signatures.push(signature)
    }

    poolCache.clear()
    // Bookkeeping, each checked against the chain and never taken on the caller's word.
    const mint = req.body.mint && store.tokens[req.body.mint]
    if (mint && !mint.confirmed) {
      await describe(mint.mint) // throws if the pool does not exist
      mint.confirmed = true
      save()
    }
    if (req.body.platformId && !platformId()) {
      const id = pubkey(req.body.platformId, 'Platform ID')
      const account = await connection.getAccountInfo(id)
      if (account && account.owner.equals(PROGRAM)) {
        PlatformConfig.decode(account.data)
        store.platformId = id.toBase58()
        save()
      }
    }
    res.json({ signatures, platformId: platformId() })
  })
)

/* Refuse to run against anything but devnet. */
connection
  .getGenesisHash()
  .then((hash) => {
    if (hash !== DEVNET_GENESIS) {
      console.error('RPC_URL does not point at Solana devnet. This server is devnet-only and will not start.')
      process.exit(1)
    }
    app.listen(PORT, () => console.log('Devnet API listening on port ' + PORT + ', platform ' + (platformId() || 'not registered yet')))
  })
  .catch((e) => {
    console.error('Could not reach the RPC at RPC_URL:', e.message)
    process.exit(1)
  })
