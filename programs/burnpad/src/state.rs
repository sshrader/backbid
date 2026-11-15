//! Account layouts as plain little-endian bytes. No Solana types, so they can be tested anywhere.
//! Every account starts with a one-byte tag so one account type is never read as another.

pub type Key = [u8; 32];

pub const TAG_CONFIG: u8 = 1;
pub const TAG_LAUNCH: u8 = 2;
pub const TAG_STREAM: u8 = 3;
pub const TAG_VAULT: u8 = 4;

pub const CONFIG_LEN: usize = 87;
pub const LAUNCH_LEN: usize = 193;
pub const STREAM_LEN: usize = 26;
pub const VAULT_LEN: usize = 128; // room reserved for the burn-vault fields added in the next milestone

fn put(buf: &mut [u8], at: usize, bytes: &[u8]) {
    buf[at..at + bytes.len()].copy_from_slice(bytes);
}
fn key(buf: &[u8], at: usize) -> Key {
    let mut k = [0u8; 32];
    k.copy_from_slice(&buf[at..at + 32]);
    k
}
fn u64_at(buf: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(buf[at..at + 8].try_into().unwrap())
}
fn i64_at(buf: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(buf[at..at + 8].try_into().unwrap())
}
fn u16_at(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(buf[at..at + 2].try_into().unwrap())
}

/// Defaults copied into each new token's vault. Layout: tag, bump, admin(32), treasury(32), paused,
/// discount_bps(2), max_sale_bps(2), daily_bps(2), guard_bps(2), twap_window(4), reserve(8).
#[derive(Debug, PartialEq, Clone)]
pub struct Config {
    pub bump: u8,
    pub admin: Key,
    pub treasury: Key,
    pub paused: bool,
    pub params: Params,
}

/// Vault parameters. Copied from the config when a token launches and fixed for that token after.
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct Params {
    pub discount_bps: u16,
    pub max_sale_bps: u16,
    pub daily_bps: u16,
    pub guard_bps: u16,
    pub twap_window: u32,
    pub reserve: u64,
}
impl Params {
    pub const DEFAULT: Params = Params { discount_bps: 750, max_sale_bps: 200, daily_bps: 1000, guard_bps: 1500, twap_window: 1200, reserve: 100_000_000 };
}
impl Config {
    pub fn write(&self, buf: &mut [u8]) {
        buf[0] = TAG_CONFIG;
        buf[1] = self.bump;
        put(buf, 2, &self.admin);
        put(buf, 34, &self.treasury);
        buf[66] = self.paused as u8;
        put(buf, 67, &self.params.discount_bps.to_le_bytes());
        put(buf, 69, &self.params.max_sale_bps.to_le_bytes());
        put(buf, 71, &self.params.daily_bps.to_le_bytes());
        put(buf, 73, &self.params.guard_bps.to_le_bytes());
        put(buf, 75, &self.params.twap_window.to_le_bytes());
        put(buf, 79, &self.params.reserve.to_le_bytes());
    }
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < CONFIG_LEN || buf[0] != TAG_CONFIG {
            return None;
        }
        Some(Self {
            bump: buf[1],
            admin: key(buf, 2),
            treasury: key(buf, 34),
            paused: buf[66] != 0,
            params: Params {
                discount_bps: u16_at(buf, 67),
                max_sale_bps: u16_at(buf, 69),
                daily_bps: u16_at(buf, 71),
                guard_bps: u16_at(buf, 73),
                twap_window: u32::from_le_bytes(buf[75..79].try_into().unwrap()),
                reserve: u64_at(buf, 79),
            },
        })
    }
}

