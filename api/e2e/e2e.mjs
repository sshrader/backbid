/*
 * End-to-end test of the API on devnet. It starts the server, then acts as a wallet: it asks the API for
 * transactions, signs them with the test key, and sends them back. Run by the "API end-to-end test" workflow.
 * Env: RPC_URL, STATE_DIR. Reads deployer.json and burnpad-id.txt from STATE_DIR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Keypair, VersionedTransaction } from '@solana/web3.js'

const STATE_DIR = process.env.STATE_DIR || '.state'
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'deployer.json'), 'utf8'))))
const programId = fs.readFileSync(path.join(STATE_DIR, 'burnpad-id.txt'), 'utf8').trim()
const owner = wallet.publicKey.toBase58()
const PORT = 3111
const API = 'http://127.0.0.1:' + PORT
const log = (...a) => console.log(...a)
const section = (t) => log('\n=== ' + t + ' ===')
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))

async function call(method, url, body) {
  const res = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const json = await res.json()
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + (json.error || res.status))
  return json
}
/** Sign what the API built and send it back to be relayed, the way the web app does. */
async function signAndSend(label, built, extra = {}) {
  const signed = built.transactions.map((b64) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
    tx.sign([wallet])
    return Buffer.from(tx.serialize()).toString('base64')
  })
  const sent = await call('POST', '/tx/send', { transactions: signed, ...extra })
  log('PASS:', label, '| tx', sent.signatures.join(' '))
  return sent
}

const server = spawn('node', ['src/server.js'], { cwd: new URL('../', import.meta.url).pathname, env: { ...process.env, PORT: String(PORT), RPC_URL, BURNPAD_PROGRAM_ID: programId, DATA_DIR: '/tmp/e2e-data', PUBLIC_URL: 'https://example.com' }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d))
server.stderr.on('data', (d) => process.stdout.write('[server] ' + d))

let failed = false
try {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(API + '/health')).ok) break
    } catch {
      /* not up yet */
    }
    await sleep(1)
  }

  section('1. Config')
  const config = await call('GET', '/config')
  log('program', config.burnpadProgramId, '| initialized', config.program.initialized, '| window', config.program.params && config.program.params.twapWindowMinutes, 'min')
  if (!config.program.initialized) throw new Error('The program is not set up on devnet yet. Run the Burnpad devnet test workflow first.')

  section('2. Launch in two steps')
  const first = await call('POST', '/tx/launch', { owner, name: 'E2E Test', symbol: 'E2E', description: 'API end-to-end test', firstBuySol: '0.3', targetSol: '1' })
  const mint = first.mint
  log('mint', mint)
  await signAndSend('launch step 1 (register with the program)', first)
  let second
  for (let i = 0; i < 6; i++) {
    try {
      second = await call('POST', '/tx/launch-pool', { owner, mint })
      break
    } catch (e) {
      log('waiting for step 1 to confirm:', e.message)
      await sleep(5)
    }
  }
  await signAndSend('launch step 2 (curve and first buy)', second, { mint })
  const t0 = await call('GET', '/tokens/' + mint)
  log('status', t0.pool.status, '| raised', t0.pool.raisedSol, 'of', t0.pool.targetSol, '| vault', JSON.stringify(t0.pool.burnpad.vault))

  section('3. Buy until it graduates')
  for (let i = 0; i < 6; i++) {
    const t = await call('GET', '/tokens/' + mint)
    if (t.pool.status !== 0) break
    const remaining = Math.max(0.01, t.pool.targetSol - t.pool.raisedSol)
    const sol = (remaining * 1.05).toFixed(6)
    try {
      await signAndSend('buy ' + sol + ' SOL', await call('POST', '/tx/buy', { owner, mint, sol }))
    } catch (e) {
      log('buy failed:', e.message.slice(0, 160))
    }
  }

  section('4. Wait for Raydium to move it to a pool, then mark it graduated')
  let migrated = false
  for (let i = 0; i < 60 && !migrated; i++) {
    const t = await call('GET', '/tokens/' + mint)
    migrated = t.pool.status === 2 && !!t.pool.cpmm
    if (!migrated) await sleep(15)
  }
  if (!migrated) throw new Error('Raydium did not move the token within 15 minutes.')
  await signAndSend('graduate', await call('POST', '/tx/graduate', { owner, mint }))
  log('graduated:', (await call('GET', '/tokens/' + mint)).pool.burnpad.graduated)

  section('5. Pool swap, harvest, wait, pool swap (this builds the price history)')
  await signAndSend('pool buy 0.01 SOL', await call('POST', '/tx/buy', { owner, mint, sol: '0.01' }))
  await signAndSend('harvest fees', await call('POST', '/tx/harvest', { owner, mint }))
  log('vault now holds', (await call('GET', '/tokens/' + mint)).pool.burnpad.vault.sol, 'SOL')
  log('waiting 80 seconds for the price window')
  await sleep(80)
  await signAndSend('pool buy 0.01 SOL', await call('POST', '/tx/buy', { owner, mint, sol: '0.01' }))

  section('6. THE TEST: ask for a vault quote, then sell to the vault')
  const q = await call('GET', '/vault/' + mint + '?tokens=20000')
  log('quote:', JSON.stringify(q.quote))
  if (!q.quote.ok) throw new Error('The vault refused: ' + q.quote.reason)
  const before = q.burnpad.vault.burnedTokens
  await signAndSend('sell 20000 tokens to the vault', await call('POST', '/tx/vault-sell', { owner, mint, tokens: '20000' }))
  const after = (await call('GET', '/vault/' + mint)).burnpad.vault
  log('burned tokens', before, '->', after.burnedTokens, '| paid out', after.paidSol, 'SOL')
  if (!(after.burnedTokens - before >= 19999.9)) throw new Error('The burn counter did not move as expected.')
  log('PASS: quote, sale and burn work through the API')
} catch (e) {
  failed = true
  log('FAILED:', e.message)
}

server.kill()
section('Result')
log(failed ? 'FAILED. The log above shows where.' : 'The API drives the whole launch, trade, harvest and vault flow on devnet.')
process.exit(failed ? 1 : 0)
