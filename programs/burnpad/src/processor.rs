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
    Config { bump, admin: admin.key.to_bytes(), treasury: treasury.key.to_bytes(), paused: false }.write(&mut config.try_borrow_mut_data()?);
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
    require(!Config::read(&config.try_borrow_data()?).ok_or(Error::BadAccount)?.paused, Error::Paused)?;
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
    }
    .write(&mut launch.try_borrow_mut_data()?);
    Stream { bump: stream_bump, total_received: 0, claimed: 0, vest_start: 0 }.write(&mut stream.try_borrow_mut_data()?);
    Vault { bump: vault_bump }.write(&mut vault.try_borrow_mut_data()?);

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
/// Accounts: launch (w), stream (w), config, authority, platform, LaunchLab fee-vault authority,
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
/// Anyone can call once LaunchLab has migrated the token. Starts the creator's vesting.
/// Accounts: launch (w), stream (w), LaunchLab curve pool.
fn mark_graduated(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let launch_ai = next_account_info(it)?;
    let stream_ai = next_account_info(it)?;
    let pool = next_account_info(it)?;

    let mut launch = load_launch(program_id, launch_ai)?;
    let mint = Pubkey::new_from_array(launch.mint);
    let mut stream = load_stream(program_id, stream_ai, &mint)?;
    require(launch.graduated_at == 0, Error::AlreadyExists)?;
    require(!launch.expired, Error::NotYet)?;
    same(pool, &Pubkey::new_from_array(launch.pool))?;
    require(pool.owner == &LAUNCHLAB, Error::WrongOwner)?;
    require(launchlab_status(&pool.try_borrow_data()?) == Some(2), Error::NotYet)?;

    let t = now()?;
    launch.graduated_at = t;
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
