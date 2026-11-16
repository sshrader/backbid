/*
 * Client for the burnpad program: addresses, instruction builders, account readers and the vault price quote.
 * Mirrors programs/burnpad/src (processor.rs, state.rs, math.rs). Keep the two in step.
 */
const { PublicKey, SystemProgram, TransactionInstruction } = require('@solana/web3.js')
const { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token')
const { DEVNET_PROGRAM_ID, getPdaPlatformId, getPdaPlatformVault, getPdaPlatformFeeVaultAuth } = require('@raydium-io/raydium-sdk-v2')

const LAUNCHLAB = DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM
const CPMM = DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM
const seed = (s) => Buffer.from(s, 'utf8')
const wsolAta = (owner) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, true)
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })

function configAddress(programId) {
  return PublicKey.findProgramAddressSync([seed('config')], programId)[0]
}

function addresses(programId, mint) {
  const pda = (...parts) => PublicKey.findProgramAddressSync(parts, programId)[0]
  const authority = pda(seed('authority'), mint.toBuffer())
  const platform = getPdaPlatformId(LAUNCHLAB, authority).publicKey
  return {
    config: configAddress(programId),
    launch: pda(seed('launch'), mint.toBuffer()),
    stream: pda(seed('stream'), mint.toBuffer()),
    vault: pda(seed('vault'), mint.toBuffer()),
    authority,
    platform,
    feeAuth: getPdaPlatformFeeVaultAuth(LAUNCHLAB).publicKey,
    feeVault: getPdaPlatformVault(LAUNCHLAB, platform, NATIVE_MINT).publicKey,
    launchlabPool: PublicKey.findProgramAddressSync([seed('pool'), mint.toBuffer(), NATIVE_MINT.toBuffer()], LAUNCHLAB)[0],
  }
}

/** Raydium's pool for a token against wrapped SOL. The two mints are ordered by address. */
function cpmmPool(cpConfigId, mint) {
  const [x, y] = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0 ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint]
  return PublicKey.findProgramAddressSync([seed('pool'), cpConfigId.toBuffer(), x.toBuffer(), y.toBuffer()], CPMM)[0]
}

/* ---------- Instruction builders ---------- */
const str = (s) => {
  const b = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(b.length)
  return Buffer.concat([len, b])
}
const u64 = (n) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

function ixInitializeConfig(programId, admin, treasury) {
  return new TransactionInstruction({ programId, keys: [meta(admin, true, true), meta(configAddress(programId), true), meta(treasury), meta(SystemProgram.programId)], data: Buffer.from([0]) })
}

function ixCreateLaunch(programId, creator, mint, cpConfigId, { feeRate, name, web, img }) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({
    programId,
    keys: [meta(creator, true, true), meta(a.config), meta(mint), meta(a.launch, true), meta(a.stream, true), meta(a.vault, true), meta(a.authority, true), meta(a.platform, true), meta(cpConfigId, true), meta(SystemProgram.programId), meta(LAUNCHLAB)],
    data: Buffer.concat([Buffer.from([1]), u64(feeRate), str(name), str(web), str(img)]),
  })
}

function ixHarvest(programId, mint, treasury) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({
    programId,
    keys: [meta(a.launch, true), meta(a.stream, true), meta(a.config), meta(a.authority, true), meta(a.platform), meta(a.feeAuth), meta(a.feeVault, true), meta(wsolAta(a.authority), true), meta(NATIVE_MINT), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(LAUNCHLAB), meta(wsolAta(a.vault), true), meta(wsolAta(a.stream), true), meta(wsolAta(treasury), true)],
    data: Buffer.from([2]),
  })
}

function ixMarkGraduated(programId, mint, cpmm) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({ programId, keys: [meta(a.launch, true), meta(a.stream, true), meta(a.launchlabPool), meta(a.platform), meta(cpmm)], data: Buffer.from([3]) })
}

function ixClaimCreator(programId, creator, mint) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({ programId, keys: [meta(creator, false, true), meta(a.launch), meta(a.stream, true), meta(wsolAta(a.stream), true), meta(wsolAta(creator), true), meta(TOKEN_PROGRAM_ID)], data: Buffer.from([4]) })
}

function ixExpireCreator(programId, mint) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({ programId, keys: [meta(a.launch, true), meta(a.stream), meta(wsolAta(a.stream), true), meta(wsolAta(a.vault), true), meta(TOKEN_PROGRAM_ID)], data: Buffer.from([5]) })
}

