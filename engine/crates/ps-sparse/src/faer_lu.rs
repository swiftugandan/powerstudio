//! The production sparse solver: faer's sparse LU.

use faer::dyn_stack::{MemBuffer, MemStack, StackReq};
use faer::linalg::lu::partial_pivoting::factor::PartialPivLuParams;
use faer::sparse::linalg::SupernodalThreshold;
use faer::sparse::linalg::lu::{LuRef, LuSymbolicParams, NumericLu, SymbolicLu, factorize_symbolic_lu};
use faer::sparse::{SparseColMatRef, SymbolicSparseColMatRef};
use faer::{Conj, MatMut, Par, Spec};

use crate::{FactorStats, Pattern, SolveError, SparseSolver};

/// Order from which the supernodal factorisation is used.
const SUPERNODAL_FROM: usize = 1000;

/// faer's sparse LU: COLAMD column ordering and the symbolic factorisation in [`SparseSolver::analyse`], partial
/// pivoting and numeric factorisation in [`SparseSolver::factor`]. The symbolic result and the numeric storage are
/// reused across refactorisations, so repeated Newton iterations allocate nothing.
#[derive(Default)]
pub struct FaerLu {
    pattern: Option<Pattern>,
    symbolic: Option<SymbolicLu<usize>>,
    numeric: NumericLu<usize, f64>,
    factored: bool,
    scratch: Option<MemBuffer>,
}

impl std::fmt::Debug for FaerLu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FaerLu")
            .field("n", &self.pattern.as_ref().map(|p| p.nrows))
            .field("factored", &self.factored)
            .finish()
    }
}

impl FaerLu {
    /// A new, empty solver.
    pub fn new() -> Self {
        Self::default()
    }

    /// A solver that shares this one's ordering and symbolic factorisation and has no numeric factors yet: for
    /// systems with the same pattern (a load flow after an outage that keeps the pattern).
    pub fn analysed_copy(&self) -> Self {
        Self {
            pattern: self.pattern.clone(),
            symbolic: self.symbolic.clone(),
            ..Self::default()
        }
    }

    fn ensure_scratch(&mut self, req: StackReq) -> Result<(), SolveError> {
        let enough = self
            .scratch
            .as_ref()
            .is_some_and(|b| b.len() >= req.unaligned_bytes_required());
        if !enough {
            self.scratch = Some(MemBuffer::try_new(req).map_err(|_| SolveError::OutOfMemory)?);
        }
        Ok(())
    }

    fn solve_with(&mut self, rhs: &mut [f64], transpose: bool) -> Result<(), SolveError> {
        if !self.factored {
            return Err(SolveError::NotReady("factor before solve"));
        }
        let symbolic = self
            .symbolic
            .as_ref()
            .ok_or(SolveError::NotReady("analyse before solve"))?;
        let n = symbolic.nrows();
        if rhs.len() != n {
            return Err(SolveError::Shape("right-hand side has the wrong length".into()));
        }
        let req = symbolic.solve_in_place_scratch::<f64>(1, Par::Seq);
        let enough = self
            .scratch
            .as_ref()
            .is_some_and(|b| b.len() >= req.unaligned_bytes_required());
        if !enough {
            self.scratch = Some(MemBuffer::try_new(req).map_err(|_| SolveError::OutOfMemory)?);
        }
        let buf = self.scratch.as_mut().ok_or(SolveError::OutOfMemory)?;
        let stack = MemStack::new(buf);
        let lu = LuRef::new_unchecked(symbolic, &self.numeric);
        let x = MatMut::from_column_major_slice_mut(rhs, n, 1);
        if transpose {
            lu.solve_transpose_in_place_with_conj(Conj::No, x, Par::Seq, stack);
        } else {
            lu.solve_in_place_with_conj(Conj::No, x, Par::Seq, stack);
        }
        Ok(())
    }
}

impl SparseSolver for FaerLu {
    fn analyse(&mut self, pattern: &Pattern) -> Result<(), SolveError> {
        if pattern.nrows != pattern.ncols {
            return Err(SolveError::Shape("the system must be square".into()));
        }
        let sym = SymbolicSparseColMatRef::new_checked(
            pattern.nrows,
            pattern.ncols,
            &pattern.col_ptr,
            None,
            &pattern.row_idx,
        );
        // faer's own choice between simplicial and supernodal factorisation picks simplicial on power system
        // Jacobians of a few thousand unknowns, where supernodal is 2.4 times faster (ACTIVSg2000 and 25k); on small
        // systems the two are even (docs/ENGINE.md, numerical methods).
        let mut params = LuSymbolicParams::default();
        if pattern.nrows >= SUPERNODAL_FROM {
            params.supernodal_flop_ratio_threshold = SupernodalThreshold::FORCE_SUPERNODAL;
        }
        let symbolic = factorize_symbolic_lu(sym, params).map_err(|_| SolveError::OutOfMemory)?;
        self.symbolic = Some(symbolic);
        self.pattern = Some(pattern.clone());
        self.factored = false;
        Ok(())
    }

    fn factor(&mut self, values: &[f64]) -> Result<FactorStats, SolveError> {
        let pattern = self
            .pattern
            .as_ref()
            .ok_or(SolveError::NotReady("analyse before factor"))?;
        if values.len() != pattern.nnz() {
            return Err(SolveError::Shape(format!(
                "{} values for a pattern of {}",
                values.len(),
                pattern.nnz()
            )));
        }
        let (n, nnz) = (pattern.nrows, pattern.nnz());
        let symbolic = self
            .symbolic
            .as_ref()
            .ok_or(SolveError::NotReady("analyse before factor"))?;
        let params: Spec<PartialPivLuParams, f64> = Default::default();
        let req = StackReq::or(
            symbolic.factorize_numeric_lu_scratch::<f64>(Par::Seq, params),
            symbolic.solve_in_place_scratch::<f64>(1, Par::Seq),
        );
        self.factored = false;
        self.ensure_scratch(req)?;
        let pattern = self
            .pattern
            .as_ref()
            .ok_or(SolveError::NotReady("analyse before factor"))?;
        let symbolic = self
            .symbolic
            .as_ref()
            .ok_or(SolveError::NotReady("analyse before factor"))?;
        let sym = SymbolicSparseColMatRef::new_checked(n, n, &pattern.col_ptr, None, &pattern.row_idx);
        let a = SparseColMatRef::new(sym, values);
        let buf = self.scratch.as_mut().ok_or(SolveError::OutOfMemory)?;
        let stack = MemStack::new(buf);
        symbolic
            .factorize_numeric_lu(&mut self.numeric, a, Par::Seq, stack, params)
            .map_err(|e| match e {
                faer::sparse::linalg::LuError::SymbolicSingular { index } => SolveError::Singular { column: index },
                faer::sparse::linalg::LuError::Generic(_) => SolveError::OutOfMemory,
            })?;
        // faer does not reject numerically zero pivots; a solve of such factors yields non-finite values, which the
        // callers detect. Mark the factorisation usable.
        self.factored = true;
        Ok(FactorStats {
            n,
            nnz,
            factor_nnz: None,
        })
    }

    fn solve(&mut self, rhs: &mut [f64]) -> Result<(), SolveError> {
        self.solve_with(rhs, false)
    }

    fn solve_transpose(&mut self, rhs: &mut [f64]) -> Result<(), SolveError> {
        self.solve_with(rhs, true)
    }
}
