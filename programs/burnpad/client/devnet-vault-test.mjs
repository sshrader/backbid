/*
 * Devnet test of the burn vault, run by the "Burnpad devnet test" workflow (second half).
 *  1. config + short test parameters   2. launch a token with the lowest graduation target and buy until it graduates
 *  3. mark_graduated   4. two small pool swaps a minute apart (they write the price history)   5. harvest into the vault
 *  6. sell_to_vault: the holder sells tokens, gets SOL, and the tokens are burned
 * Env: RPC_URL, STATE_DIR. Reads deployer.json and burnpad-id.txt from STATE_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Raydium, TxVersion, DEV_API_URLS, LaunchpadConfig, CurveCalculator, FeeOn, getPdaLaunchpadConfigId, getPdaLaunchpadPoolId } from '@raydium-io/raydium-sdk-v2'
import { LAUNCHLAB, addresses, wsolAta, cpmmPool, poolParts, ixInitializeConfig, ixSetParams, ixCreateLaunch, ixHarvest, ixMarkGraduated, ixSellToVault } from './burnpad.mjs'

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const STATE_DIR = process.env.STATE_DIR || '.state'
const connection = new Connection(RPC_URL, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'deployer.json'), 'utf8'))))
const programId = new PublicKey(fs.readFileSync(path.join(STATE_DIR, 'burnpad-id.txt'), 'utf8').trim())
const log = (...a) => console.log(...a)
const section = (t) => log('\n=== ' + t + ' ===')
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))
const cu = (n) => ComputeBudgetProgram.setComputeUnitLimit({ units: n })

async function send(label, ixs) {
  try {
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(cu(600_000), ...ixs), [payer])
    log('PASS:', label, '| tx', sig)
    return sig
  } catch (e) {
    log('FAIL:', label)
    log(e.message)
    if (e.logs) log(e.logs.join('\n'))
    throw e
  }
}
const balance = async (ata) => {
  try {
    return Number((await getAccount(connection, ata)).amount)
  } catch {
    return 0
  }
}

const raydium = await Raydium.load({
  owner: payer,
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

/** One small swap on the token's Raydium pool, worked out with the pool's own maths. */
async function poolSwap(pool, mint, solIn) {
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(pool.toBase58())
  const baseIn = NATIVE_MINT.toBase58() === poolInfo.mintA.address
  const input = new BN(solIn)
  const swapResult = CurveCalculator.swapBaseInput(
    input,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate,
    rpcData.configInfo.creatorFeeRate,
    rpcData.configInfo.protocolFeeRate,
    rpcData.configInfo.fundFeeRate,
    rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
  )
  const { execute } = await raydium.cpmm.swap({ poolInfo, poolKeys, inputAmount: input, swapResult, slippage: 0.05, baseIn, txVersion: TxVersion.V0 })
  const { txId } = await execute({ sendAndConfirm: true })
  log('PASS: pool swap of', solIn / 1e9, 'SOL | tx', txId)
}