function ixSellToVault(programId, holder, mint, tokens, minOut, cpmm, parts) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({
    programId,
    keys: [meta(holder, true, true), meta(a.launch), meta(a.vault, true), meta(a.config), meta(cpmm), meta(parts.vaultA), meta(parts.vaultB), meta(parts.observation), meta(mint, true), meta(getAssociatedTokenAddressSync(mint, holder), true), meta(wsolAta(holder), true), meta(wsolAta(a.vault), true), meta(TOKEN_PROGRAM_ID)],
    data: Buffer.concat([Buffer.from([8]), u64(tokens), u64(minOut)]),
  })
}

/* ---------- Account readers (offsets match state.rs) ---------- */
const key = (b, at) => new PublicKey(b.subarray(at, at + 32))
const i64 = (b, at) => Number(b.readBigInt64LE(at))
const u64n = (b, at) => b.readBigUInt64LE(at)

function readConfig(d) {
  if (!d || d.length < 87 || d[0] !== 1) return null
  return {
    admin: key(d, 2),
    treasury: key(d, 34),
    paused: d[66] !== 0,
    params: { discountBps: d.readUInt16LE(67), maxSaleBps: d.readUInt16LE(69), dailyBps: d.readUInt16LE(71), guardBps: d.readUInt16LE(73), twapWindow: d.readUInt32LE(75), reserve: u64n(d, 79) },
  }
}
function readLaunch(d) {
  if (!d || d.length < 193 || d[0] !== 2) return null
  return {
    mint: key(d, 2),
    creator: key(d, 34),
    launchedAt: i64(d, 66),
    graduatedAt: i64(d, 74),
    pool: key(d, 82),
    platform: key(d, 114),
    expired: d[152] !== 0,
    totalHarvested: u64n(d, 153),
    cpmmPool: key(d, 161),
  }
}
function readStream(d) {
  if (!d || d.length < 26 || d[0] !== 3) return null
  return { totalReceived: u64n(d, 2), claimed: u64n(d, 10), vestStart: i64(d, 18) }
}
function readVault(d) {
  if (!d || d.length < 128 || d[0] !== 4) return null
  return {
    params: { discountBps: d.readUInt16LE(2), maxSaleBps: d.readUInt16LE(4), dailyBps: d.readUInt16LE(6), guardBps: d.readUInt16LE(8), twapWindow: d.readUInt32LE(10), reserve: u64n(d, 14) },
    windowStart: i64(d, 22),
    windowStartBalance: u64n(d, 30),
    windowSpent: u64n(d, 38),
    tokensBurned: u64n(d, 46),
    totalPaid: u64n(d, 54),
    paused: d[62] !== 0,
  }
}
function readPool(d) {
  if (!d || d.length < 413) return null
  return {
    vaultA: key(d, 72),
    vaultB: key(d, 104),
    mintA: key(d, 168),
    mintB: key(d, 200),
    observation: key(d, 296),
    feesA: u64n(d, 341) + u64n(d, 357) + u64n(d, 397),
    feesB: u64n(d, 349) + u64n(d, 365) + u64n(d, 405),
  }
}
const tokenAmount = (d) => (d && d.length >= 72 ? u64n(d, 64) : 0n)

/* ---------- Vault maths (mirrors math.rs) ---------- */
const BPS = 10000n
const THIRTY_DAYS = 30 * 24 * 60 * 60
const DAY = 24 * 60 * 60

function twapX32(samples, now, window, spot) {
  const live = samples.filter((o) => o.ts > 0)
  if (!live.length) return null
  const newest = live.reduce((a, b) => (b.ts > a.ts ? b : a))
  const cutoff = now - window
  const old = live.filter((o) => o.ts <= cutoff)
  if (newest.ts > now || !old.length) return null
  const then = old.reduce((a, b) => (b.ts > a.ts ? b : a))
  const cumNow = newest.cum + spot * BigInt(now - newest.ts)
  const dt = BigInt(now - then.ts)
  if (dt === 0n || cumNow < then.cum) return null
  return (cumNow - then.cum) / dt
}
const withinGuard = (spot, twap, guardBps) => twap !== 0n && (spot > twap ? spot - twap : twap - spot) * BPS <= twap * BigInt(guardBps)
const bidFor = (tokens, spot, twap, discountBps) => (((tokens * (spot < twap ? spot : twap)) >> 32n) * (BPS - BigInt(discountBps))) / BPS

function readObservations(d, tokenIsA) {
  const out = []
  if (!d || d.length < 43 + 4000) return out
  for (let i = 0; i < 100; i++) {
    const at = 43 + i * 40
    const ts = Number(d.readBigUInt64LE(at))
    const cum0 = BigInt('0x' + Buffer.from(d.subarray(at + 8, at + 24)).reverse().toString('hex'))
    const cum1 = BigInt('0x' + Buffer.from(d.subarray(at + 24, at + 40)).reverse().toString('hex'))
    out.push({ ts, cum: tokenIsA ? cum0 : cum1 })
  }
  return out
}

