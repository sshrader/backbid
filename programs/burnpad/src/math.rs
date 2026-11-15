//! Pure arithmetic with no Solana types, so it can be tested anywhere.

pub const BPS: u64 = 10_000;
pub const THIRTY_DAYS: i64 = 30 * 24 * 60 * 60;

/// Split a harvested amount by basis points. Each share rounds down; the remainder goes to the vault.
/// Returns (vault, creator, treasury). If `creator_expired`, the creator's share goes to the vault.
pub fn split(amount: u64, creator_bps: u16, treasury_bps: u16, creator_expired: bool) -> (u64, u64, u64) {
    let mut creator = mul_bps(amount, creator_bps);
    let treasury = mul_bps(amount, treasury_bps);
    if creator_expired {
        creator = 0;
    }
    let vault = amount - creator - treasury;
    (vault, creator, treasury)
}

fn mul_bps(amount: u64, bps: u16) -> u64 {
    ((amount as u128) * (bps as u128) / (BPS as u128)) as u64
}

/// Linear vesting of `total` over `duration` seconds starting at `start`. Zero before `start`.
pub fn vested(total: u64, start: i64, now: i64, duration: i64) -> u64 {
    if start <= 0 || now <= start || duration <= 0 {
        return 0;
    }
    let elapsed = (now - start).min(duration) as u128;
    ((total as u128) * elapsed / (duration as u128)) as u64
}

/// What the creator can take now: vested minus already claimed, never negative.
pub fn claimable(total: u64, claimed: u64, start: i64, now: i64, duration: i64) -> u64 {
    vested(total, start, now, duration).saturating_sub(claimed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_is_exact_and_remainder_goes_to_vault() {
        for amount in [0u64, 1, 2, 3, 7, 99, 100, 1_001, 12_345_678, u64::MAX] {
            let (v, c, t) = split(amount, 2500, 2500, false);
            assert_eq!(v as u128 + c as u128 + t as u128, amount as u128);
            assert!(v >= c && v >= t);
        }
        assert_eq!(split(100, 2500, 2500, false), (50, 25, 25));
        assert_eq!(split(3, 2500, 2500, false), (3, 0, 0)); // dust goes to the vault
    }

    #[test]
    fn expired_creator_share_goes_to_vault() {
        assert_eq!(split(100, 2500, 2500, true), (75, 0, 25));
    }

    #[test]
    fn vesting_is_zero_before_start_and_full_after_duration() {
        let d = THIRTY_DAYS;
        assert_eq!(vested(1000, 0, 5, d), 0); // not graduated
        assert_eq!(vested(1000, 100, 100, d), 0);
        assert_eq!(vested(1000, 100, 100 + d / 2, d), 500);
        assert_eq!(vested(1000, 100, 100 + d, d), 1000);
        assert_eq!(vested(1000, 100, 100 + d * 10, d), 1000);
    }

    #[test]
    fn claimable_never_exceeds_total_or_goes_negative() {
        let d = THIRTY_DAYS;
        assert_eq!(claimable(1000, 0, 100, 100 + d / 2, d), 500);
        assert_eq!(claimable(1000, 500, 100, 100 + d / 2, d), 0);
        assert_eq!(claimable(1000, 600, 100, 100 + d / 2, d), 0);
        assert_eq!(claimable(1000, 1000, 100, 100 + d, d), 0);
        assert_eq!(claimable(u64::MAX, 0, 1, 1 + d, d), u64::MAX);
    }
}