/// One per token. Layout: tag, bump, mint(32), creator(32), launched_at(8), graduated_at(8), pool(32),
/// platform(32), vault_bps(2), creator_bps(2), treasury_bps(2), expired, total_harvested(8), cpmm_pool(32).
#[derive(Debug, PartialEq, Clone)]
pub struct Launch {
    pub bump: u8,
    pub mint: Key,
    pub creator: Key,
    pub launched_at: i64,
    pub graduated_at: i64, // 0 until graduation
    pub pool: Key,         // the LaunchLab curve pool
    pub platform: Key,     // this token's LaunchLab platform config
    pub vault_bps: u16,
    pub creator_bps: u16,
    pub treasury_bps: u16,
    pub expired: bool,
    pub total_harvested: u64,
    pub cpmm_pool: Key, // the Raydium pool after graduation; zeros before
}
impl Launch {
    pub fn write(&self, buf: &mut [u8]) {
        buf[0] = TAG_LAUNCH;
        buf[1] = self.bump;
        put(buf, 2, &self.mint);
        put(buf, 34, &self.creator);
        put(buf, 66, &self.launched_at.to_le_bytes());
        put(buf, 74, &self.graduated_at.to_le_bytes());
        put(buf, 82, &self.pool);
        put(buf, 114, &self.platform);
        put(buf, 146, &self.vault_bps.to_le_bytes());
        put(buf, 148, &self.creator_bps.to_le_bytes());
        put(buf, 150, &self.treasury_bps.to_le_bytes());
        buf[152] = self.expired as u8;
        put(buf, 153, &self.total_harvested.to_le_bytes());
        put(buf, 161, &self.cpmm_pool);
    }
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < LAUNCH_LEN || buf[0] != TAG_LAUNCH {
            return None;
        }
        Some(Self {
            bump: buf[1],
            mint: key(buf, 2),
            creator: key(buf, 34),
            launched_at: i64_at(buf, 66),
            graduated_at: i64_at(buf, 74),
            pool: key(buf, 82),
            platform: key(buf, 114),
            vault_bps: u16_at(buf, 146),
            creator_bps: u16_at(buf, 148),
            treasury_bps: u16_at(buf, 150),
            expired: buf[152] != 0,
            total_harvested: u64_at(buf, 153),
            cpmm_pool: key(buf, 161),
        })
    }
}

/// One per token. Layout: tag, bump, total_received(8), claimed(8), vest_start(8), 0 padding byte.
#[derive(Debug, PartialEq, Clone)]
pub struct Stream {
    pub bump: u8,
    pub total_received: u64, // everything ever credited to the creator's stream
    pub claimed: u64,
    pub vest_start: i64, // 0 until graduation
}
impl Stream {
    pub fn write(&self, buf: &mut [u8]) {
        buf[0] = TAG_STREAM;
        buf[1] = self.bump;
        put(buf, 2, &self.total_received.to_le_bytes());
        put(buf, 10, &self.claimed.to_le_bytes());
        put(buf, 18, &self.vest_start.to_le_bytes());
    }
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < STREAM_LEN || buf[0] != TAG_STREAM {
            return None;
        }
        Some(Self { bump: buf[1], total_received: u64_at(buf, 2), claimed: u64_at(buf, 10), vest_start: i64_at(buf, 18) })
    }
}

/// Burn vault. Layout: tag, bump, params (discount, max_sale, daily, guard: 2 each; twap_window 4; reserve 8),
/// window_start(8), window_start_balance(8), window_spent(8), tokens_burned(8), total_paid(8), paused.
#[derive(Debug, PartialEq, Clone)]
pub struct Vault {
    pub bump: u8,
    pub params: Params,
    pub window_start: i64,
    pub window_start_balance: u64,
    pub window_spent: u64,
    pub tokens_burned: u64,
    pub total_paid: u64,
    pub paused: bool,
}
impl Vault {
    pub fn new(bump: u8, params: Params) -> Self {
        Self { bump, params, window_start: 0, window_start_balance: 0, window_spent: 0, tokens_burned: 0, total_paid: 0, paused: false }
    }
    pub fn write(&self, buf: &mut [u8]) {
        buf[0] = TAG_VAULT;
        buf[1] = self.bump;
        put(buf, 2, &self.params.discount_bps.to_le_bytes());
        put(buf, 4, &self.params.max_sale_bps.to_le_bytes());
        put(buf, 6, &self.params.daily_bps.to_le_bytes());
        put(buf, 8, &self.params.guard_bps.to_le_bytes());
        put(buf, 10, &self.params.twap_window.to_le_bytes());
        put(buf, 14, &self.params.reserve.to_le_bytes());
        put(buf, 22, &self.window_start.to_le_bytes());
        put(buf, 30, &self.window_start_balance.to_le_bytes());
        put(buf, 38, &self.window_spent.to_le_bytes());
        put(buf, 46, &self.tokens_burned.to_le_bytes());
        put(buf, 54, &self.total_paid.to_le_bytes());
        buf[62] = self.paused as u8;
    }
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < VAULT_LEN || buf[0] != TAG_VAULT {
            return None;
        }
        Some(Self {
            bump: buf[1],
            params: Params {
                discount_bps: u16_at(buf, 2),
                max_sale_bps: u16_at(buf, 4),
                daily_bps: u16_at(buf, 6),
                guard_bps: u16_at(buf, 8),
                twap_window: u32::from_le_bytes(buf[10..14].try_into().unwrap()),
                reserve: u64_at(buf, 14),
            },
            window_start: i64_at(buf, 22),
            window_start_balance: u64_at(buf, 30),
            window_spent: u64_at(buf, 38),
            tokens_burned: u64_at(buf, 46),
            total_paid: u64_at(buf, 54),
            paused: buf[62] != 0,
        })
    }
}

