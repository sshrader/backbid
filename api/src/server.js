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
const { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = require('@solana/web3.js')
const { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } = require('@solana/spl-token')
const B = require('./burnpad')
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
  CurveCalculator,
  FeeOn,
  toTransferFeeConfig,
} = require('@raydium-io/raydium-sdk-v2')

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const PROGRAM = DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM
const BURNPAD = new PublicKey(process.env.BURNPAD_PROGRAM_ID || '9maH9DVCxUd4bjfCNnANW673Xt2YMXaWwQr8UEqAi1ZL') // the fee-split and burn-vault program
const PLATFORM_FEE_RATE = 12500 // the platform's 1.25% trade fee, out of 1,000,000
const CPMM = DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM // Raydium's pool program, where tokens trade after graduation
const TOKEN_DECIMALS = 6
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const STORE = path.join(DATA_DIR, 'store.json')
const PORT = process.env.PORT || 3000

const connection = new Connection(RPC_URL, 'confirmed')

/* ---------- Store: token list, metadata and the saved platform ID ---------- */
let store = { tokens: {} }
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
  need(/^(\d+\.?\d*|\.\d+)$/.test(s), label + ' must be a positive number.') // accepts 1, 1., 1.5 and .5
  const [whole, frac = ''] = s.split('.')
  const bn = new BN((whole || '0') + frac.padEnd(decimals, '0').slice(0, decimals))
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

/* ---------- After graduation: the token's Raydium pool ---------- */
const WAITING = 'This token reached its target and Raydium is moving it to a pool. Try again in a few minutes.'

/** The pool's address is derived from the platform's pool config and the two mints. The mint order is not ours to choose, so try both. */
async function findCpmmPool(mint, platformInfo) {
  const known = store.tokens[mint.toBase58()]
  if (known && known.cpmmPool) return new PublicKey(known.cpmmPool)
  const seed = Buffer.from('pool', 'utf8')
  const candidates = [
    [mint, NATIVE_MINT],
    [NATIVE_MINT, mint],
  ].map(([a, b]) => PublicKey.findProgramAddressSync([seed, platformInfo.cpConfigId.toBuffer(), a.toBuffer(), b.toBuffer()], CPMM)[0])
  const accounts = await connection.getMultipleAccountsInfo(candidates)
  const i = accounts.findIndex((a) => a && a.owner.equals(CPMM))
  need(i >= 0, WAITING)
  if (known) {
    known.cpmmPool = candidates[i].toBase58()
    save()
  }
  return candidates[i]
}

/** Work out a pool swap with the pool program's own maths, as Raydium's swap example does. */
async function poolSwap(raydium, mint, platformInfo, inputIsSol, inputAmount) {
  const poolId = await findCpmmPool(mint, platformInfo)
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolId.toBase58())
  const baseIn = (inputIsSol ? NATIVE_MINT.toBase58() : mint.toBase58()) === poolInfo.mintA.address
  const swapResult = CurveCalculator.swapBaseInput(
    inputAmount,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate,
    rpcData.configInfo.creatorFeeRate,
    rpcData.configInfo.protocolFeeRate,
    rpcData.configInfo.fundFeeRate,
    rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
  )
  return { poolId, poolInfo, poolKeys, rpcData, baseIn, swapResult }
}
async function poolSwapTx(raydium, mint, platformInfo, inputIsSol, inputAmount) {
  const { poolInfo, poolKeys, baseIn, swapResult } = await poolSwap(raydium, mint, platformInfo, inputIsSol, inputAmount)
  const { transaction } = await raydium.cpmm.swap({ poolInfo, poolKeys, inputAmount, swapResult, slippage: 0.01, baseIn, txVersion: TxVersion.V0 })
  return transaction
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
  const { poolId, poolInfo, platformInfo } = await loadPool(raydium, new PublicKey(mintStr))
  let cpmm = null
  if (Number(poolInfo.status) === 2) {
    try {
      const id = await findCpmmPool(new PublicKey(mintStr), platformInfo)
      const { poolInfo: cp, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(id.toBase58())
      const tokenIsA = cp.mintA.address === mintStr
      const tokens = fromUnits(tokenIsA ? rpcData.baseReserve : rpcData.quoteReserve, TOKEN_DECIMALS)
      const sol = fromUnits(tokenIsA ? rpcData.quoteReserve : rpcData.baseReserve, 9)
      cpmm = { poolId: id.toBase58(), solReserve: sol, tokenReserve: tokens, price: tokens > 0 ? sol / tokens : null }
    } catch (e) {
      console.error('cpmm pool read:', e.message)
    }
  }
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
    status: Number(poolInfo.status), // 0 = trading on the curve, 1 = target reached and waiting to move, 2 = moved to a Raydium pool
    cpmm,
    raisedSol: fromUnits(poolInfo.realB, 9),
    targetSol: fromUnits(poolInfo.totalFundRaisingB, 9),
    soldTokens: fromUnits(poolInfo.realA, poolInfo.mintDecimalsA),
    curveTokens: fromUnits(poolInfo.totalSellA, poolInfo.mintDecimalsA),
    supply: fromUnits(poolInfo.supply, poolInfo.mintDecimalsA),
    creator: poolInfo.creator.toBase58(),
    price: cpmm && cpmm.price != null ? cpmm.price : price,
    platformId: poolInfo.platformId.toBase58(),
    burnpad: await burnpadInfo(mintStr).catch((e) => {
      console.error('burnpad info:', e.message)
      return null
    }),
  }
}

