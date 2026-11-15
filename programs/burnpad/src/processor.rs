//! Instruction handlers. Every account is checked against an address derived here, never trusted as passed.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use crate::ids::*;
use crate::math;
use crate::state::*;

/// The split is fixed for every token: 50% vault, 25% creator, 25% treasury.
pub const VAULT_BPS: u16 = 5000;
pub const CREATOR_BPS: u16 = 2500;
pub const TREASURY_BPS: u16 = 2500;

/// SOL moved to a token's authority address so it can pay rent for its LaunchLab platform config.
pub const AUTHORITY_FUND_LAMPORTS: u64 = 15_000_000;

#[repr(u32)]
pub enum Error {
    BadInstruction = 1,
    BadAccount,
    WrongOwner,
    NotSigner,
    AlreadyExists,
    Paused,
    NothingToDo,
    NotYet,
    NotCreator,
    BadString,
    Refused,
    NoPrice,
    OutOfBounds,
}
impl From<Error> for ProgramError {
    fn from(e: Error) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(Error::BadInstruction)?;
    match *tag {
        0 => initialize_config(program_id, accounts),
        1 => create_launch(program_id, accounts, rest),
        2 => harvest_fees(program_id, accounts),
        3 => mark_graduated(program_id, accounts),
        4 => claim_creator(program_id, accounts),
        5 => expire_creator(program_id, accounts),
        6 => set_pause(program_id, accounts, rest),
        7 => set_params(program_id, accounts, rest),
        8 => sell_to_vault(program_id, accounts, rest),
        _ => Err(Error::BadInstruction.into()),
    }
}

/* ---------- helpers ---------- */

fn require(cond: bool, e: Error) -> ProgramResult {
    if cond { Ok(()) } else { Err(e.into()) }
}
fn same(account: &AccountInfo, expected: &Pubkey) -> ProgramResult {
    require(account.key == expected, Error::BadAccount)
}
fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

fn load_launch(program_id: &Pubkey, ai: &AccountInfo) -> Result<Launch, ProgramError> {
    require(ai.owner == program_id, Error::WrongOwner)?;
    let launch = Launch::read(&ai.try_borrow_data()?).ok_or(Error::BadAccount)?;
    same(ai, &launch_pda(program_id, &Pubkey::new_from_array(launch.mint)).0)?;
    Ok(launch)
}
fn load_stream(program_id: &Pubkey, ai: &AccountInfo, mint: &Pubkey) -> Result<Stream, ProgramError> {
    require(ai.owner == program_id, Error::WrongOwner)?;
    same(ai, &stream_pda(program_id, mint).0)?;
    Ok(Stream::read(&ai.try_borrow_data()?).ok_or(Error::BadAccount)?)
}

/// Create an account at a program-derived address, even if someone has already sent it lamports.
fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    seeds: &[&[u8]],
    owner: &Pubkey,
) -> ProgramResult {
    require(account.owner == &system_program::ID && account.data_is_empty(), Error::AlreadyExists)?;
    let rent = Rent::get()?.minimum_balance(space);
    if account.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(payer.key, account.key, rent, space as u64, owner),
            &[payer.clone(), account.clone(), system.clone()],
            &[seeds],
        )
    } else {
        let missing = rent.saturating_sub(account.lamports());
        if missing > 0 {
            invoke(&system_instruction::transfer(payer.key, account.key, missing), &[payer.clone(), account.clone(), system.clone()])?;
        }
        invoke_signed(&system_instruction::allocate(account.key, space as u64), &[account.clone(), system.clone()], &[seeds])?;
        invoke_signed(&system_instruction::assign(account.key, owner), &[account.clone(), system.clone()], &[seeds])
    }
}

/// SPL token transfer signed by a program-derived owner.
fn token_transfer<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![AccountMeta::new(*from.key, false), AccountMeta::new(*to.key, false), AccountMeta::new_readonly(*owner.key, true)],
        data,
    };
    invoke_signed(&ix, &[from.clone(), to.clone(), owner.clone(), token_program.clone()], &[seeds])
}

fn wsol_amount(ai: &AccountInfo) -> Result<u64, ProgramError> {
    Ok(token_amount(&ai.try_borrow_data()?).ok_or(Error::BadAccount)?)
}

