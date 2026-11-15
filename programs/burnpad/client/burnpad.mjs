/* Instruction builders for the burnpad program. Mirrors src/processor.rs; keep the two in step. */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DEVNET_PROGRAM_ID, getPdaPlatformId, getPdaPlatformVault, getPdaPlatformFeeVaultAuth } from '@raydium-io/raydium-sdk-v2'

export const LAUNCHLAB = DEVNET_PROGRAM_ID.LAUNCHPAD_PROGRAM

const seed = (s) => Buffer.from(s, 'utf8')
export const wsolAta = (owner) => getAssociatedTokenAddressSync(NATIVE_MINT, owner, true)

export function addresses(programId, mint) {
  const pda = (...parts) => PublicKey.findProgramAddressSync(parts, programId)[0]
  const authority = pda(seed('authority'), mint.toBuffer())
  const platform = getPdaPlatformId(LAUNCHLAB, authority).publicKey
  return {
    config: pda(seed('config')),
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

const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })
const str = (s) => {
  const b = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(b.length)
  return Buffer.concat([len, b])
}

export function ixInitializeConfig(programId, admin, treasury) {
  const a = addresses(programId, PublicKey.default)
  return new TransactionInstruction({
    programId,
    keys: [meta(admin, true, true), meta(a.config, true), meta(treasury), meta(SystemProgram.programId)],
    data: Buffer.from([0]),
  })
}

export function ixCreateLaunch(programId, creator, mint, cpConfigId, { feeRate, name, web, img }) {
  const a = addresses(programId, mint)
  const rate = Buffer.alloc(8)
  rate.writeBigUInt64LE(BigInt(feeRate))
  return new TransactionInstruction({
    programId,
    keys: [
      meta(creator, true, true),
      meta(a.config),
      meta(mint),
      meta(a.launch, true),
      meta(a.stream, true),
      meta(a.vault, true),
      meta(a.authority, true),
      meta(a.platform, true),
      meta(cpConfigId, true),
      meta(SystemProgram.programId),
      meta(LAUNCHLAB),
    ],
    data: Buffer.concat([Buffer.from([1]), rate, str(name), str(web), str(img)]),
  })
}

export function ixHarvest(programId, mint, treasury) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({
    programId,
    keys: [
      meta(a.launch, true),
      meta(a.stream, true),
      meta(a.config),
      meta(a.authority, true), // LaunchLab marks its fee wallet writable, so the call into it must too
      meta(a.platform),
      meta(a.feeAuth),
      meta(a.feeVault, true),
      meta(wsolAta(a.authority), true),
      meta(NATIVE_MINT),
      meta(TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(LAUNCHLAB),
      meta(wsolAta(a.vault), true),
      meta(wsolAta(a.stream), true),
      meta(wsolAta(treasury), true),
    ],
    data: Buffer.from([2]),
  })
}

export function ixMarkGraduated(programId, mint) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({ programId, keys: [meta(a.launch, true), meta(a.stream, true), meta(a.launchlabPool)], data: Buffer.from([3]) })
}

export function ixClaimCreator(programId, creator, mint) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({
    programId,
    keys: [meta(creator, false, true), meta(a.launch), meta(a.stream, true), meta(wsolAta(a.stream), true), meta(wsolAta(creator), true), meta(TOKEN_PROGRAM_ID)],
    data: Buffer.from([4]),
  })
}

export function ixExpireCreator(programId, mint) {
  const a = addresses(programId, mint)
  return new TransactionInstruction({
    programId,
    keys: [meta(a.launch, true), meta(a.stream), meta(wsolAta(a.stream), true), meta(wsolAta(a.vault), true), meta(TOKEN_PROGRAM_ID)],
    data: Buffer.from([5]),
  })
}