/** Raydium's devnet launch config for SOL-quoted curves. It holds the lowest graduation target the program accepts. */
async function launchConfig() {
  const configId = getPdaLaunchpadConfigId(PROGRAM, NATIVE_MINT, 0, 0).publicKey
  const account = await connection.getAccountInfo(configId)
  need(account, 'Raydium’s devnet launch config was not found.')
  return { configId, configInfo: LaunchpadConfig.decode(account.data) }
}


/* ---------- The burnpad program: transactions, vault and creator-stream info ---------- */
const lam = (x) => Number(x) / 1e9
const paramsJson = (p) => ({ discountPercent: p.discountBps / 100, maxSalePercent: p.maxSaleBps / 100, dailyPercent: p.dailyBps / 100, guardPercent: p.guardBps / 100, twapWindowMinutes: p.twapWindow / 60, reserveSol: lam(p.reserve) })

/** Build an unsigned v0 transaction from instructions. The wallet signs it. */
async function buildTx(payer, instructions, units = 400000) {
  const { blockhash } = await connection.getLatestBlockhash()
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions] }).compileToV0Message()
  return new VersionedTransaction(message)
}

/** Wrapped SOL account for the wallet, created if missing, and closed after so the payout lands as plain SOL. */
const wsolWrap = (owner) => createAssociatedTokenAccountIdempotentInstruction(owner, B.wsolAta(owner), owner, NATIVE_MINT)
const wsolUnwrap = (owner) => createCloseAccountInstruction(B.wsolAta(owner), owner, owner)

