//! Burnpad: per-token fee split, creator stream and (next milestone) burn vault on Raydium LaunchLab.
//!
//! Devnet only until audited. See docs/program-spec.md.

pub mod ids;
pub mod math;
pub mod processor;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entry {
    use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

    entrypoint!(process);

    fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}
