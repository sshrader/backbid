/*
 * Devnet experiment, run by the GitHub Action after the program is deployed.
 *
 *   1. Register a LaunchLab platform whose fee wallet is a PDA of the experiment program.
 *   2. Launch a token and buy, so the platform fee vault collects some SOL.
 *   3. Ask the experiment program to claim those fees, signing as the PDA.
 *   4. Optionally read a CPMM pool's observation (TWAP) buffer and report how far back it reaches.
 *
 * Env: RPC_URL, STATE_DIR, POOL_ID (optional). Reads STATE_DIR/deployer.json and STATE_DIR/program-id.txt.
 */
import fs from 'node:fs'
import path from 'node:path'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getAccount } from '@solana/spl-token'
import {
  Raydium,
  TxVersion,
  DEV_API_URLS,
  DEVNET_PROGRAM_ID,
  LaunchpadConfig,
  getPdaLaunchpadConfigId,
  getPdaPlatformId,
  getPdaPlatformVault,
  getPdaPlatformFeeVaultAuth,
} from '@raydium-io/raydium-sdk-v2'

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const STATE_DIR = process.env.STATE_DIR || '.state'
const LAUNCHPAD = DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM
const CPMM = DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM

const log = (...a) => console.log(...a)
const section = (t) => log('\n=== ' + t + ' ===')

const connection = new Connection(RPC_URL, 'confirmed')
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'deployer.json'), 'utf8'))))
const programId = new PublicKey(fs.readFileSync(path.join(STATE_DIR, 'program-id.txt'), 'utf8').trim())
const statePath = path.join(STATE_DIR, 'state.json')
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2))

const [claimer] = PublicKey.findProgramAddressSync([Buffer.from('claimer')], programId)
const recipient = getAssociatedTokenAddressSync(NATIVE_MINT, claimer, true)
const platformId = getPdaPlatformId(LAUNCHPAD, payer.publicKey).publicKey
const platformVault = getPdaPlatformVault(LAUNCHPAD, platformId, NATIVE_MINT).publicKey
const feeAuth = getPdaPlatformFeeVaultAuth(LAUNCHPAD).publicKey

log('payer           ', payer.publicKey.toBase58())
log('experiment prog ', programId.toBase58())
log('claimer PDA     ', claimer.toBase58())
log('platform        ', platformId.toBase58())

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

async function vaultLamports() {
  try {
    return Number((await getAccount(connection, platformVault)).amount)
  } catch {
    return 0
  }
}

let failed = false

const alreadyPassed = state.pdaClaim === 'PASS' && !process.env.FORCE_RERUN
if (alreadyPassed) log('\nThe PDA claim test already passed in an earlier run. Skipping steps 1 to 4. Set FORCE_RERUN=1 to repeat it.')

