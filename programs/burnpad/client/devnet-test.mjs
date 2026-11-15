/*
 * End-to-end devnet test of the burnpad program, run by the "Burnpad devnet test" workflow.
 *   1. initialize_config  2. create_launch (per-token platform owned by the program)
 *   3. LaunchLab create-pool + first buy, using that platform  4. harvest_fees, then check the 50/25/25 split
 * Env: RPC_URL, STATE_DIR. Reads deployer.json and burnpad-id.txt from STATE_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAccount } from '@solana/spl-token'
import { Raydium, TxVersion, DEV_API_URLS, LaunchpadConfig, getPdaLaunchpadConfigId } from '@raydium-io/raydium-sdk-v2'
import { LAUNCHLAB, addresses, wsolAta, ixInitializeConfig, ixCreateLaunch, ixHarvest } from './burnpad.mjs'

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const STATE_DIR = process.env.STATE_DIR || '.state'
const connection = new Connection(RPC_URL, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'deployer.json'), 'utf8'))))
const programId = new PublicKey(fs.readFileSync(path.join(STATE_DIR, 'burnpad-id.txt'), 'utf8').trim())
const log = (...a) => console.log(...a)
const section = (t) => log('\n=== ' + t + ' ===')
const cu = (n) => ComputeBudgetProgram.setComputeUnitLimit({ units: n })

async function send(label, ixs, signers = [payer]) {
  try {
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(cu(600_000), ...ixs), signers)
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

let failed = false
try {
  log('payer    ', payer.publicKey.toBase58())
  log('program  ', programId.toBase58())
  log('balance  ', (await connection.getBalance(payer.publicKey)) / 1e9, 'SOL')
  const treasury = payer.publicKey // a real deployment uses a multisig

  section('1. initialize_config')
  const cfg = addresses(programId, PublicKey.default).config
  if (await connection.getAccountInfo(cfg)) log('Config already exists. Reusing it.')
  else await send('initialize_config', [ixInitializeConfig(programId, payer.publicKey, treasury)])

  section('2. create_launch: a new platform owned by the program')
  const mint = Keypair.generate()
  const a = addresses(programId, mint.publicKey)
  log('mint', mint.publicKey.toBase58(), '| authority', a.authority.toBase58(), '| platform', a.platform.toBase58())
  const configs = await (await fetch('https://api-v3-devnet.raydium.io/main/cpmm-config')).json()
  const cpConfigId = new PublicKey(configs.data.slice().sort((x, y) => x.index - y.index)[0].id)
  const atas = [a.authority, a.vault, a.stream, treasury].map((o) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta(o), o, NATIVE_MINT))
  await send('create_launch', [...atas, ixCreateLaunch(programId, payer.publicKey, mint.publicKey, cpConfigId, { feeRate: 12500, name: 'burnpad-test', web: 'https://example.com', img: 'https://example.com' })])

  section('3. LaunchLab create-pool and first buy, on that platform')
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
  const configId = getPdaLaunchpadConfigId(LAUNCHLAB, NATIVE_MINT, 0, 0).publicKey
  const configInfo = LaunchpadConfig.decode((await connection.getAccountInfo(configId)).data)
  const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB)
  const { execute } = await raydium.launchpad.createLaunchpad({
    programId: LAUNCHLAB,
    mintA: mint.publicKey,
    decimals: 6,
    name: 'Burnpad Test',
    symbol: 'BPT',
    migrateType: 'cpmm',
    uri: 'https://example.com/burnpad-test.json',
    configId,
    configInfo,
    mintBDecimals: mintBInfo.decimals,
    mintBProgram: new PublicKey(mintBInfo.programId),
    platformId: a.platform,
    txVersion: TxVersion.V0,
    slippage: new BN(100),
    buyAmount: new BN(500_000_000), // 0.5 SOL
    createOnly: false,
    extraSigners: [mint],
  })
  const { txIds } = await execute({ sequentially: true })
  log('PASS: pool created and first buy done | txs', txIds)

  section('4. harvest_fees: the test')
  const before = { vault: await balance(wsolAta(a.vault)), stream: await balance(wsolAta(a.stream)), treasury: await balance(wsolAta(treasury)) }
  await send('harvest_fees', [ixHarvest(programId, mint.publicKey, treasury)])
  const after = { vault: await balance(wsolAta(a.vault)), stream: await balance(wsolAta(a.stream)), treasury: await balance(wsolAta(treasury)) }
  const got = { vault: after.vault - before.vault, creator: after.stream - before.stream, treasury: after.treasury - before.treasury }
  const total = got.vault + got.creator + got.treasury
  log('harvested', total / 1e9, 'SOL -> vault', got.vault / 1e9, '| creator stream', got.creator / 1e9, '| treasury', got.treasury / 1e9)
  const ok = total > 0 && got.creator === Math.floor(total / 4) && got.treasury === Math.floor(total / 4) && got.vault === total - got.creator - got.treasury
  log(ok ? 'PASS: the split is 50/25/25' : 'FAIL: the split is not 50/25/25')
  failed = !ok
} catch (e) {
  failed = true
  log('Stopped early:', e.message)
}

section('Result')
log(failed ? 'FAILED. The log above shows where.' : 'Burnpad milestone 1 works on devnet: per-token platform, harvest and split.')
process.exit(failed ? 1 : 0)
