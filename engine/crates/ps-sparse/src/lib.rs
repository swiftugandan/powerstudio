//! Sparse matrices and direct linear solvers for the PowerStudio engine.
//!
//! Every system the engine solves (Newton-Raphson Jacobians, admittance matrices, sensitivity and dynamic systems)
//! goes through the [`SparseSolver`] trait. Solvers split the work the way power system calculations need it:
//! [`SparseSolver::analyse`] orders the matrix and computes the symbolic factorisation once per sparsity pattern,
//! [`SparseSolver::factor`] computes the numeric factorisation for new values on that pattern, and
//! [`SparseSolver::solve`] solves against the latest factors. A Newton iteration therefore pays for the ordering once
//! and only refactorises afterwards.
//!
//! [`FaerLu`] is the production solver (faer's sparse LU with COLAMD ordering and partial pivoting). [`DenseLu`] is a
//! reference for tests on small systems.

mod csc;
mod dense;
mod faer_lu;

pub use csc::{Csc, CscBuilder, Pattern};
pub use dense::DenseLu;
pub use faer_lu::FaerLu;

/// Why a factorisation or solve failed.
#[derive(Debug, Clone, PartialEq)]
pub enum SolveError {
    /// The matrix is singular, or numerically so, at the given pivot column.
    Singular {
        /// Column (in the solver's own ordering) where no usable pivot was found.
        column: usize,
    },
    /// The values do not match the analysed pattern, or the system is not square.
    Shape(String),
    /// [`SparseSolver::factor`] or [`SparseSolver::solve`] was called before the steps it depends on.
    NotReady(&'static str),
    /// The solver could not allocate its working memory.
    OutOfMemory,
}

impl std::fmt::Display for SolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Singular { column } => {
                write!(f, "the matrix is singular at pivot column {column}")
            }
            Self::Shape(what) => write!(f, "{what}"),
            Self::NotReady(what) => write!(f, "{what}"),
            Self::OutOfMemory => write!(f, "the solver ran out of memory"),
        }
    }
}

impl std::error::Error for SolveError {}

/// Statistics a solver reports after factorising, for diagnostics and benchmarks.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FactorStats {
    /// Order of the system.
    pub n: usize,
    /// Non-zeros of the matrix.
    pub nnz: usize,
    /// Non-zeros of L plus U, when the solver exposes them.
    pub factor_nnz: Option<usize>,
}

/// A direct solver for square sparse real systems with a fixed sparsity pattern.
pub trait SparseSolver {
    /// Orders the pattern and computes the symbolic factorisation. Call again only when the pattern changes.
    fn analyse(&mut self, pattern: &Pattern) -> Result<(), SolveError>;
    /// Computes the numeric factorisation for values laid out on the analysed pattern (CSC order).
    fn factor(&mut self, values: &[f64]) -> Result<FactorStats, SolveError>;
    /// Solves `A x = b` in place using the latest factorisation.
    fn solve(&mut self, rhs: &mut [f64]) -> Result<(), SolveError>;
    /// Solves `Aᵀ x = b` in place using the latest factorisation.
    fn solve_transpose(&mut self, rhs: &mut [f64]) -> Result<(), SolveError>;
}

/// Residual `‖A x − b‖∞` for a CSC matrix, used by tests and by callers that check solution quality.
pub fn residual_inf(a: &Csc, x: &[f64], b: &[f64]) -> f64 {
    let mut r = b.to_vec();
    a.mul_sub(x, &mut r);
    r.iter().fold(0.0_f64, |m, v| m.max(v.abs()))
}