try {
  if (alreadyPassed) throw Object.assign(new Error('skip'), { skip: true })
  section('1. Register a platform whose fee wallet is the PDA')
  const existing = await connection.getAccountInfo(platformId)
  if (existing) {
    log('Platform already exists from an earlier run. Reusing it.')
  } else {
    const configs = await (await fetch('https://api-v3-devnet.raydium.io/main/cpmm-config')).json()
    const cpConfig = configs.data.slice().sort((a, b) => a.index - b.index)[0]
    const { execute } = await raydium.launchpad.createPlatformConfig({
      programId: LAUNCHPAD,
      platformAdmin: payer.publicKey,
      platformClaimFeeWallet: claimer, // <-- the point of the experiment
      platformLockNftWallet: payer.publicKey,
      platformVestingWallet: payer.publicKey,
      cpConfigId: new PublicKey(cpConfig.id),
      transferFeeExtensionAuth: payer.publicKey,
      creatorFeeRate: new BN(0),
      migrateCpLockNftScale: { platformScale: new BN(1000000), creatorScale: new BN(0), burnScale: new BN(0) },
      feeRate: new BN(10000), // 1%
      name: 'pda-claim-test',
      web: 'https://example.com',
      img: 'https://example.com',
      txVersion: TxVersion.V0,
    })
    const { txId } = await execute({ sendAndConfirm: true })
    log('PASS: platform registered with a PDA fee wallet. tx', txId)
  }

  section('2. Fund the PDA and create its wrapped-SOL account')
  const prep = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: claimer, lamports: 10_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, recipient, claimer, NATIVE_MINT)
  )
  log('tx', await sendAndConfirmTransaction(connection, prep, [payer]))

  section('3. Launch a token and buy, so fees build up')
  if ((await vaultLamports()) === 0) {
    const configId = getPdaLaunchpadConfigId(LAUNCHPAD, NATIVE_MINT, 0, 0).publicKey
    const configInfo = LaunchpadConfig.decode((await connection.getAccountInfo(configId)).data)
    const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB)
    const pair = Keypair.generate()
    const { execute } = await raydium.launchpad.createLaunchpad({
      programId: LAUNCHPAD,
      mintA: pair.publicKey,
      decimals: 6,
      name: 'PDA Test',
      symbol: 'PDAT',
      migrateType: 'cpmm',
      uri: 'https://example.com/pda-test.json',
      configId,
      configInfo,
      mintBDecimals: mintBInfo.decimals,
      mintBProgram: new PublicKey(mintBInfo.programId),
      platformId,
      txVersion: TxVersion.V0,
      slippage: new BN(100),
      buyAmount: new BN(1_000_000_000), // 1 SOL
      createOnly: false,
      extraSigners: [pair],
    })
    const { txIds } = await execute({ sequentially: true })
    log('launched', pair.publicKey.toBase58(), 'txs', txIds)
  } else {
    log('Fee vault already has fees. Skipping the launch.')
  }
  const before = await vaultLamports()
  log('Platform fee vault holds', before / 1e9, 'SOL')
  if (before === 0) throw new Error('The fee vault is still empty, so there is nothing to claim. Re-run the workflow in a minute.')

  section('4. THE TEST: claim the fees through the program, signing as the PDA')
  const keys = [
    { pubkey: claimer, isSigner: false, isWritable: true }, // program signs for it
    { pubkey: feeAuth, isSigner: false, isWritable: false },
    { pubkey: platformId, isSigner: false, isWritable: false },
    { pubkey: platformVault, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: LAUNCHPAD, isSigner: false, isWritable: false },
  ]
  const claim = new Transaction().add(new TransactionInstruction({ programId, keys, data: Buffer.alloc(0) }))
  try {
    const sig = await sendAndConfirmTransaction(connection, claim, [payer])
    const got = Number((await getAccount(connection, recipient)).amount)
    log('PASS: a PDA can be the platform fee wallet. tx', sig)
    log('The PDA received', got / 1e9, 'SOL as wrapped SOL; the vault now holds', (await vaultLamports()) / 1e9)
    state.pdaClaim = 'PASS'
  } catch (e) {
    failed = true
    state.pdaClaim = 'FAIL'
    log('FAIL: the claim was rejected.')
    log(e.message)
    if (e.logs) log(e.logs.join('\n'))
  }
  save()
} catch (e) {
  if (e.skip) {
    /* nothing to do */
  } else {
  failed = true
  log('The experiment stopped early:', e.message)
  if (e.logs) log(e.logs.join('\n'))
  }
}

/* ---------- TWAP: how far back does a pool's observation buffer reach? ---------- */
if (process.env.POOL_ID) {
  section('5. Observation (TWAP) buffer of pool ' + process.env.POOL_ID)
  try {
    const pool = new PublicKey(process.env.POOL_ID)
    const [obs] = PublicKey.findProgramAddressSync([Buffer.from('observation'), pool.toBuffer()], CPMM)
    const info = await connection.getAccountInfo(obs)
    if (!info) throw new Error('No observation account at ' + obs.toBase58() + '. Is that a CPMM pool id?')
    const d = info.data
    log('observation account', obs.toBase58(), 'bytes', d.length, 'index', d.readUInt16LE(9))
    const times = []
    for (let i = 0; i < 100; i++) {
      const t = Number(d.readBigUInt64LE(43 + i * 40))
      if (t > 0) times.push(t)
    }
    times.sort((a, b) => a - b)
    if (times.length < 2) {
      log('Only', times.length, 'samples so far. Swap on the pool a few times and run again.')
    } else {
      const span = times[times.length - 1] - times[0]
      log('samples', times.length, 'of 100; oldest to newest covers', Math.round(span / 60), 'minutes')
      log('newest sample', new Date(times[times.length - 1] * 1000).toISOString())
    }
  } catch (e) {
    log('Could not read the observation buffer:', e.message)
  }
}

section('Result')
log(failed ? 'FAILED. Paste this whole log back to Claude.' : 'The PDA-owned platform works on devnet.')
process.exit(failed ? 1 : 0)
