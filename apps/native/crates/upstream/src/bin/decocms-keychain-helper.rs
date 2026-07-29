fn main() -> std::process::ExitCode {
    match upstream::keychain_helper::serve_stdio() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => std::process::ExitCode::FAILURE,
    }
}
