//! The bus admittance matrix in compressed sparse row form.

use ps_num::C64;

use crate::PuNetwork;

/// The bus admittance matrix, rows compressed. Every row stores its diagonal, even when it is zero.
#[derive(Debug, Clone, PartialEq)]
pub struct Ybus {
    /// Order (number of buses).
    pub n: usize,
    /// Start of each row in `col` and `val`.
    pub row_ptr: Vec<usize>,
    /// Column of each entry, sorted within each row.
    pub col: Vec<usize>,
    /// Admittance of each entry, p.u.
    pub val: Vec<C64>,
    /// Position of each row's diagonal entry.
    pub diag: Vec<usize>,
}

impl Ybus {
    /// Builds the matrix from the network's branches and shunts. `extra` adds per-bus admittances (fault and machine
    /// admittances in the short-circuit and dynamic studies).
    pub fn build(net: &PuNetwork, extra: &[(usize, C64)]) -> Self {
        let n = net.buses.len();
        let mut entries: Vec<(usize, usize, C64)> = Vec::with_capacity(4 * net.branches.len() + n + extra.len());
        for i in 0..n {
            entries.push((i, i, C64::ZERO));
        }
        for b in &net.branches {
            entries.push((b.f, b.f, b.yff));
            entries.push((b.f, b.t, b.yft));
            entries.push((b.t, b.f, b.ytf));
            entries.push((b.t, b.t, b.ytt));
        }
        for s in &net.shunts {
            entries.push((s.bus, s.bus, s.y));
        }
        for &(bus, y) in extra {
            entries.push((bus, bus, y));
        }
        // Ordered as a stable sort by (row, column) orders them, so duplicate entries sum in insertion order and the
        // matrix is the same on every run: a counting sort by row, then each row's few entries by column (an insertion
        // sort, also stable). Linear in the entries; contingency analysis builds the matrix thousands of times.
        let mut start = vec![0usize; n + 1];
        for e in &entries {
            start[e.0 + 1] += 1;
        }
        for r in 0..n {
            start[r + 1] += start[r];
        }
        let mut next = start.clone();
        let mut by_row: Vec<(usize, C64)> = vec![(0, C64::ZERO); entries.len()];
        for &(r, c, y) in &entries {
            by_row[next[r]] = (c, y);
            next[r] += 1;
        }
        let mut row_ptr = vec![0usize; n + 1];
        let mut col = Vec::with_capacity(entries.len());
        let mut val: Vec<C64> = Vec::with_capacity(entries.len());
        for r in 0..n {
            let row = &mut by_row[start[r]..start[r + 1]];
            for i in 1..row.len() {
                let mut j = i;
                while j > 0 && row[j - 1].0 > row[j].0 {
                    row.swap(j - 1, j);
                    j -= 1;
                }
            }
            let mut last = usize::MAX;
            for &(c, y) in row.iter() {
                if c == last {
                    if let Some(v) = val.last_mut() {
                        *v += y;
                    }
                } else {
                    col.push(c);
                    val.push(y);
                    row_ptr[r + 1] += 1;
                    last = c;
                }
            }
        }
        for r in 0..n {
            row_ptr[r + 1] += row_ptr[r];
        }
        let mut diag = vec![0usize; n];
        for r in 0..n {
            for k in row_ptr[r]..row_ptr[r + 1] {
                if col[k] == r {
                    diag[r] = k;
                }
            }
        }
        Self {
            n,
            row_ptr,
            col,
            val,
            diag,
        }
    }

    /// `I = Y V`.
    pub fn mul(&self, v: &[C64], out: &mut [C64]) {
        for r in 0..self.n {
            let mut acc = C64::ZERO;
            for k in self.row_ptr[r]..self.row_ptr[r + 1] {
                acc += self.val[k] * v[self.col[k]];
            }
            out[r] = acc;
        }
    }

    /// Number of stored entries.
    pub fn nnz(&self) -> usize {
        self.col.len()
    }
}
