// SPDX-License-Identifier: Apache-2.0
//! Deterministic test utilities.
//!
//! These types make tests repeatable, as `AGENTS.md` section 6 requires. They
//! control time, identifiers, and randomness. They never read the system
//! clock, the environment, or any other external state.
//!
//! This module is public so the Node binding and the wrapper tests can use
//! it. It is not part of the portable contracts in `contracts/v0`. Product
//! code must not call it.
//!
//! The TypeScript test support in `packages/measuretwice/test/support`
//! mirrors `SplitMix64` bit for bit, so both languages can assert the same
//! golden values.

use std::time::Duration;

/// A manual clock for tests.
///
/// The clock reports the value it was given and moves only when the test
/// advances it. Two clocks seeded alike report the same time sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FakeClock {
    now_ms: u64,
}

impl FakeClock {
    /// Creates a clock that reports `start_ms` milliseconds.
    pub const fn start_ms(start_ms: u64) -> Self {
        Self { now_ms: start_ms }
    }

    /// Returns the current time in milliseconds.
    pub const fn now_ms(&self) -> u64 {
        self.now_ms
    }

    /// Moves the clock forward by `ms` milliseconds.
    ///
    /// # Panics
    ///
    /// Panics when the new value exceeds `u64::MAX`.
    pub fn advance_ms(&mut self, ms: u64) {
        self.now_ms = self
            .now_ms
            .checked_add(ms)
            .expect("fake clock exceeded u64::MAX");
    }

    /// Moves the clock forward by `duration`, rounded down to whole
    /// milliseconds.
    pub fn advance(&mut self, duration: Duration) {
        self.advance_ms(duration.as_millis() as u64);
    }
}

/// A sequential identifier generator for tests.
///
/// Identifiers join a fixed prefix and a counter that starts at 1. They match
/// the contract identifier rule: lowercase letters, digits, and hyphens.
#[derive(Debug, Clone)]
pub struct SequenceIds {
    prefix: String,
    next: u64,
}

impl SequenceIds {
    /// Creates a generator with the given prefix.
    ///
    /// # Panics
    ///
    /// Panics when the prefix is empty or holds characters outside lowercase
    /// letters, digits, and hyphens.
    pub fn new(prefix: &str) -> Self {
        assert!(!prefix.is_empty(), "identifier prefix is empty");
        assert!(
            prefix
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "identifier prefix {prefix:?} holds characters outside lowercase letters, digits, and hyphens"
        );
        Self {
            prefix: prefix.to_owned(),
            next: 1,
        }
    }

    /// Returns the next identifier. The counter is zero-padded to six digits,
    /// so identifier order stays visible in sorted output.
    pub fn next_id(&mut self) -> String {
        let id = format!("{}-{:06}", self.prefix, self.next);
        self.next += 1;
        id
    }
}

/// The golden gamma constant of SplitMix64.
const GAMMA: u64 = 0x9E37_79B9_7F4A_7C15;