/**
 * What the vault would pay for `tokens` base units right now, and whether it would accept the sale.
 * Reads the same accounts the program reads, so the answer matches what the chain will decide (to within a swap or two).
 */
async function quoteSale(connection, programId, mint, tokens) {
  const a = addresses(programId, mint)
  const [launchAcc, vaultAcc, vaultWsolAcc, configAcc] = await connection.getMultipleAccountsInfo([a.launch, a.vault, wsolAta(a.vault), a.config])
  const launch = readLaunch(launchAcc && launchAcc.data)
  const vault = readVault(vaultAcc && vaultAcc.data)
  const config = readConfig(configAcc && configAcc.data)
  const out = { ok: false, reason: null, bidLamports: 0n, vaultLamports: tokenAmount(vaultWsolAcc && vaultWsolAcc.data) }
  if (!launch || !vault || !config) return { ...out, reason: 'This token has no burn vault.' }
  if (!launch.graduatedAt) return { ...out, reason: 'The vault opens when the token graduates to a Raydium pool.' }
  if (config.paused || vault.paused) return { ...out, reason: 'Vault sales are paused.' }

  const poolAcc = await connection.getAccountInfo(launch.cpmmPool)
  const pool = readPool(poolAcc && poolAcc.data)
  if (!pool) return { ...out, reason: 'The Raydium pool could not be read.' }
  const [va, vb, obsAcc] = await connection.getMultipleAccountsInfo([pool.vaultA, pool.vaultB, pool.observation])
  const tokenIsA = pool.mintA.equals(mint)
  const resA = tokenAmount(va && va.data) - pool.feesA
  const resB = tokenAmount(vb && vb.data) - pool.feesB
  const [tokenRes, solRes] = tokenIsA ? [resA, resB] : [resB, resA]
  if (tokenRes <= 0n || solRes <= 0n) return { ...out, reason: 'The pool has no liquidity.' }
  const spot = (solRes << 32n) / tokenRes
  const now = Math.floor(Date.now() / 1000)
  const twap = twapX32(readObservations(obsAcc && obsAcc.data, tokenIsA), now, vault.params.twapWindow, spot)
  const info = { ...out, spotX32: spot, twapX32: twap, vault, launch, pool, poolParts: { vaultA: pool.vaultA, vaultB: pool.vaultB, observation: pool.observation }, cpmm: launch.cpmmPool }
  if (twap === null) return { ...info, reason: 'The pool needs about ' + Math.ceil(vault.params.twapWindow / 60) + ' minutes of price history before the vault can bid.' }
  if (!withinGuard(spot, twap, vault.params.guardBps)) return { ...info, reason: 'The price has moved too much in the last few minutes. The vault will bid again once it settles.' }
  const bid = bidFor(tokens, spot, twap, vault.params.discountBps)
  info.bidLamports = bid
  info.pricePerTokenSol = Number(spot < twap ? spot : twap) / 2 ** 32 / 1e9 * 1e6 // SOL per whole token (6 decimals)
  if (bid === 0n) return { ...info, reason: 'That amount is too small to bid on.' }

  // Spending limits, with the daily window rolled over the way the program does it.
  let wStart = vault.windowStart
  let wBal = vault.windowStartBalance
  let wSpent = vault.windowSpent
  if (wStart === 0 || now - wStart >= DAY) {
    wStart = now
    wBal = info.vaultLamports
    wSpent = 0n
  }
  const p = vault.params
  const cap = (info.vaultLamports * BigInt(p.maxSaleBps)) / BPS
  info.maxSaleLamports = cap
  if (bid * BPS > info.vaultLamports * BigInt(p.maxSaleBps)) return { ...info, reason: 'That is more than the per-sale limit.' }
  if (info.vaultLamports < bid || info.vaultLamports - bid < p.reserve) return { ...info, reason: 'The vault keeps a reserve and cannot pay that out.' }
  if (wSpent + bid > (wBal * BigInt(p.dailyBps)) / BPS) return { ...info, reason: 'The vault has reached its limit for today.' }
  return { ...info, ok: true }
}

module.exports = {
  LAUNCHLAB, CPMM, THIRTY_DAYS, wsolAta, addresses, cpmmPool, configAddress,
  ixInitializeConfig, ixCreateLaunch, ixHarvest, ixMarkGraduated, ixClaimCreator, ixExpireCreator, ixSellToVault,
  readConfig, readLaunch, readStream, readVault, readPool, tokenAmount, quoteSale, readObservations, twapX32, bidFor, withinGuard,
}
