//! The engine's WebAssembly interface.
//!
//! The host talks to the engine through one function, [`ps_call`], with a request buffer and gets a response buffer
//! back. Both use the same envelope: a little-endian `u32` length, a UTF-8 JSON header of that length, then an
//! optional binary payload (a file's bytes in, result columns out). Keeping a single entry point means the boundary
//! does not grow with the engine: new operations are new `op` values, not new exports.
//!
//! Memory: the host asks for a request buffer with [`ps_alloc`], writes the request, calls [`ps_call`], reads the
//! response through the returned pointer (its first four bytes are the total length), and releases both with
//! [`ps_free`].

mod engine;

pub use engine::{Engine, Envelope};

use std::cell::RefCell;

thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// The host's monotonic clock in milliseconds (`performance.now()`).
    fn ps_now() -> f64;
    /// Progress of the running request: `done` of `total` units.
    fn ps_progress(done: f64, total: f64);
}

/// Forwards progress to the host.
struct HostProgress;

impl ps_study::Progress for HostProgress {
    #[allow(unsafe_code)]
    fn report(&mut self, done: f64, total: f64) {
        #[cfg(target_arch = "wasm32")]
        // SAFETY: `ps_progress` is a host function taking two numbers and returning nothing.
        unsafe {
            ps_progress(done, total);
        }
        #[cfg(not(target_arch = "wasm32"))]
        let _ = (done, total);
    }
}

#[cfg(target_arch = "wasm32")]
fn host_now() -> f64 {
    #[allow(unsafe_code)]
    // SAFETY: `ps_now` is a pure host function with no arguments.
    unsafe {
        ps_now()
    }
}

/// Allocates `len` bytes for the host to write a request into.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ps_alloc(len: usize) -> *mut u8 {
    let mut buf = vec![0u8; len.max(1)].into_boxed_slice();
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Releases a buffer from [`ps_alloc`] or [`ps_call`].
///
/// # Safety
/// `ptr` and `len` must describe a buffer this module handed out, released once.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ps_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: the caller passes back exactly a pointer and length this module allocated as a boxed slice.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len.max(1))) });
}

/// Runs one request. Returns a buffer whose first four bytes give its total length; the host frees it with
/// [`ps_free`].
///
/// # Safety
/// `ptr` and `len` must describe an initialised buffer from [`ps_alloc`].
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ps_call(ptr: *const u8, len: usize) -> *mut u8 {
    #[cfg(target_arch = "wasm32")]
    ps_num::clock::install(host_now);
    // SAFETY: the host wrote `len` bytes at `ptr` into a buffer from `ps_alloc`.
    let request = unsafe { std::slice::from_raw_parts(ptr, len) };
    let response = ENGINE.with(|e| e.borrow_mut().handle(request, &mut HostProgress));
    let total = 4 + response.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&response);
    let mut boxed = out.into_boxed_slice();
    let p = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    p
}
