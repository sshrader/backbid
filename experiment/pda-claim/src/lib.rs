//! Experiment: claim a Raydium LaunchLab platform's fees with a PDA as the fee wallet.
//!
//! The PDA ["claimer"] of this program is set as `platformClaimFeeWallet` when the platform
//! is registered. This program then calls LaunchLab's `claim_platform_fee_from_vault` and signs
//! for the PDA with `invoke_signed`. If that succeeds on devnet, the real vault program can
//! own the platform and split fees on-chain.
//!
//! Accounts, in order:
//!   0  claimer PDA          (writable, signed by this program)
//!   1  LaunchLab fee-vault authority
//!   2  platform config
//!   3  platform fee vault   (writable)
//!   4  recipient token account, owned by the claimer PDA (writable)
//!   5  quote mint (wrapped SOL)
//!   6  token program
//!   7  system program
//!   8  associated token program
//!   9  LaunchLab program

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

entrypoint!(process_instruction);

/// Anchor discriminator of LaunchLab's `claim_platform_fee_from_vault`.
const CLAIM_PLATFORM_FEE_FROM_VAULT: [u8; 8] = [117, 241, 198, 168, 248, 218, 80, 29];

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let claimer = next_account_info(it)?;
    let fee_auth = next_account_info(it)?;
    let platform = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let recipient = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let launchpad = next_account_info(it)?;

    let (expected, bump) = Pubkey::find_program_address(&[b"claimer"], program_id);
    if expected != *claimer.key {
        msg!("claimer account is not this program's PDA");
        return Err(ProgramError::InvalidSeeds);
    }

    let ix = Instruction {
        program_id: *launchpad.key,
        accounts: vec![
            AccountMeta::new(*claimer.key, true),
            AccountMeta::new_readonly(*fee_auth.key, false),
            AccountMeta::new_readonly(*platform.key, false),
            AccountMeta::new(*vault.key, false),
            AccountMeta::new(*recipient.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*ata_program.key, false),
        ],
        data: CLAIM_PLATFORM_FEE_FROM_VAULT.to_vec(),
    };

    msg!("calling LaunchLab claim_platform_fee_from_vault as the PDA");
    invoke_signed(
        &ix,
        &[
            claimer.clone(),
            fee_auth.clone(),
            platform.clone(),
            vault.clone(),
            recipient.clone(),
            mint.clone(),
            token_program.clone(),
            system_program.clone(),
            ata_program.clone(),
            launchpad.clone(),
        ],
        &[&[b"claimer", &[bump]]],
    )
}