/** What the program knows about a token: its creator, burn vault and creator stream. Null for tokens launched before the program. */
async function burnpadInfo(mint) {
  const a = B.addresses(BURNPAD, new PublicKey(mint))
  const [l, v, st, vw, fv] = await connection.getMultipleAccountsInfo([a.launch, a.vault, a.stream, B.wsolAta(a.vault), a.feeVault])
  const launch = B.readLaunch(l && l.data)
  if (!launch) return null
  const vault = B.readVault(v && v.data)
  const stream = B.readStream(st && st.data)
  const now = Math.floor(Date.now() / 1000)
  let creatorStream = null
  if (stream) {
    const elapsed = stream.vestStart > 0 && now > stream.vestStart ? Math.min(now - stream.vestStart, B.THIRTY_DAYS) : 0
    const vested = (stream.totalReceived * BigInt(elapsed)) / BigInt(B.THIRTY_DAYS)
    creatorStream = { totalSol: lam(stream.totalReceived), claimedSol: lam(stream.claimed), claimableSol: lam(vested > stream.claimed ? vested - stream.claimed : 0n), vestStart: stream.vestStart || null }
  }
  return {
    creator: launch.creator.toBase58(),
    graduated: launch.graduatedAt > 0,
    expired: launch.expired,
    expiresAt: launch.launchedAt + B.THIRTY_DAYS,
    canExpire: launch.graduatedAt === 0 && !launch.expired && now >= launch.launchedAt + B.THIRTY_DAYS,
    harvestedSol: lam(launch.totalHarvested),
    pendingFeesSol: lam(B.tokenAmount(fv && fv.data)),
    vault: vault && { sol: lam(B.tokenAmount(vw && vw.data)), burnedTokens: Number(vault.tokensBurned) / 10 ** TOKEN_DECIMALS, paidSol: lam(vault.totalPaid), paused: vault.paused, ...paramsJson(vault.params) },
    creatorStream,
  }
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
    let minTargetSol = null
    let program = { initialized: false }
    try {
      const acc = await connection.getAccountInfo(B.configAddress(BURNPAD))
      const c = B.readConfig(acc && acc.data)
      if (c) program = { initialized: true, admin: c.admin.toBase58(), treasury: c.treasury.toBase58(), paused: c.paused, params: paramsJson(c.params) }
    } catch (e) {
      console.error('config:', e.message)
    }
    try {
      minTargetSol = fromUnits((await launchConfig()).configInfo.minFundRaisingB, 9)
    } catch (e) {
      /* optional */
    }
    res.json({ cluster: 'devnet', programId: PROGRAM.toBase58(), burnpadProgramId: BURNPAD.toBase58(), program, platformFeePercent: PLATFORM_FEE_RATE / 10000, minTargetSol, defaultTargetSol: 85 })
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
    if (Number(poolInfo.status) !== 0) {
      need(Number(poolInfo.status) === 2, WAITING)
      const selling = req.body.side === 'sell'
      const amount = parseUnits(req.body.amount, selling ? TOKEN_DECIMALS : 9, 'Amount')
      const { swapResult } = await poolSwap(raydium, mintA, platformInfo, !selling, amount)
      return res.json(selling ? { side: 'sell', sol: fromUnits(swapResult.outputAmount, 9) } : { side: 'buy', tokens: fromUnits(swapResult.outputAmount, TOKEN_DECIMALS) })
    }
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

/* A launch takes two transactions. The first registers the token with the program and creates its own LaunchLab platform.
   The second creates the curve on that platform, and the mint's keypair co-signs it, so the server holds that key between the two. */
const pendingLaunches = new Map() // mint -> { pair, owner, name, symbol, uri, firstBuy, target, at }
const PENDING_MS = 15 * 60 * 1000
function sweepPending() {
  for (const [m, p] of pendingLaunches) if (Date.now() - p.at > PENDING_MS) pendingLaunches.delete(m)
}

app.post(
  '/tx/launch',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const name = text(req.body.name, 32, 'Name', true)
    const symbol = text(req.body.symbol, 10, 'Ticker', true).toUpperCase()
    const description = text(req.body.description, 500, 'Description')
    const upload = req.body.imageData ? readImage(req.body.imageData) : null
    const website = httpUrl(req.body.website, 'Website')
    const firstBuy = req.body.firstBuySol ? parseUnits(req.body.firstBuySol, 9, 'First buy') : null
    const target = req.body.targetSol ? parseUnits(req.body.targetSol, 9, 'Graduation target') : null
    if (target) need(target.gte(new BN('1000000000')) && target.lte(new BN('85000000000')), 'The graduation target must be between 1 and 85 SOL.')

    const configAcc = await connection.getAccountInfo(B.configAddress(BURNPAD))
    const cfg = B.readConfig(configAcc && configAcc.data)
    need(cfg, 'The launch program is not set up yet. Open the Admin page and set it up first.')
    need(!cfg.paused, 'New launches are paused.')

    const pair = Keypair.generate()
    const mint = pair.publicKey
    const a = B.addresses(BURNPAD, mint)
    const cpConfigs = await (await fetch('https://api-v3-devnet.raydium.io/main/cpmm-config')).json()
    const cpConfig = (cpConfigs.data || []).slice().sort((x, y) => x.index - y.index)[0]
    need(cpConfig, 'Could not read Raydium’s devnet pool configs. Try again shortly.')

    let image = '', imageFile = null
    if (upload) {
      imageFile = mint.toBase58() + '.' + upload.ext
      fs.mkdirSync(IMAGES, { recursive: true })
      fs.writeFileSync(path.join(IMAGES, imageFile), upload.bytes)
      image = publicUrl(req) + '/images/' + imageFile
    }
    const atas = [a.authority, a.vault, a.stream, cfg.treasury].map((o) => createAssociatedTokenAccountIdempotentInstruction(owner, B.wsolAta(o), o, NATIVE_MINT))
    const create = B.ixCreateLaunch(BURNPAD, owner, mint, new PublicKey(cpConfig.id), { feeRate: PLATFORM_FEE_RATE, name, web: website || publicUrl(req), img: image })
    const tx = await buildTx(owner, [...atas, create], 600000)

    sweepPending()
    prune()
    pendingLaunches.set(mint.toBase58(), { pair, owner: owner.toBase58(), name, symbol, firstBuy, target, uri: publicUrl(req) + '/metadata/' + mint.toBase58() + '.json', at: Date.now() })
    store.tokens[mint.toBase58()] = { mint: mint.toBase58(), name, symbol, description, image, imageFile, website, creator: owner.toBase58(), createdAt: Date.now(), confirmed: false }
    save()
    res.json({ mint: mint.toBase58(), transactions: [toB64(tx)] })
  })
)

