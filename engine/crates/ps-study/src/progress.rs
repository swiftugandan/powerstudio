//! Progress reporting for long studies.

/// Receives progress from a running study.
pub trait Progress {
    /// `done` of `total` units of work are finished (outages, or simulated seconds).
    fn report(&mut self, done: f64, total: f64);
}

/// Ignores progress.
#[derive(Debug, Default, Clone, Copy)]
pub struct Silent;

impl Progress for Silent {
    fn report(&mut self, _done: f64, _total: f64) {}
}

impl<F: FnMut(f64, f64)> Progress for F {
    fn report(&mut self, done: f64, total: f64) {
        self(done, total)
    }
}
