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

/* ---------- Burn vault pricing ---------- */

/// One sample from a CPMM observation account, reduced to the side we price against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Obs {
    pub ts: u64,
    /// Cumulative price of the token in lamports per base unit, times 2^32, summed over seconds.
    pub cum: u128,
}

/// Spot price of the token in lamports per base unit, times 2^32.
pub fn spot_x32(sol_reserve: u64, token_reserve: u64) -> Option<u128> {
    if sol_reserve == 0 || token_reserve == 0 {
        return None;
    }
    Some(((sol_reserve as u128) << 32) / token_reserve as u128)
}

/// Time-weighted average price over at least `window` seconds, from cumulative observations.
/// The current stretch since the newest sample is priced at `spot`. Returns None if no sample is old enough.
pub fn twap_x32(obs: &[Obs], now: u64, window: u64, spot: u128) -> Option<u128> {
    let newest = obs.iter().filter(|o| o.ts > 0).max_by_key(|o| o.ts)?;
    if newest.ts > now {
        return None;
    }
    let cutoff = now.checked_sub(window)?;
    let then = obs.iter().filter(|o| o.ts > 0 && o.ts <= cutoff).max_by_key(|o| o.ts)?;
    let cum_now = newest.cum.checked_add(spot.checked_mul((now - newest.ts) as u128)?)?;
    let dt = (now - then.ts) as u128;
    if dt == 0 || cum_now < then.cum {
        return None;
    }
    Some((cum_now - then.cum) / dt)
}

/// True if spot and TWAP are within `guard_bps` of each other (measured against the TWAP).
pub fn within_guard(spot: u128, twap: u128, guard_bps: u16) -> bool {
    if twap == 0 {
        return false;
    }
    let gap = if spot > twap { spot - twap } else { twap - spot };
    gap.saturating_mul(BPS as u128) <= twap.saturating_mul(guard_bps as u128)
}

/// What the vault pays for `tokens` base units: the lower of TWAP and spot, less the discount. Rounds down.
pub fn bid(tokens: u64, spot: u128, twap: u128, discount_bps: u16) -> u64 {
    let price = spot.min(twap);
    let gross = (tokens as u128).saturating_mul(price) >> 32;
    let net = gross.saturating_mul((BPS as u128).saturating_sub(discount_bps as u128)) / BPS as u128;
    net.min(u64::MAX as u128) as u64
}

#[derive(Debug, PartialEq)]
pub enum Refusal {
    ZeroBid,
    OverSaleCap,
    BelowReserve,
    OverDailyBudget,
}

/// The vault's spending limits. `balance` is the vault's SOL now; `window_start_balance` and `spent` describe the
/// current 24-hour window (already rolled over by the caller).
pub fn check_limits(
    bid: u64,
    balance: u64,
    reserve: u64,
    max_sale_bps: u16,
    window_start_balance: u64,
    spent: u64,
    daily_bps: u16,
) -> Result<(), Refusal> {
    if bid == 0 {
        return Err(Refusal::ZeroBid);
    }
    if (bid as u128) * (BPS as u128) > (balance as u128) * (max_sale_bps as u128) {
        return Err(Refusal::OverSaleCap);
    }
    if balance < bid || balance - bid < reserve {
        return Err(Refusal::BelowReserve);
    }
    let budget = (window_start_balance as u128) * (daily_bps as u128) / (BPS as u128);
    if (spent as u128) + (bid as u128) > budget {
        return Err(Refusal::OverDailyBudget);
    }
    Ok(())
}

pub const DAY: i64 = 24 * 60 * 60;

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

    #[test]
    fn bid_uses_the_lower_price_and_the_discount() {
        let one = 1u128 << 32; // 1 lamport per base unit
        assert_eq!(bid(1000, one, one, 0), 1000);
        assert_eq!(bid(1000, one, one, 750), 925);
        assert_eq!(bid(1000, 2 * one, one, 750), 925); // spot above TWAP: TWAP wins
        assert_eq!(bid(1000, one, 2 * one, 750), 925); // TWAP above spot: spot wins
        assert_eq!(bid(0, one, one, 750), 0);
    }

    #[test]
    fn guard_is_symmetric_and_measured_against_twap() {
        let t = 1_000_000u128;
        assert!(within_guard(t, t, 1500));
        assert!(within_guard(t + t * 15 / 100, t, 1500));
        assert!(!within_guard(t + t * 16 / 100, t, 1500));
        assert!(within_guard(t - t * 15 / 100, t, 1500));
        assert!(!within_guard(t - t * 16 / 100, t, 1500));
        assert!(!within_guard(1, 0, 1500));
    }

    #[test]
    fn twap_averages_cumulative_price_and_extrapolates_with_spot() {
        // Price 10 for the first 100s, then 20 for the next 100s, spot now 20.
        let obs = [Obs { ts: 1000, cum: 0 }, Obs { ts: 1100, cum: 10 * 100 }, Obs { ts: 1200, cum: 10 * 100 + 20 * 100 }];
        // Window 200s back from 1200: starts at ts 1000. Average of 10 and 20 is 15.
        assert_eq!(twap_x32(&obs, 1200, 200, 20), Some(15));
        // Window 100s: newest sample at or before 1100.
        assert_eq!(twap_x32(&obs, 1200, 100, 20), Some(20));
        // Time has passed since the newest sample, priced at spot.
        assert_eq!(twap_x32(&obs, 1300, 200, 20), Some(20));
    }

    #[test]
    fn twap_needs_a_sample_old_enough() {
        let obs = [Obs { ts: 1000, cum: 0 }, Obs { ts: 1100, cum: 1000 }];
        assert_eq!(twap_x32(&obs, 1150, 300, 10), None); // nothing at or before 850
        assert_eq!(twap_x32(&[], 1150, 10, 10), None);
        assert_eq!(twap_x32(&[Obs { ts: 0, cum: 0 }], 1150, 10, 10), None); // uninitialised slot
    }

    #[test]
    fn limits_refuse_what_they_should() {
        // balance 10 SOL (in lamports / 1e9 units: use plain numbers)
        assert_eq!(check_limits(0, 1000, 0, 200, 1000, 0, 1000), Err(Refusal::ZeroBid));
        assert_eq!(check_limits(21, 1000, 0, 200, 1000, 0, 1000), Err(Refusal::OverSaleCap)); // cap is 20
        assert_eq!(check_limits(20, 1000, 0, 200, 1000, 0, 1000), Ok(()));
        assert_eq!(check_limits(20, 1000, 990, 200, 1000, 0, 1000), Err(Refusal::BelowReserve));
        assert_eq!(check_limits(20, 1000, 0, 200, 1000, 90, 1000), Err(Refusal::OverDailyBudget)); // budget 100, 90+20
        assert_eq!(check_limits(10, 1000, 0, 200, 1000, 90, 1000), Ok(()));
    }

    #[test]
    fn spot_price_is_reserve_ratio() {
        assert_eq!(spot_x32(100, 50), Some(2u128 << 32));
        assert_eq!(spot_x32(0, 50), None);
        assert_eq!(spot_x32(50, 0), None);
    }
}