/// A SplitMix64 generator for tests.
///
/// SplitMix64 gives one deterministic `u64` stream for one seed. It is a
/// test tool, not a cryptographic source. The constants and the mixing steps
/// follow Sebastiano Vigna's 2015 description, so other languages can match
/// it exactly.
#[derive(Debug, Clone)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    /// Creates a generator from one seed. Equal seeds give equal streams.
    pub const fn seeded(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Returns the next value of the stream.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(GAMMA);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Returns the next value as a fraction in `[0, 1)` with 53 bits of
    /// precision.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Returns the next value below `bound`, without modulo bias.
    ///
    /// # Panics
    ///
    /// Panics when `bound` is zero.
    pub fn below(&mut self, bound: u64) -> u64 {
        assert!(bound > 0, "below needs a positive bound");
        let threshold = bound.wrapping_neg() % bound;
        loop {
            let value = self.next_u64();
            if value >= threshold {
                return value % bound;
            }
        }
    }

    /// Shuffles `items` in place with an unbiased Fisher-Yates pass. Equal
    /// seeds give equal permutations.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in (1..items.len()).rev() {
            let swap = self.below(index as u64 + 1) as usize;
            items.swap(index, swap);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_clock_moves_only_when_advanced() {
        let mut clock = FakeClock::start_ms(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance_ms(250);
        assert_eq!(clock.now_ms(), 1_250);
        clock.advance(Duration::from_millis(1_500));
        assert_eq!(clock.now_ms(), 2_750);
    }

    #[test]
    fn equal_fake_clocks_report_equal_times() {
        let mut first = FakeClock::start_ms(5);
        let mut second = FakeClock::start_ms(5);
        first.advance_ms(7);
        second.advance_ms(7);
        assert_eq!(first, second);
        second.advance_ms(1);
        assert_ne!(first, second);
    }

    #[test]
    fn sequence_ids_are_ordered_and_unique() {
        let mut ids = SequenceIds::new("case");
        assert_eq!(ids.next_id(), "case-000001");
        assert_eq!(ids.next_id(), "case-000002");
        assert_eq!(ids.next_id(), "case-000003");
    }

    #[test]
    fn sequence_ids_reject_invalid_prefixes() {
        let invalid = ["", "Case", "case_id", "case id", "café"];
        for prefix in invalid {
            let result = std::panic::catch_unwind(|| SequenceIds::new(prefix));
            assert!(result.is_err(), "prefix {prefix:?} was accepted");
        }
    }

    #[test]
    fn splitmix64_matches_golden_values() {
        // Golden values computed independently for this test. The TypeScript
        // test support asserts the same values.
        let mut seed_zero = SplitMix64::seeded(0);
        assert_eq!(seed_zero.next_u64(), 0xE220_A839_7B1D_CDAF);
        assert_eq!(seed_zero.next_u64(), 0x6E78_9E6A_A1B9_65F4);
        assert_eq!(seed_zero.next_u64(), 0x06C4_5D18_8009_454F);

        let mut seed_42 = SplitMix64::seeded(42);
        assert_eq!(seed_42.next_u64(), 0xBDD7_3226_2FEB_6E95);
        assert_eq!(seed_42.next_u64(), 0x28EF_E333_B266_F103);
        assert_eq!(seed_42.next_u64(), 0x4752_6757_130F_9F52);

        let mut seed_deadbeef = SplitMix64::seeded(0xDEAD_BEEF);
        assert_eq!(seed_deadbeef.next_u64(), 0x4ADF_B90F_68C9_EB9B);
        assert_eq!(seed_deadbeef.next_u64(), 0xDE58_6A31_41A1_0922);
        assert_eq!(seed_deadbeef.next_u64(), 0x021F_BC2F_8E1C_FC1D);
    }

    #[test]
    fn splitmix64_streams_follow_the_seed() {
        let mut first = SplitMix64::seeded(7);
        let mut second = SplitMix64::seeded(7);
        let mut other = SplitMix64::seeded(8);
        for _ in 0..8 {
            let value = first.next_u64();
            assert_eq!(value, second.next_u64());
            assert_ne!(value, other.next_u64());
        }
    }

    #[test]
    fn splitmix64_floats_stay_in_range() {
        let mut random = SplitMix64::seeded(1);
        for _ in 0..1_000 {
            let value = random.next_f64();
            assert!((0.0..1.0).contains(&value));
        }
        // The first float of seed 0 comes from the first stream value, so it
        // also matches the golden value above.
        assert_eq!(SplitMix64::seeded(0).next_f64(), 0.883_310_808_213_642_6);
    }

    #[test]
    fn below_stays_inside_the_bound() {
        let mut random = SplitMix64::seeded(99);
        for bound in [1u64, 2, 7, 100, 1_000] {
            for _ in 0..200 {
                assert!(random.below(bound) < bound);
            }
        }
    }

    #[test]
    fn shuffle_is_deterministic_and_preserves_items() {
        let mut first: Vec<u32> = (0..64).collect();
        let mut second: Vec<u32> = (0..64).collect();
        let mut third: Vec<u32> = (0..64).collect();

        SplitMix64::seeded(5).shuffle(&mut first);
        SplitMix64::seeded(5).shuffle(&mut second);
        SplitMix64::seeded(6).shuffle(&mut third);

        assert_eq!(first, second, "equal seeds give equal permutations");
        assert_ne!(first, third, "different seeds give different permutations");
        first.sort_unstable();
        third.sort_unstable();
        assert_eq!(first, third, "a shuffle keeps every item");
    }
}