fn read_string(data: &[u8], at: &mut usize, max: usize) -> Result<Vec<u8>, ProgramError> {
    let len_bytes = data.get(*at..*at + 4).ok_or(Error::BadString)?;
    let len = u32::from_le_bytes(len_bytes.try_into().unwrap()) as usize;
    *at += 4;
    require(len <= max, Error::BadString)?;
    let bytes = data.get(*at..*at + len).ok_or(Error::BadString)?;
    *at += len;
    Ok(bytes.to_vec())
}
fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s);
}

/* ---------- 0: initialize_config ---------- */
/// Accounts: admin (signer, writable), config (writable), treasury, system program.
fn initialize_config(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin = next_account_info(it)?;
    let config = next_account_info(it)?;
    let treasury = next_account_info(it)?;
    let system = next_account_info(it)?;
    require(admin.is_signer, Error::NotSigner)?;
    let (expected, bump) = config_pda(program_id);
    same(config, &expected)?;
    create_pda(admin, config, system, CONFIG_LEN, &[b"config", &[bump]], program_id)?;
    Config { bump, admin: admin.key.to_bytes(), treasury: treasury.key.to_bytes(), paused: false, params: Params::DEFAULT }.write(&mut config.try_borrow_mut_data()?);
    msg!("config created");
    Ok(())
}