app.post(
  '/tx/launch-pool',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mint = pubkey(req.body.mint, 'Mint')
    const p = pendingLaunches.get(mint.toBase58())
    need(p && p.owner === owner.toBase58(), 'This launch expired. Start it again from the launch page.')
    const a = B.addresses(BURNPAD, mint)
    need(await connection.getAccountInfo(a.platform), 'The first launch step has not confirmed yet. Wait a few seconds and try again.')

    const raydium = await sdkFor(owner)
    const { configId, configInfo } = await launchConfig()
    const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB)
    const { transactions } = await raydium.launchpad.createLaunchpad({
      programId: PROGRAM,
      mintA: mint,
      decimals: TOKEN_DECIMALS,
      name: p.name,
      symbol: p.symbol,
      migrateType: 'cpmm',
      uri: p.uri,
      configId,
      configInfo,
      mintBDecimals: mintBInfo.decimals,
      mintBProgram: new PublicKey(mintBInfo.programId),
      platformId: a.platform,
      txVersion: TxVersion.V0,
      slippage: new BN(100), // 1%
      buyAmount: p.firstBuy || new BN(1),
      createOnly: !p.firstBuy,
      extraSigners: [p.pair],
      ...(p.target ? { totalFundRaisingB: p.target } : {}),
    })
    for (const tx of transactions) coSign(tx, p.pair)
    res.json({ mint: mint.toBase58(), transactions: transactions.map(toB64) })
  })
)

/* Anyone can move a token's trading fees into its vault, creator stream and the treasury. */
app.post(
  '/tx/harvest',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mint = pubkey(req.body.mint, 'Mint')
    const a = B.addresses(BURNPAD, mint)
    const [l, fv, cfgAcc] = await connection.getMultipleAccountsInfo([a.launch, a.feeVault, a.config])
    need(B.readLaunch(l && l.data), 'This token is not registered with the program.')
    need(B.tokenAmount(fv && fv.data) > 0n, 'There are no fees to harvest yet. They build up as people trade.')
    const cfg = B.readConfig(cfgAcc && cfgAcc.data)
    res.json({ transactions: [toB64(await buildTx(owner, [B.ixHarvest(BURNPAD, mint, cfg.treasury)]))] })
  })
)

/* Anyone can record that a token has moved to its Raydium pool. This opens the vault and starts the creator's vesting. */
app.post(
  '/tx/graduate',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mint = pubkey(req.body.mint, 'Mint')
    const raydium = await readSdk()
    const { poolInfo, platformInfo } = await loadPool(raydium, mint)
    need(Number(poolInfo.status) === 2, 'This token has not moved to its Raydium pool yet.')
    const a = B.addresses(BURNPAD, mint)
    const launch = B.readLaunch((await connection.getAccountInfo(a.launch))?.data)
    need(launch, 'This token is not registered with the program.')
    need(!launch.graduatedAt, 'This token is already marked as graduated.')
    need(!launch.expired, 'The creator stream for this token has expired.')
    const pool = B.cpmmPool(platformInfo.cpConfigId, mint)
    need(await connection.getAccountInfo(pool), 'Raydium has not created the pool yet. Try again in a minute.')
    res.json({ transactions: [toB64(await buildTx(owner, [B.ixMarkGraduated(BURNPAD, mint, pool)]))] })
  })
)

