//! Route handler modules, one per family — see
//! the native module-ownership contract for exactly which family owns
//! which file. `router.rs` (a shared file) is the only place these modules'
//! handlers get wired to paths; adding/removing a route is a `router.rs`
//! change, not a change here.

pub mod agent_capabilities;
pub mod agent_hooks;
pub mod bash;
pub mod config;
pub mod events;
pub mod fs;
pub mod git;
pub mod health;
pub mod intercept;
pub mod mcp_callback;
pub mod proxy;
pub mod repo_dir;
pub(crate) mod sandbox_account;
pub mod scripts;
pub(crate) mod selftest;
pub mod setup;
pub mod tasks;
pub mod terminal;
pub mod threads;
pub mod update;
pub mod upstream;
pub mod webdav;
pub mod ws_proxy;
