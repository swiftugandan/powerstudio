//! Numeric primitives shared by the engine crates.

mod complex;
pub use complex::C64;

/// Degrees per radian.
pub const DEG: f64 = 180.0 / std::f64::consts::PI;

/// A monotonic clock in milliseconds. Natively it reads the system clock; in WebAssembly the host supplies it,
/// because `std::time` is unavailable on `wasm32-unknown-unknown`.
pub mod clock {
    #[cfg(not(target_arch = "wasm32"))]
    thread_local! {
        static START: std::time::Instant = std::time::Instant::now();
    }

    /// Milliseconds since an arbitrary start, for timing study phases.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn now_ms() -> f64 {
        START.with(|s| s.elapsed().as_secs_f64() * 1000.0)
    }

    #[cfg(target_arch = "wasm32")]
    std::thread_local! {
        static NOW: std::cell::Cell<Option<fn() -> f64>> = const { std::cell::Cell::new(None) };
    }

    /// Installs the host clock (the WebAssembly crate does this at start-up).
    #[cfg(target_arch = "wasm32")]
    pub fn install(now: fn() -> f64) {
        NOW.with(|c| c.set(Some(now)));
    }

    /// Milliseconds since an arbitrary start, or 0 when no host clock is installed.
    #[cfg(target_arch = "wasm32")]
    pub fn now_ms() -> f64 {
        NOW.with(|c| c.get().map_or(0.0, |f| f()))
    }
}