/// Fields of a Raydium CPMM pool account that the vault needs. Offsets follow the SDK's CpmmPoolInfoLayout
/// (8-byte discriminator, then packed fields).
#[derive(Debug, PartialEq, Clone)]
pub struct CpmmPool {
    pub vault_a: Key,
    pub vault_b: Key,
    pub mint_a: Key,
    pub mint_b: Key,
    pub observation: Key,
    pub fees_a: u64, // protocol + fund + creator fees owed out of vault A, which are not trading reserves
    pub fees_b: u64,
}
pub const CPMM_POOL_MIN_LEN: usize = 413;
impl CpmmPool {
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < CPMM_POOL_MIN_LEN {
            return None;
        }
        Some(Self {
            vault_a: key(buf, 72),
            vault_b: key(buf, 104),
            mint_a: key(buf, 168),
            mint_b: key(buf, 200),
            observation: key(buf, 296),
            fees_a: u64_at(buf, 341).saturating_add(u64_at(buf, 357)).saturating_add(u64_at(buf, 397)),
            fees_b: u64_at(buf, 349).saturating_add(u64_at(buf, 365)).saturating_add(u64_at(buf, 405)),
        })
    }
}

/// The platform config's CPMM config address (LaunchLab layout: after name, web and img).
pub fn platform_cp_config(buf: &[u8]) -> Option<Key> {
    if buf.len() < 720 { None } else { Some(key(buf, 688)) }
}

/// Samples from a CPMM observation account: timestamp and the cumulative price of one side.
/// Layout: 8-byte discriminator, initialized(1), index(2), pool(32), then 100 x [ts u64, cum0 u128, cum1 u128].
pub fn observations(buf: &[u8], token_is_a: bool) -> Option<Vec<(u64, u128)>> {
    if buf.len() < 43 + 100 * 40 {
        return None;
    }
    let mut out = Vec::with_capacity(100);
    for i in 0..100 {
        let at = 43 + i * 40;
        let ts = u64_at(buf, at);
        let cum0 = u128::from_le_bytes(buf[at + 8..at + 24].try_into().unwrap());
        let cum1 = u128::from_le_bytes(buf[at + 24..at + 40].try_into().unwrap());
        out.push((ts, if token_is_a { cum0 } else { cum1 }));
    }
    Some(out)
}

/// Read the amount and the owner/mint of an SPL token account without pulling in the token crate.
pub fn token_mint(buf: &[u8]) -> Option<Key> {
    if buf.len() < 165 { None } else { Some(key(buf, 0)) }
}
pub fn token_owner(buf: &[u8]) -> Option<Key> {
    if buf.len() < 165 { None } else { Some(key(buf, 32)) }
}
pub fn token_amount(buf: &[u8]) -> Option<u64> {
    if buf.len() < 165 { None } else { Some(u64_at(buf, 64)) }
}