/* ---------- 1: create_launch ---------- */
/// Registers a token: its authority, its own LaunchLab platform config, and its launch, stream and vault records.
/// The client adds LaunchLab's own create-pool instruction after this one, using the platform address recorded here.
///
/// Accounts: creator (signer, writable), config, mint, launch (w), stream (w), vault (w), authority (w),
/// platform config (w), LaunchLab pool config (w), system program, LaunchLab program.
/// Data after the tag: fee_rate u64 (out of 1,000,000), then name, web, img as length-prefixed strings.
fn create_launch(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let creator = next_account_info(it)?;
    let config = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let launch = next_account_info(it)?;
    let stream = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let platform = next_account_info(it)?;
    let cp_config = next_account_info(it)?;
    let system = next_account_info(it)?;
    let launchlab = next_account_info(it)?;

    require(creator.is_signer, Error::NotSigner)?;
    require(config.owner == program_id, Error::WrongOwner)?;
    same(config, &config_pda(program_id).0)?;
    let cfg = Config::read(&config.try_borrow_data()?).ok_or(Error::BadAccount)?;
    require(!cfg.paused, Error::Paused)?;
    same(system, &system_program::ID)?;
    same(launchlab, &LAUNCHLAB)?;

    let (launch_key, launch_bump) = launch_pda(program_id, mint.key);
    let (stream_key, stream_bump) = stream_pda(program_id, mint.key);
    let (vault_key, vault_bump) = vault_pda(program_id, mint.key);
    let (authority_key, authority_bump) = authority_pda(program_id, mint.key);
    let platform_key = launchlab_platform(&authority_key);
    same(launch, &launch_key)?;
    same(stream, &stream_key)?;
    same(vault, &vault_key)?;
    same(authority, &authority_key)?;
    same(platform, &platform_key)?;

    if data.len() < 8 {
        return Err(Error::BadInstruction.into());
    }
    let fee_rate = u64::from_le_bytes(data[..8].try_into().unwrap());
    let mut at = 8;
    let name = read_string(data, &mut at, 64)?;
    let web = read_string(data, &mut at, 256)?;
    let img = read_string(data, &mut at, 256)?;

    // The program's own records.
    create_pda(creator, launch, system, LAUNCH_LEN, &[b"launch", mint.key.as_ref(), &[launch_bump]], program_id)?;
    create_pda(creator, stream, system, STREAM_LEN, &[b"stream", mint.key.as_ref(), &[stream_bump]], program_id)?;
    create_pda(creator, vault, system, VAULT_LEN, &[b"vault", mint.key.as_ref(), &[vault_bump]], program_id)?;
    Launch {
        bump: launch_bump,
        mint: mint.key.to_bytes(),
        creator: creator.key.to_bytes(),
        launched_at: now()?,
        graduated_at: 0,
        pool: launchlab_pool(mint.key).to_bytes(),
        platform: platform_key.to_bytes(),
        vault_bps: VAULT_BPS,
        creator_bps: CREATOR_BPS,
        treasury_bps: TREASURY_BPS,
        expired: false,
        total_harvested: 0,
        cpmm_pool: [0u8; 32],
    }
    .write(&mut launch.try_borrow_mut_data()?);
    Stream { bump: stream_bump, total_received: 0, claimed: 0, vest_start: 0 }.write(&mut stream.try_borrow_mut_data()?);
    Vault::new(vault_bump, cfg.params).write(&mut vault.try_borrow_mut_data()?);

    // The token's own LaunchLab platform: this program's authority address is its admin and fee wallet.
    invoke(&system_instruction::transfer(creator.key, authority.key, AUTHORITY_FUND_LAMPORTS), &[creator.clone(), authority.clone(), system.clone()])?;

    let mut ix_data = CREATE_PLATFORM_CONFIG.to_vec();
    ix_data.extend_from_slice(&1_000_000u64.to_le_bytes()); // platform keeps all locked-LP fee rights
    ix_data.extend_from_slice(&0u64.to_le_bytes()); // creator share of LP fees
    ix_data.extend_from_slice(&0u64.to_le_bytes()); // burned share of LP
    ix_data.extend_from_slice(&fee_rate.to_le_bytes());
    put_string(&mut ix_data, &name);
    put_string(&mut ix_data, &web);
    put_string(&mut ix_data, &img);
    ix_data.extend_from_slice(&0u64.to_le_bytes()); // LaunchLab creator fee: this program pays the creator itself
    ix_data.extend_from_slice(&0u64.to_le_bytes()); // platform vesting scale
    let ix = Instruction {
        program_id: LAUNCHLAB,
        accounts: vec![
            AccountMeta::new(authority_key, true),
            AccountMeta::new_readonly(authority_key, false), // claim fee wallet
            AccountMeta::new_readonly(authority_key, false), // lock NFT wallet
            AccountMeta::new(platform_key, false),
            AccountMeta::new(*cp_config.key, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(authority_key, false), // transfer-fee extension authority
            AccountMeta::new_readonly(authority_key, false), // vesting wallet
        ],
        data: ix_data,
    };
    invoke_signed(
        &ix,
        &[authority.clone(), platform.clone(), cp_config.clone(), system.clone(), launchlab.clone()],
        &[&[b"authority", mint.key.as_ref(), &[authority_bump]]],
    )?;
    msg!("launch created");
    Ok(())
}

/* ---------- 2: harvest_fees ---------- */
/// Anyone can call. Claims the token's platform fees and splits them by the recorded split.
///
/// Accounts: launch (w), stream (w), config, authority (w), platform, LaunchLab fee-vault authority,
/// LaunchLab fee vault (w), authority WSOL account (w), WSOL mint, token program, system program,
/// associated token program, LaunchLab program, vault WSOL account (w), stream WSOL account (w), treasury WSOL account (w).
fn harvest_fees(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let launch_ai = next_account_info(it)?;
    let stream_ai = next_account_info(it)?;
    let config = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let platform = next_account_info(it)?;
    let fee_auth = next_account_info(it)?;
    let fee_vault = next_account_info(it)?;
    let authority_wsol = next_account_info(it)?;
    let wsol_mint = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let launchlab = next_account_info(it)?;
    let vault_wsol = next_account_info(it)?;
    let stream_wsol = next_account_info(it)?;
    let treasury_wsol = next_account_info(it)?;

    let mut launch = load_launch(program_id, launch_ai)?;
    let mint = Pubkey::new_from_array(launch.mint);
    let mut stream = load_stream(program_id, stream_ai, &mint)?;
    require(config.owner == program_id, Error::WrongOwner)?;
    same(config, &config_pda(program_id).0)?;
    let cfg = Config::read(&config.try_borrow_data()?).ok_or(Error::BadAccount)?;

    let (authority_key, authority_bump) = authority_pda(program_id, &mint);
    let platform_key = Pubkey::new_from_array(launch.platform);
    same(authority, &authority_key)?;
    same(platform, &platform_key)?;
    same(fee_auth, &launchlab_fee_auth())?;
    same(fee_vault, &launchlab_fee_vault(&platform_key))?;
    same(authority_wsol, &wsol_ata(&authority_key))?;
    same(wsol_mint, &WSOL)?;
    same(token_program, &TOKEN_PROGRAM)?;
    same(system, &system_program::ID)?;
    same(ata_program, &ATA_PROGRAM)?;
    same(launchlab, &LAUNCHLAB)?;
    same(vault_wsol, &wsol_ata(&vault_pda(program_id, &mint).0))?;
    same(stream_wsol, &wsol_ata(&stream_pda(program_id, &mint).0))?;
    same(treasury_wsol, &wsol_ata(&Pubkey::new_from_array(cfg.treasury)))?;

    let signer_seeds: &[&[u8]] = &[b"authority", mint.as_ref(), &[authority_bump]];

    // Pull the fees from LaunchLab into the authority's wrapped-SOL account, signing as the authority.
    let claim = Instruction {
        program_id: LAUNCHLAB,
        accounts: vec![
            AccountMeta::new(authority_key, true),
            AccountMeta::new_readonly(*fee_auth.key, false),
            AccountMeta::new_readonly(platform_key, false),
            AccountMeta::new(*fee_vault.key, false),
            AccountMeta::new(*authority_wsol.key, false),
            AccountMeta::new_readonly(WSOL, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
        data: CLAIM_PLATFORM_FEE_FROM_VAULT.to_vec(),
    };
    invoke_signed(
        &claim,
        &[
            authority.clone(),
            fee_auth.clone(),
            platform.clone(),
            fee_vault.clone(),
            authority_wsol.clone(),
            wsol_mint.clone(),
            token_program.clone(),
            system.clone(),
            ata_program.clone(),
            launchlab.clone(),
        ],
        &[signer_seeds],
    )?;

    // The authority's wrapped-SOL account holds only fees, so its whole balance is this harvest.
    let amount = wsol_amount(authority_wsol)?;
    require(amount > 0, Error::NothingToDo)?;
    let (vault_share, creator_share, treasury_share) = math::split(amount, launch.creator_bps, launch.treasury_bps, launch.expired);

    token_transfer(token_program, authority_wsol, vault_wsol, authority, vault_share, signer_seeds)?;
    token_transfer(token_program, authority_wsol, stream_wsol, authority, creator_share, signer_seeds)?;
    token_transfer(token_program, authority_wsol, treasury_wsol, authority, treasury_share, signer_seeds)?;

    stream.total_received = stream.total_received.checked_add(creator_share).ok_or(ProgramError::ArithmeticOverflow)?;
    launch.total_harvested = launch.total_harvested.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
    stream.write(&mut stream_ai.try_borrow_mut_data()?);
    launch.write(&mut launch_ai.try_borrow_mut_data()?);
    msg!("harvested {} (vault {}, creator {}, treasury {})", amount, vault_share, creator_share, treasury_share);
    Ok(())
}

/* ---------- 3: mark_graduated ---------- */
/// Anyone can call once LaunchLab has migrated the token. Records the Raydium pool and starts the creator's vesting.
/// Accounts: launch (w), stream (w), LaunchLab curve pool, platform config, Raydium CPMM pool.
fn mark_graduated(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let launch_ai = next_account_info(it)?;
    let stream_ai = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let platform = next_account_info(it)?;
    let cpmm = next_account_info(it)?;

    let mut launch = load_launch(program_id, launch_ai)?;
    let mint = Pubkey::new_from_array(launch.mint);
    let mut stream = load_stream(program_id, stream_ai, &mint)?;
    require(launch.graduated_at == 0, Error::AlreadyExists)?;
    require(!launch.expired, Error::NotYet)?;
    same(pool, &Pubkey::new_from_array(launch.pool))?;
    same(platform, &Pubkey::new_from_array(launch.platform))?;
    require(pool.owner == &LAUNCHLAB && platform.owner == &LAUNCHLAB, Error::WrongOwner)?;
    require(launchlab_status(&pool.try_borrow_data()?) == Some(2), Error::NotYet)?;

    // The Raydium pool is derived from the platform's pool config and the two mints, then checked against its own fields.
    let cp_config = platform_cp_config(&platform.try_borrow_data()?).ok_or(Error::BadAccount)?;
    same(cpmm, &cpmm_pool(&Pubkey::new_from_array(cp_config), &mint))?;
    require(cpmm.owner == &CPMM, Error::WrongOwner)?;
    {
        let p = CpmmPool::read(&cpmm.try_borrow_data()?).ok_or(Error::BadAccount)?;
        let ok = (p.mint_a == mint.to_bytes() && p.mint_b == WSOL.to_bytes()) || (p.mint_b == mint.to_bytes() && p.mint_a == WSOL.to_bytes());
        require(ok, Error::BadAccount)?;
    }

    let t = now()?;
    launch.graduated_at = t;
    launch.cpmm_pool = cpmm.key.to_bytes();
    stream.vest_start = t;
    launch.write(&mut launch_ai.try_borrow_mut_data()?);
    stream.write(&mut stream_ai.try_borrow_mut_data()?);
    msg!("graduated; creator vesting starts");
    Ok(())
}

/* ---------- 4: claim_creator ---------- */
/// The creator takes whatever has vested. Paid as wrapped SOL, which the wallet can unwrap.
/// Accounts: creator (signer), launch, stream (w), stream WSOL account (w), creator WSOL account (w), token program.
fn claim_creator(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let creator = next_account_info(it)?;
    let launch_ai = next_account_info(it)?;
    let stream_ai = next_account_info(it)?;
    let stream_wsol = next_account_info(it)?;
    let creator_wsol = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    require(creator.is_signer, Error::NotSigner)?;
    let launch = load_launch(program_id, launch_ai)?;
    require(launch.creator == creator.key.to_bytes(), Error::NotCreator)?;
    let mint = Pubkey::new_from_array(launch.mint);
    let (stream_key, stream_bump) = stream_pda(program_id, &mint);
    let mut stream = load_stream(program_id, stream_ai, &mint)?;
    same(stream_wsol, &wsol_ata(&stream_key))?;
    same(token_program, &TOKEN_PROGRAM)?;
    require(creator_wsol.owner == &TOKEN_PROGRAM, Error::WrongOwner)?;
    {
        let d = creator_wsol.try_borrow_data()?;
        require(token_mint(&d) == Some(WSOL.to_bytes()) && token_owner(&d) == Some(creator.key.to_bytes()), Error::BadAccount)?;
    }
    require(launch.graduated_at != 0 && !launch.expired, Error::NotYet)?;

    let due = math::claimable(stream.total_received, stream.claimed, stream.vest_start, now()?, math::THIRTY_DAYS);
    require(due > 0, Error::NothingToDo)?;
    token_transfer(token_program, stream_wsol, creator_wsol, stream_ai, due, &[b"stream", mint.as_ref(), &[stream_bump]])?;
    stream.claimed += due;
    stream.write(&mut stream_ai.try_borrow_mut_data()?);
    msg!("creator claimed {}", due);
    Ok(())
}

/* ---------- 5: expire_creator ---------- */
/// Anyone can call 30 days after launch if the token has not graduated. The creator's balance moves to the vault.
/// Accounts: launch (w), stream, stream WSOL account (w), vault WSOL account (w), token program.
fn expire_creator(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let launch_ai = next_account_info(it)?;
    let stream_ai = next_account_info(it)?;
    let stream_wsol = next_account_info(it)?;
    let vault_wsol = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    let mut launch = load_launch(program_id, launch_ai)?;
    let mint = Pubkey::new_from_array(launch.mint);
    let (stream_key, stream_bump) = stream_pda(program_id, &mint);
    let _ = load_stream(program_id, stream_ai, &mint)?;
    same(stream_wsol, &wsol_ata(&stream_key))?;
    same(vault_wsol, &wsol_ata(&vault_pda(program_id, &mint).0))?;
    same(token_program, &TOKEN_PROGRAM)?;
    require(launch.graduated_at == 0 && !launch.expired, Error::NotYet)?;
    require(now()? >= launch.launched_at + math::THIRTY_DAYS, Error::NotYet)?;

    let balance = wsol_amount(stream_wsol)?;
    token_transfer(token_program, stream_wsol, vault_wsol, stream_ai, balance, &[b"stream", mint.as_ref(), &[stream_bump]])?;
    launch.expired = true;
    launch.write(&mut launch_ai.try_borrow_mut_data()?);
    msg!("creator stream expired; {} moved to the vault", balance);
    Ok(())
}

/* ---------- 6: set_pause ---------- */
/// Admin only. Pauses or resumes new launches and all vault sells. Never blocks harvests or creator claims.
/// Accounts: admin (signer), config (w). Data: one byte, 1 to pause.
fn set_pause(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin = next_account_info(it)?;
    let config = next_account_info(it)?;
    let mut cfg = load_config_admin(program_id, admin, config)?;
    cfg.paused = *data.first().ok_or(Error::BadInstruction)? != 0;
    cfg.write(&mut config.try_borrow_mut_data()?);
    Ok(())
}

fn load_config_admin(program_id: &Pubkey, admin: &AccountInfo, config: &AccountInfo) -> Result<Config, ProgramError> {
    require(admin.is_signer, Error::NotSigner)?;
    require(config.owner == program_id, Error::WrongOwner)?;
    same(config, &config_pda(program_id).0)?;
    let cfg = Config::read(&config.try_borrow_data()?).ok_or(Error::BadAccount)?;
    require(cfg.admin == admin.key.to_bytes(), Error::NotCreator)?;
    Ok(cfg)
}

/* ---------- 7: set_params ---------- */
/// Admin only. Sets the defaults that new tokens' vaults copy. A token's own vault never changes after launch.
/// Accounts: admin (signer), config (w).
/// Data: discount_bps u16, max_sale_bps u16, daily_bps u16, guard_bps u16, twap_window u32, reserve u64.
fn set_params(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let admin = next_account_info(it)?;
    let config = next_account_info(it)?;
    let mut cfg = load_config_admin(program_id, admin, config)?;
    require(data.len() >= 20, Error::BadInstruction)?;
    let p = Params {
        discount_bps: u16::from_le_bytes(data[0..2].try_into().unwrap()),
        max_sale_bps: u16::from_le_bytes(data[2..4].try_into().unwrap()),
        daily_bps: u16::from_le_bytes(data[4..6].try_into().unwrap()),
        guard_bps: u16::from_le_bytes(data[6..8].try_into().unwrap()),
        twap_window: u32::from_le_bytes(data[8..12].try_into().unwrap()),
        reserve: u64::from_le_bytes(data[12..20].try_into().unwrap()),
    };
    // Hard bounds the admin cannot step outside. Devnet allows a short window and no reserve, so tests can run quickly.
    #[cfg(feature = "mainnet")]
    let (win_min, reserve_min) = (600u32, 50_000_000u64);
    #[cfg(not(feature = "mainnet"))]
    let (win_min, reserve_min) = (60u32, 0u64);
    let ok = (200..=2000).contains(&p.discount_bps)
        && (50..=500).contains(&p.max_sale_bps)
        && (200..=2500).contains(&p.daily_bps)
        && (500..=2500).contains(&p.guard_bps)
        && (win_min..=3600).contains(&p.twap_window)
        && (reserve_min..=1_000_000_000).contains(&p.reserve);
    require(ok, Error::OutOfBounds)?;
    cfg.params = p;
    cfg.write(&mut config.try_borrow_mut_data()?);
    Ok(())
}

/* ---------- 8: sell_to_vault ---------- */
/// A holder sells tokens to the token's burn vault at a discount to the lower of TWAP and spot. The vault pays
/// wrapped SOL and the tokens are burned in the same instruction.
///
/// Accounts: holder (signer), launch, vault (w), config, Raydium pool, pool vault A, pool vault B, observation,
/// token mint (w), holder token account (w), holder WSOL account (w), vault WSOL account (w), token program.
/// Data: tokens u64, min_sol_out u64.
fn sell_to_vault(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let holder = next_account_info(it)?;
    let launch_ai = next_account_info(it)?;
    let vault_ai = next_account_info(it)?;
    let config = next_account_info(it)?;
    let pool_ai = next_account_info(it)?;
    let pool_vault_a = next_account_info(it)?;
    let pool_vault_b = next_account_info(it)?;
    let observation = next_account_info(it)?;
    let mint_ai = next_account_info(it)?;
    let holder_tokens = next_account_info(it)?;
    let holder_wsol = next_account_info(it)?;
    let vault_wsol = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    require(holder.is_signer, Error::NotSigner)?;
    require(data.len() >= 16, Error::BadInstruction)?;
    let tokens = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let min_out = u64::from_le_bytes(data[8..16].try_into().unwrap());

    let launch = load_launch(program_id, launch_ai)?;
    let mint = Pubkey::new_from_array(launch.mint);
    require(launch.graduated_at != 0, Error::NotYet)?;
    same(mint_ai, &mint)?;
    require(mint_ai.owner == &TOKEN_PROGRAM, Error::WrongOwner)?;
    same(token_program, &TOKEN_PROGRAM)?;

    require(config.owner == program_id, Error::WrongOwner)?;
    same(config, &config_pda(program_id).0)?;
    require(!Config::read(&config.try_borrow_data()?).ok_or(Error::BadAccount)?.paused, Error::Paused)?;

    let (vault_key, vault_bump) = vault_pda(program_id, &mint);
    same(vault_ai, &vault_key)?;
    require(vault_ai.owner == program_id, Error::WrongOwner)?;
    let mut vault = Vault::read(&vault_ai.try_borrow_data()?).ok_or(Error::BadAccount)?;
    require(!vault.paused, Error::Paused)?;
    same(vault_wsol, &wsol_ata(&vault_key))?;
    require(holder_wsol.owner == &TOKEN_PROGRAM, Error::WrongOwner)?;
    require(token_mint(&holder_wsol.try_borrow_data()?) == Some(WSOL.to_bytes()), Error::BadAccount)?;

    // Read the pool: which side is the token, and the real reserves (vault balances less fees owed).
    same(pool_ai, &Pubkey::new_from_array(launch.cpmm_pool))?;
    require(pool_ai.owner == &CPMM, Error::WrongOwner)?;
    let pool = CpmmPool::read(&pool_ai.try_borrow_data()?).ok_or(Error::BadAccount)?;
    same(pool_vault_a, &Pubkey::new_from_array(pool.vault_a))?;
    same(pool_vault_b, &Pubkey::new_from_array(pool.vault_b))?;
    same(observation, &Pubkey::new_from_array(pool.observation))?;
    let token_is_a = pool.mint_a == mint.to_bytes();
    require(token_is_a || pool.mint_b == mint.to_bytes(), Error::BadAccount)?;
    let reserve_a = wsol_amount(pool_vault_a)?.saturating_sub(pool.fees_a);
    let reserve_b = wsol_amount(pool_vault_b)?.saturating_sub(pool.fees_b);
    let (token_reserve, sol_reserve) = if token_is_a { (reserve_a, reserve_b) } else { (reserve_b, reserve_a) };
    let spot = math::spot_x32(sol_reserve, token_reserve).ok_or(Error::NoPrice)?;

    // Time-weighted price from the pool's own observation account.
    let t = now()?;
    let samples = observations(&observation.try_borrow_data()?, token_is_a).ok_or(Error::BadAccount)?;
    let obs: Vec<math::Obs> = samples.iter().map(|(ts, cum)| math::Obs { ts: *ts, cum: *cum }).collect();
    let twap = math::twap_x32(&obs, t as u64, vault.params.twap_window as u64, spot).ok_or(Error::NoPrice)?;
    require(math::within_guard(spot, twap, vault.params.guard_bps), Error::Refused)?;

    let payment = math::bid(tokens, spot, twap, vault.params.discount_bps);
    require(payment >= min_out, Error::Refused)?;

    // Spending limits, with the 24-hour window rolled over if it has expired.
    let balance = wsol_amount(vault_wsol)?;
    if vault.window_start == 0 || t - vault.window_start >= math::DAY {
        vault.window_start = t;
        vault.window_start_balance = balance;
        vault.window_spent = 0;
    }
    let p = vault.params;
    math::check_limits(payment, balance, p.reserve, p.max_sale_bps, vault.window_start_balance, vault.window_spent, p.daily_bps).map_err(|_| Error::Refused)?;

    // Pay the holder from the vault, then burn the holder's tokens. Both happen or neither does.
    token_transfer(token_program, vault_wsol, holder_wsol, vault_ai, payment, &[b"vault", mint.as_ref(), &[vault_bump]])?;
    let mut burn = vec![8u8];
    burn.extend_from_slice(&tokens.to_le_bytes());
    let burn_ix = Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![AccountMeta::new(*holder_tokens.key, false), AccountMeta::new(*mint_ai.key, false), AccountMeta::new_readonly(*holder.key, true)],
        data: burn,
    };
    invoke(&burn_ix, &[holder_tokens.clone(), mint_ai.clone(), holder.clone(), token_program.clone()])?;

    vault.window_spent += payment;
    vault.tokens_burned = vault.tokens_burned.saturating_add(tokens);
    vault.total_paid = vault.total_paid.saturating_add(payment);
    vault.write(&mut vault_ai.try_borrow_mut_data()?);
    msg!("burned {} tokens for {} lamports", tokens, payment);
    Ok(())
}