/* What the vault would pay for an amount of tokens, and whether it would accept the sale right now. */
const quoteJson = (q) => ({
  ok: q.ok,
  reason: q.reason,
  bidSol: lam(q.bidLamports || 0n),
  vaultSol: lam(q.vaultLamports || 0n),
  maxSaleSol: q.maxSaleLamports != null ? lam(q.maxSaleLamports) : null,
  pricePerTokenSol: q.pricePerTokenSol || null,
})
app.get(
  '/vault/:mint',
  route(async (req, res) => {
    const mint = pubkey(req.params.mint, 'Mint')
    const info = await burnpadInfo(mint.toBase58())
    need(info, 'This token has no burn vault.')
    const tokens = req.query.tokens ? BigInt(parseUnits(req.query.tokens, TOKEN_DECIMALS, 'Amount').toString()) : null
    res.json({ burnpad: info, quote: tokens ? quoteJson(await B.quoteSale(connection, BURNPAD, mint, tokens)) : null })
  })
)

app.post(
  '/tx/vault-sell',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mint = pubkey(req.body.mint, 'Mint')
    const tokens = BigInt(parseUnits(req.body.tokens, TOKEN_DECIMALS, 'Amount').toString())
    const q = await B.quoteSale(connection, BURNPAD, mint, tokens)
    need(q.ok, q.reason || 'The vault cannot take that sale right now.')
    const minOut = (q.bidLamports * 97n) / 100n // allow for a trade or two landing before this one
    const sell = B.ixSellToVault(BURNPAD, owner, mint, tokens, minOut, q.cpmm, q.poolParts)
    res.json({ transactions: [toB64(await buildTx(owner, [wsolWrap(owner), sell, wsolUnwrap(owner)], 500000))], bidSol: lam(q.bidLamports) })
  })
)

app.post(
  '/tx/claim-creator',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mint = pubkey(req.body.mint, 'Mint')
    const info = await burnpadInfo(mint.toBase58())
    need(info, 'This token is not registered with the program.')
    need(info.creator === owner.toBase58(), 'Only the token’s creator can claim.')
    need(info.graduated && !info.expired, 'The creator’s share unlocks when the token graduates.')
    need(info.creatorStream && info.creatorStream.claimableSol > 0, 'Nothing has vested yet. The share vests over 30 days from graduation.')
    res.json({ transactions: [toB64(await buildTx(owner, [wsolWrap(owner), B.ixClaimCreator(BURNPAD, owner, mint), wsolUnwrap(owner)]))] })
  })
)

/* Anyone can move the creator's share to the vault if the token has not graduated within 30 days. */
app.post(
  '/tx/expire',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    const mint = pubkey(req.body.mint, 'Mint')
    const info = await burnpadInfo(mint.toBase58())
    need(info && info.canExpire, 'This token is not past its 30-day deadline, or has already graduated.')
    res.json({ transactions: [toB64(await buildTx(owner, [B.ixExpireCreator(BURNPAD, mint)]))] })
  })
)

/* One-time setup of the program. The wallet that signs becomes the admin, and its address the treasury. */
app.post(
  '/tx/init-config',
  route(async (req, res) => {
    const owner = pubkey(req.body.owner, 'Owner')
    need(!(await connection.getAccountInfo(B.configAddress(BURNPAD))), 'The program is already set up.')
    res.json({ transactions: [toB64(await buildTx(owner, [B.ixInitializeConfig(BURNPAD, owner, owner)]))] })
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
    if (Number(poolInfo.status) !== 0) {
      need(Number(poolInfo.status) === 2, WAITING)
      return res.json({ transactions: [toB64(await poolSwapTx(raydium, mintA, platformInfo, true, buyAmount))] })
    }
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
    if (Number(poolInfo.status) !== 0) {
      need(Number(poolInfo.status) === 2, WAITING)
      return res.json({ transactions: [toB64(await poolSwapTx(raydium, mintA, platformInfo, false, sellAmount))] })
    }
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
    res.json({ signatures })
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
    app.listen(PORT, () => console.log('Devnet API listening on port ' + PORT + ', burnpad program ' + BURNPAD.toBase58()))
  })
  .catch((e) => {
    console.error('Could not reach the RPC at RPC_URL:', e.message)
    process.exit(1)
  })