/// Status byte of a LaunchLab pool account: 0 on the curve, 1 target reached, 2 migrated.
pub fn launchlab_status(buf: &[u8]) -> Option<u8> {
    if buf.len() < 18 { None } else { Some(buf[17]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips() {
        let c = Config { bump: 254, admin: [1; 32], treasury: [2; 32], paused: true, params: Params::DEFAULT };
        let mut b = vec![0u8; CONFIG_LEN];
        c.write(&mut b);
        assert_eq!(Config::read(&b), Some(c));
    }

    #[test]
    fn launch_round_trips() {
        let l = Launch {
            bump: 253,
            mint: [3; 32],
            creator: [4; 32],
            launched_at: 1_700_000_000,
            graduated_at: 1_700_001_234,
            pool: [5; 32],
            platform: [6; 32],
            vault_bps: 5000,
            creator_bps: 2500,
            treasury_bps: 2500,
            expired: true,
            total_harvested: u64::MAX - 7,
            cpmm_pool: [9; 32],
        };
        let mut b = vec![0u8; LAUNCH_LEN];
        l.write(&mut b);
        assert_eq!(Launch::read(&b), Some(l));
    }

    #[test]
    fn stream_round_trips() {
        let s = Stream { bump: 1, total_received: 123456789, claimed: 42, vest_start: -5 };
        let mut b = vec![0u8; STREAM_LEN];
        s.write(&mut b);
        assert_eq!(Stream::read(&b), Some(s));
    }

    #[test]
    fn wrong_tag_or_short_buffer_is_rejected() {
        let mut b = vec![0u8; LAUNCH_LEN];
        Config { bump: 1, admin: [0; 32], treasury: [0; 32], paused: false, params: Params::DEFAULT }.write(&mut b);
        assert_eq!(Launch::read(&b), None);
        assert_eq!(Stream::read(&b[..10]), None);
        assert_eq!(Config::read(&[]), None);
    }

    #[test]
    fn token_account_fields() {
        let mut b = vec![0u8; 165];
        b[..32].copy_from_slice(&[7; 32]);
        b[32..64].copy_from_slice(&[8; 32]);
        b[64..72].copy_from_slice(&99u64.to_le_bytes());
        assert_eq!(token_mint(&b), Some([7; 32]));
        assert_eq!(token_owner(&b), Some([8; 32]));
        assert_eq!(token_amount(&b), Some(99));
    }

    #[test]
    fn launchlab_status_offset_matches_the_sdk_layout() {
        // 8-byte discriminator, 8-byte epoch, 1-byte bump, then status.
        let mut b = vec![0u8; 400];
        b[17] = 2;
        assert_eq!(launchlab_status(&b), Some(2));
    }

    #[test]
    fn vault_round_trips() {
        let v = Vault { bump: 7, params: Params { discount_bps: 800, max_sale_bps: 150, daily_bps: 900, guard_bps: 1200, twap_window: 600, reserve: 5 }, window_start: 42, window_start_balance: 77, window_spent: 11, tokens_burned: 123, total_paid: 456, paused: true };
        let mut b = vec![0u8; VAULT_LEN];
        v.write(&mut b);
        assert_eq!(Vault::read(&b), Some(v));
    }

    #[test]
    fn cpmm_pool_offsets_follow_the_sdk_layout() {
        // 8 disc + 8 keys of 32 + observation(32) = 296; then bump, status, 3 decimals (5), lp amount (8),
        // fees A/B (16), fund A/B (16), open time, epoch (16), fee_on, enable, 6 padding, creator A/B.
        let mut b = vec![0u8; 500];
        b[72..104].copy_from_slice(&[1; 32]);
        b[104..136].copy_from_slice(&[2; 32]);
        b[168..200].copy_from_slice(&[3; 32]);
        b[200..232].copy_from_slice(&[4; 32]);
        b[296..328].copy_from_slice(&[5; 32]);
        b[341..349].copy_from_slice(&10u64.to_le_bytes());
        b[349..357].copy_from_slice(&20u64.to_le_bytes());
        b[357..365].copy_from_slice(&30u64.to_le_bytes());
        b[365..373].copy_from_slice(&40u64.to_le_bytes());
        b[397..405].copy_from_slice(&50u64.to_le_bytes());
        b[405..413].copy_from_slice(&60u64.to_le_bytes());
        let p = CpmmPool::read(&b).unwrap();
        assert_eq!((p.vault_a, p.vault_b, p.mint_a, p.mint_b, p.observation), ([1; 32], [2; 32], [3; 32], [4; 32], [5; 32]));
        assert_eq!((p.fees_a, p.fees_b), (90, 120));
    }

    #[test]
    fn observations_pick_the_right_side() {
        let mut b = vec![0u8; 43 + 4000];
        b[43..51].copy_from_slice(&1234u64.to_le_bytes());
        b[51..67].copy_from_slice(&111u128.to_le_bytes());
        b[67..83].copy_from_slice(&222u128.to_le_bytes());
        assert_eq!(observations(&b, true).unwrap()[0], (1234, 111));
        assert_eq!(observations(&b, false).unwrap()[0], (1234, 222));
        assert_eq!(observations(&b[..100], true), None);
    }

    #[test]
    fn platform_cp_config_offset() {
        let mut b = vec![0u8; 800];
        b[688..720].copy_from_slice(&[6; 32]);
        assert_eq!(platform_cp_config(&b), Some([6; 32]));
    }
}