let failed = false
try {
  log('payer    ', payer.publicKey.toBase58())
  log('program  ', programId.toBase58())
  log('balance  ', (await connection.getBalance(payer.publicKey)) / 1e9, 'SOL')
  const treasury = payer.publicKey

  section('1. Config and test parameters')
  const cfg = addresses(programId, PublicKey.default).config
  if (!(await connection.getAccountInfo(cfg))) await send('initialize_config', [ixInitializeConfig(programId, payer.publicKey, treasury)])
  // Short price window and no reserve, so the test finishes in minutes. The program's bounds allow this on devnet only.
  await send('set_params', [ixSetParams(programId, payer.publicKey, { discountBps: 750, maxSaleBps: 200, dailyBps: 1000, guardBps: 1500, twapWindow: 60, reserve: 0 })])

  section('2. Launch with the lowest graduation target, then buy until it graduates')
  const mint = Keypair.generate()
  const a = addresses(programId, mint.publicKey)
  log('mint', mint.publicKey.toBase58(), '| platform', a.platform.toBase58())
  const configs = await (await fetch('https://api-v3-devnet.raydium.io/main/cpmm-config')).json()
  const cpConfigId = new PublicKey(configs.data.slice().sort((x, y) => x.index - y.index)[0].id)
  const atas = [a.authority, a.vault, a.stream, treasury].map((o) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta(o), o, NATIVE_MINT))
  await send('create_launch', [...atas, ixCreateLaunch(programId, payer.publicKey, mint.publicKey, cpConfigId, { feeRate: 12500, name: 'vault-test', web: 'https://example.com', img: 'https://example.com' })])

  const configId = getPdaLaunchpadConfigId(LAUNCHLAB, NATIVE_MINT, 0, 0).publicKey
  const configInfo = LaunchpadConfig.decode((await connection.getAccountInfo(configId)).data)
  const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB)
  const target = configInfo.minFundRaisingB
  log('graduation target', target.toString(), 'lamports')
  const { execute } = await raydium.launchpad.createLaunchpad({
    programId: LAUNCHLAB,
    mintA: mint.publicKey,
    decimals: 6,
    name: 'Vault Test',
    symbol: 'VLT',
    migrateType: 'cpmm',
    uri: 'https://example.com/vault-test.json',
    configId,
    configInfo,
    mintBDecimals: mintBInfo.decimals,
    mintBProgram: new PublicKey(mintBInfo.programId),
    platformId: a.platform,
    txVersion: TxVersion.V0,
    slippage: new BN(100),
    buyAmount: new BN(500_000_000),
    createOnly: false,
    extraSigners: [mint],
    totalFundRaisingB: target,
  })
  await execute({ sequentially: true })
  log('PASS: launched with a first buy')

  const poolId = getPdaLaunchpadPoolId(LAUNCHLAB, mint.publicKey, NATIVE_MINT).publicKey
  const mintAInfo = await raydium.token.getTokenInfo(mint.publicKey)
  let step = new BN(1_000_000_000)
  for (let i = 0; i < 14; i++) {
    const poolInfo = await raydium.launchpad.getRpcPoolInfo({ poolId })
    if (Number(poolInfo.status) !== 0) break
    const remaining = target.sub(poolInfo.realB)
    let amount = BN.min(step, remaining.muln(104).divn(100).addn(1000))
    try {
      const { execute: buy } = await raydium.launchpad.buyToken({
        programId: LAUNCHLAB,
        mintA: mint.publicKey,
        mintAProgram: new PublicKey(mintAInfo.programId),
        poolInfo,
        mintB: poolInfo.mintB,
        mintBProgram: new PublicKey(mintBInfo.programId),
        slippage: new BN(100),
        configInfo: poolInfo.configInfo,
        platformFeeRate: new BN(12500),
        txVersion: TxVersion.V0,
        buyAmount: amount,
      })
      await buy({ sendAndConfirm: true })
      log('bought', amount.toString(), 'lamports; raised', poolInfo.realB.add(amount).toString(), 'of', target.toString())
    } catch (e) {
      step = step.divn(2)
      log('buy failed, trying a smaller one:', String(e.message).slice(0, 120))
    }
  }

  section('3. Wait for Raydium to move the token to its pool, then mark_graduated')
  const platformData = (await connection.getAccountInfo(a.platform)).data
  const pool = cpmmPool(new PublicKey(platformData.subarray(688, 720)), mint.publicKey)
  let migrated = false
  for (let i = 0; i < 60 && !migrated; i++) {
    const info = await raydium.launchpad.getRpcPoolInfo({ poolId })
    migrated = Number(info.status) === 2 && !!(await connection.getAccountInfo(pool))
    if (!migrated) await sleep(15)
  }
  if (!migrated) throw new Error('Raydium did not migrate the token within 15 minutes. Run the test again later.')
  log('Raydium pool', pool.toBase58())
  await send('mark_graduated', [ixMarkGraduated(programId, mint.publicKey, pool)])

  section('4. Two small pool swaps a minute apart, and harvest into the vault')
  await poolSwap(pool, mint.publicKey, 10_000_000)
  await send('harvest_fees', [ixHarvest(programId, mint.publicKey, treasury)])
  const vaultSol = await balance(wsolAta(a.vault))
  log('vault holds', vaultSol / 1e9, 'SOL')
  log('waiting 80 seconds so the first swap is older than the price window')
  await sleep(80)
  await poolSwap(pool, mint.publicKey, 10_000_000)

  section('5. THE TEST: sell tokens to the vault')
  const poolData = (await connection.getAccountInfo(pool)).data
  const parts = poolParts(poolData)
  const tokenIsA = parts.mintA.equals(mint.publicKey)
  const [vTok, vSol] = await Promise.all([balance(tokenIsA ? parts.vaultA : parts.vaultB), balance(tokenIsA ? parts.vaultB : parts.vaultA)])
  const lamportsPerToken = vSol / vTok // reserves are close enough to size a test sale
  const tokens = Math.max(1, Math.floor(200_000 / lamportsPerToken)) // about 0.0002 SOL worth
  const holderTokens = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey)
  const holderWsol = wsolAta(payer.publicKey)
  const before = { tokens: await balance(holderTokens), wsol: await balance(holderWsol), vault: await balance(wsolAta(a.vault)) }
  log('selling', tokens, 'base units; vault holds', before.vault / 1e9, 'SOL; holder has', before.tokens, 'tokens')
  await send('sell_to_vault', [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, holderWsol, payer.publicKey, NATIVE_MINT),
    ixSellToVault(programId, payer.publicKey, mint.publicKey, tokens, 1, pool, parts),
  ])
  const after = { tokens: await balance(holderTokens), wsol: await balance(holderWsol), vault: await balance(wsolAta(a.vault)) }
  const vaultAcct = (await connection.getAccountInfo(a.vault)).data
  const burned = Number(vaultAcct.readBigUInt64LE(46))
  const paid = after.wsol - before.wsol
  log('holder tokens', before.tokens, '->', after.tokens, '| holder wrapped SOL +', paid / 1e9, '| vault', before.vault / 1e9, '->', after.vault / 1e9, '| vault burn counter', burned)
  const ok = before.tokens - after.tokens === tokens && paid > 0 && before.vault - after.vault === paid && burned === tokens
  log(ok ? 'PASS: tokens burned, holder paid, vault debited by the same amount' : 'FAIL: the numbers do not line up')
  failed = !ok
} catch (e) {
  failed = true
  log('Stopped early:', e.message)
}

section('Result')
log(failed ? 'FAILED. The log above shows where.' : 'The burn vault works on devnet: price from the pool, discount, burn.')
process.exit(failed ? 1 : 0)
