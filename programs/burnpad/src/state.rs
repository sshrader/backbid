//! Account layouts as plain little-endian bytes. No Solana types, so they can be tested anywhere.
//! Every account starts with a one-byte tag so one account type is never read as another.

pub type Key = [u8; 32];

pub const TAG_CONFIG: u8 = 1;
pub const TAG_LAUNCH: u8 = 2;
pub const TAG_STREAM: u8 = 3;
pub const TAG_VAULT: u8 = 4;

pub const CONFIG_LEN: usize = 67;
pub const LAUNCH_LEN: usize = 161;
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

/// One per program. Layout: tag, bump, admin(32), treasury(32), paused.
#[derive(Debug, PartialEq, Clone)]
pub struct Config {
    pub bump: u8,
    pub admin: Key,
    pub treasury: Key,
    pub paused: bool,
}
impl Config {
    pub fn write(&self, buf: &mut [u8]) {
        buf[0] = TAG_CONFIG;
        buf[1] = self.bump;
        put(buf, 2, &self.admin);
        put(buf, 34, &self.treasury);
        buf[66] = self.paused as u8;
    }
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < CONFIG_LEN || buf[0] != TAG_CONFIG {
            return None;
        }
        Some(Self { bump: buf[1], admin: key(buf, 2), treasury: key(buf, 34), paused: buf[66] != 0 })
    }
}

/// One per token. Layout: tag, bump, mint(32), creator(32), launched_at(8), graduated_at(8), pool(32),
/// platform(32), vault_bps(2), creator_bps(2), treasury_bps(2), expired, total_harvested(8).
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

/// Burn-vault account. Only the tag and bump are used in this milestone.
#[derive(Debug, PartialEq, Clone)]
pub struct Vault {
    pub bump: u8,
}
impl Vault {
    pub fn write(&self, buf: &mut [u8]) {
        buf[0] = TAG_VAULT;
        buf[1] = self.bump;
    }
    pub fn read(buf: &[u8]) -> Option<Self> {
        if buf.len() < VAULT_LEN || buf[0] != TAG_VAULT {
            return None;
        }
        Some(Self { bump: buf[1] })
    }
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
        let c = Config { bump: 254, admin: [1; 32], treasury: [2; 32], paused: true };
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
        Config { bump: 1, admin: [0; 32], treasury: [0; 32], paused: false }.write(&mut b);
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
}
