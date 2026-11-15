//! Fixed program IDs and every address this program derives, in one place.

use solana_program::{pubkey, pubkey::Pubkey};

pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

#[cfg(all(feature = "devnet", not(feature = "mainnet")))]
pub const LAUNCHLAB: Pubkey = pubkey!("DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6");
#[cfg(feature = "mainnet")]
pub const LAUNCHLAB: Pubkey = pubkey!("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");

/// Anchor discriminators of the two LaunchLab instructions this program calls.
pub const CREATE_PLATFORM_CONFIG: [u8; 8] = [176, 90, 196, 175, 253, 113, 220, 20];
pub const CLAIM_PLATFORM_FEE_FROM_VAULT: [u8; 8] = [117, 241, 198, 168, 248, 218, 80, 29];

pub fn config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config"], program_id)
}
pub fn authority_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"authority", mint.as_ref()], program_id)
}
pub fn launch_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"launch", mint.as_ref()], program_id)
}
pub fn stream_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"stream", mint.as_ref()], program_id)
}
pub fn vault_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", mint.as_ref()], program_id)
}

/// The associated token account of `owner` for wrapped SOL.
pub fn wsol_ata(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), WSOL.as_ref()], &ATA_PROGRAM).0
}

/// LaunchLab's curve pool for a token sold against wrapped SOL.
pub fn launchlab_pool(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool", mint.as_ref(), WSOL.as_ref()], &LAUNCHLAB).0
}
/// A LaunchLab platform config is derived from its admin.
pub fn launchlab_platform(admin: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"platform_config", admin.as_ref()], &LAUNCHLAB).0
}
pub fn launchlab_fee_auth() -> Pubkey {
    Pubkey::find_program_address(&[b"platform_fee_vault_auth_seed"], &LAUNCHLAB).0
}
pub fn launchlab_fee_vault(platform: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[platform.as_ref(), WSOL.as_ref()], &LAUNCHLAB).0
}
