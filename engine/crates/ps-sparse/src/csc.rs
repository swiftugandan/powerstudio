//! Compressed sparse column matrices with a fixed pattern.

/// The sparsity pattern of a square or rectangular matrix in compressed sparse column form. Row indices within each
/// column are sorted and unique.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    /// Number of rows.
    pub nrows: usize,
    /// Number of columns.
    pub ncols: usize,
    /// Start of each column in `row_idx`; length `ncols + 1`.
    pub col_ptr: Vec<usize>,
    /// Row index of each stored entry.
    pub row_idx: Vec<usize>,
}

impl Pattern {
    /// Number of stored entries.
    pub fn nnz(&self) -> usize {
        self.row_idx.len()
    }

    /// Position of entry `(row, col)` in the value array, if it is part of the pattern.
    pub fn find(&self, row: usize, col: usize) -> Option<usize> {
        let (start, end) = (self.col_ptr[col], self.col_ptr[col + 1]);
        self.row_idx[start..end]
            .binary_search(&row)
            .ok()
            .map(|k| start + k)
    }
}

/// A sparse matrix: a [`Pattern`] and one value per stored entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Csc {
    /// The sparsity pattern.
    pub pattern: Pattern,
    /// Values in pattern order.
    pub values: Vec<f64>,
}

impl Csc {
    /// `y -= A x`.
    pub fn mul_sub(&self, x: &[f64], y: &mut [f64]) {
        let p = &self.pattern;
        for col in 0..p.ncols {
            let xc = x[col];
            if xc == 0.0 {
                continue;
            }
            for k in p.col_ptr[col]..p.col_ptr[col + 1] {
                y[p.row_idx[k]] -= self.values[k] * xc;
            }
        }
    }

    /// Dense copy, row-major, for tests on small matrices.
    pub fn to_dense(&self) -> Vec<f64> {
        let p = &self.pattern;
        let mut out = vec![0.0; p.nrows * p.ncols];
        for col in 0..p.ncols {
            for k in p.col_ptr[col]..p.col_ptr[col + 1] {
                out[p.row_idx[k] * p.ncols + col] += self.values[k];
            }
        }
        out
    }
}

/// Builds a pattern from coordinate entries, summing duplicates. It returns, for every pushed entry, the position its
/// value lands in, so a caller that refills the same matrix (a Jacobian every Newton iteration) writes straight into
/// the value array without searching.
#[derive(Debug, Clone, Default)]
pub struct CscBuilder {
    nrows: usize,
    ncols: usize,
    entries: Vec<(usize, usize)>,
}

impl CscBuilder {
    /// An empty builder for an `nrows × ncols` matrix.
    pub fn new(nrows: usize, ncols: usize) -> Self {
        Self {
            nrows,
            ncols,
            entries: Vec::new(),
        }
    }

    /// Reserves room for `n` more entries.
    pub fn reserve(&mut self, n: usize) {
        self.entries.reserve(n);
    }

    /// Records an entry and returns its handle (the order in which it was pushed).
    pub fn push(&mut self, row: usize, col: usize) -> usize {
        debug_assert!(row < self.nrows && col < self.ncols);
        self.entries.push((row, col));
        self.entries.len() - 1
    }

    /// Compresses the entries. Returns the pattern and, for each handle, its position in the value array.
    pub fn build(self) -> (Pattern, Vec<usize>) {
        let Self {
            nrows,
            ncols,
            entries,
        } = self;
        let mut order: Vec<usize> = (0..entries.len()).collect();
        order.sort_unstable_by_key(|&h| (entries[h].1, entries[h].0));
        let mut col_ptr = vec![0usize; ncols + 1];
        let mut row_idx = Vec::with_capacity(entries.len());
        let mut slot = vec![0usize; entries.len()];
        let mut last: Option<(usize, usize)> = None;
        for &h in &order {
            let (r, c) = entries[h];
            if last != Some((r, c)) {
                row_idx.push(r);
                col_ptr[c + 1] += 1;
                last = Some((r, c));
            }
            slot[h] = row_idx.len() - 1;
        }
        for c in 0..ncols {
            col_ptr[c + 1] += col_ptr[c];
        }
        (
            Pattern {
                nrows,
                ncols,
                col_ptr,
                row_idx,
            },
            slot,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicates_sum_into_one_slot_and_handles_map_back() {
        let mut b = CscBuilder::new(3, 3);
        let h0 = b.push(2, 0);
        let h1 = b.push(0, 0);
        let h2 = b.push(2, 0);
        let h3 = b.push(1, 2);
        let (p, slot) = b.build();
        assert_eq!(p.col_ptr, vec![0, 2, 2, 3]);
        assert_eq!(p.row_idx, vec![0, 2, 1]);
        assert_eq!(slot[h0], slot[h2]);
        assert_eq!(slot[h1], 0);
        assert_eq!(slot[h3], 2);
        assert_eq!(p.find(2, 0), Some(1));
        assert_eq!(p.find(1, 0), None);
    }
}
