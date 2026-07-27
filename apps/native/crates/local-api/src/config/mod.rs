pub mod classify;
pub mod merge;
pub mod store;
pub mod validate;

// `ConfigSnapshot`/`TenantConfig` aren't referenced outside `config::store`
// yet — `state.rs` (a shared file) only imports `ConfigStore`. Kept as a
// re-export (not dead in the "delete it" sense) so a future consumer of the
// documented `snapshot()` shape (see the native module-ownership contract)
// doesn't have to reach into `config::store` directly.
#[allow(unused_imports)]
pub use store::{ConfigSnapshot, ConfigStore, TenantConfig};
