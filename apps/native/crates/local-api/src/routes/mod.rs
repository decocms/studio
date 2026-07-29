//! Route handler modules, one per family — see
//! the native module-ownership contract for exactly which family owns
//! which file. `router.rs` (a shared file) is the only place these modules'
//! handlers get wired to paths; adding/removing a route is a `router.rs`
//! change, not a change here.

pub mod bash;
pub mod config;
pub mod dispatch;
pub mod events;
pub mod fs;
pub mod git;
pub mod health;
pub mod intercept;
pub mod mcp_callback;
pub mod models;
pub mod orgfs;
pub mod proxy;
pub mod repo_dir;
pub mod scripts;
pub mod setup;
pub mod tasks;
pub mod threads;
pub mod upstream;
pub mod webdav;
pub mod ws_proxy;
