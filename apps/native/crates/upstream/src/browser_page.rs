//! Shared chrome for the pages this app serves into the user's REAL browser.
//!
//! A couple of desktop flows deliberately finish outside the webview — sign-in
//! and MCP OAuth both hand the authorize URL to the system browser — and each
//! one needs a dead-end page telling the user to come back to the app. Those
//! pages are the only Studio surface a user ever sees that React does not
//! render, so without a shared definition they drift away from the product's
//! look one page at a time.
//!
//! The tokens are literal `oklch()` values copied from
//! `packages/ui/src/styles/global.css`'s `:root`/`.dark` blocks and keyed off
//! `prefers-color-scheme`, because a static page has no `.dark` class toggle
//! to hook into. Everything is inlined: these pages are served to a browser
//! that is NOT the app, frequently while offline, so a stylesheet or font
//! request that fails would leave the user staring at unstyled text. Same
//! reasoning for the visual column's image (`ONBOARDING_VISUAL_JPEG`): the
//! same split layout React renders — `AuthSplitLayout` in
//! `apps/web/src/components/auth-split-layout.tsx`, using
//! `apps/web/public/onboarding-placeholder.png` — but that PNG is 6.6 MB, so
//! this embeds a recompressed JPEG copy sized for this one purpose, not the
//! original asset.

use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};

/// Shared tokens + reset.
const STYLE_BASE: &str = r#"
  :root {
    color-scheme: light dark;
    --background: oklch(0.99 0.003 73);
    --foreground: oklch(0.145 0.01 60);
    --sidebar: oklch(0.975 0.006 80);
    --muted: oklch(0.955 0.006 80);
    --muted-foreground: oklch(0.46 0.012 60);
    --border: oklch(0.915 0.005 80);
    --destructive: oklch(0.58 0.22 27);
    --font-sans: "Inter var", "Inter", ui-sans-serif, system-ui, -apple-system,
      BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.175 0.005 60);
      --foreground: oklch(0.96 0.005 60);
      --sidebar: oklch(0.205 0.005 60);
      --muted: oklch(0.235 0.005 60);
      --muted-foreground: oklch(0.62 0.008 60);
      --border: oklch(0.28 0.005 60);
      --destructive: oklch(0.62 0.22 27);
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: var(--font-sans);
    font-weight: 450;
    background: var(--background);
    color: var(--foreground);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .split { display: flex; min-height: 100vh; width: 100%; }
  .form-col {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--sidebar);
    padding: 2.5rem 1.5rem;
  }
  .content { width: 100%; max-width: 440px; display: grid; gap: 2.5rem; }
  .brand-mark { width: 3rem; height: 3rem; display: block; }
  .brand-mark--dark { display: none; }
  @media (prefers-color-scheme: dark) {
    .brand-mark--light { display: none; }
    .brand-mark--dark { display: block; }
  }
  .header { display: grid; gap: 0.75rem; }
  h1 { font-size: 1.875rem; line-height: 2.25rem; font-weight: 600; letter-spacing: -0.025em; }
  p { font-size: 1rem; line-height: 1.5rem; color: var(--muted-foreground); }
  .hint { font-size: 0.875rem; }
  .visual-col {
    position: relative;
    flex: 1;
    overflow: hidden;
    background: var(--muted);
    display: none;
  }
  @media (min-width: 768px) { .visual-col { display: flex; } }
  .visual-image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
"#;

/// Applied only when [`Page::destructive`] is set.
const DESTRUCTIVE_STYLE: &str = r#"
  h1 { color: var(--destructive); }
"#;

/// The light-mode `deco` logo mark (`apps/web/public/logos/deco logo.svg`),
/// inlined verbatim — same asset the prod login form uses.
const BRAND_MARK_LIGHT_SVG: &str = r##"<svg class="brand-mark brand-mark--light" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M33.8914 99.321C21.291 99.321 11.2848 94.5032 5.35518 85.9794C-0.945031 77.0849 -1.68623 64.4845 3.13158 51.1429C9.80239 33.7247 25.7382 22.9772 45.0094 22.9772H45.38C45.38 22.6066 45.38 22.236 45.38 21.4948C45.0094 15.1946 49.0861 9.63562 55.0157 7.78261L72.4339 1.1118C74.2869 0.370601 76.1399 0 77.9929 0C83.5519 0 88.7403 2.96481 91.3345 8.15321L98.3759 22.9772C100.6 27.4245 100.6 32.9835 98.0053 37.0601C95.4111 41.1367 91.3345 43.3603 86.8873 43.7309C85.7755 45.9545 85.0343 48.1781 83.9225 50.0311C81.6989 55.2195 79.4753 60.4079 76.8811 65.9669C67.2455 85.9794 56.4981 99.321 33.8914 99.321Z" fill="#07401A"/>
          <path d="M33.8913 86.3501C47.9742 86.3501 55.7568 80.0499 65.0218 60.4081C70.2102 49.6606 74.2868 38.9132 79.1046 28.5364L85.0342 30.3894C86.5166 30.76 87.6284 30.0188 86.8872 28.5364L79.4752 14.083C79.1046 12.9712 77.6222 12.9712 76.881 13.3418L59.0922 20.0126C57.6098 20.3832 57.6098 21.8656 59.0922 22.2362L64.2806 24.0892C59.8334 33.7248 54.645 48.5488 50.1978 57.8138C45.38 68.1907 43.1563 75.2321 34.6325 75.2321C26.1087 75.2321 24.9969 68.9319 28.7029 59.6668C32.7795 48.9194 39.4503 45.9546 46.8624 48.1782C49.086 45.2134 50.5684 40.7662 51.3096 36.6896C49.086 35.9484 46.4918 35.9484 44.2682 35.9484C32.0383 35.9484 19.8085 42.2486 14.6201 55.5902C9.06109 73.0085 14.9907 86.3501 33.8913 86.3501Z" fill="#D0EC1A"/>
        </svg>"##;

/// The dark-mode `deco` logo mark (`apps/web/public/logos/deco logo negative.svg`).
const BRAND_MARK_DARK_SVG: &str = r##"<svg class="brand-mark brand-mark--dark" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M43.381 127.131C27.2525 127.131 14.4445 120.964 6.85463 110.054C-1.20964 98.6687 -2.15838 82.5402 4.00842 65.4629C12.5471 43.1676 32.9449 29.4109 57.6121 29.4109H58.0865C58.0865 28.9365 58.0865 28.4621 58.0865 27.5134C57.6121 19.4491 62.8301 12.3336 70.42 9.96175L92.7154 1.42311C95.0872 0.474369 97.4591 0 99.8309 0C106.946 0 113.588 3.79495 116.908 10.4361L125.921 29.4109C128.767 35.1033 128.767 42.2188 125.447 47.4369C122.126 52.6549 116.908 55.5012 111.216 55.9755C109.793 58.8217 108.844 61.6679 107.421 64.0398C104.575 70.681 101.728 77.3221 98.4078 84.4376C86.0742 110.054 72.3175 127.131 43.381 127.131Z" fill="#D0EC1A"/>
          <path d="M43.3804 110.528C61.4064 110.528 71.3682 102.464 83.2274 77.3223C89.8685 63.5656 95.0866 49.8089 101.253 36.5265L108.843 38.8984C110.741 39.3727 112.164 38.424 111.215 36.5265L101.728 18.0261C101.253 16.603 99.3559 16.603 98.4072 17.0774L75.6375 25.616C73.74 26.0904 73.74 27.9879 75.6375 28.4623L82.2786 30.8341C76.5862 43.1677 69.9451 62.1425 64.2526 74.0017C58.0858 87.284 55.2396 96.297 44.3291 96.297C33.4187 96.297 31.9955 88.2327 36.7392 76.3735C41.9573 62.6168 50.4959 58.8219 59.9833 61.6681C62.8295 57.8731 64.727 52.1807 65.6757 46.9626C62.8295 46.0139 59.5089 46.0139 56.6627 46.0139C41.0086 46.0139 25.3544 54.0782 18.7132 71.1555C11.5977 93.4508 19.1876 110.528 43.3804 110.528Z" fill="#07401A"/>
        </svg>"##;

/// Recompressed copy of `apps/web/public/onboarding-placeholder.png` (the
/// capybara illustration React's `AuthSplitLayout` shows by default) — see
/// this module's doc comment for why it's a separate, much smaller file
/// rather than the original PNG.
const ONBOARDING_VISUAL_JPEG: &[u8] = include_bytes!("../assets/onboarding-visual.jpg");

/// `data:` URI for [`ONBOARDING_VISUAL_JPEG`], base64-encoded once and
/// reused for every page render.
fn onboarding_visual_data_uri() -> &'static str {
    static DATA_URI: OnceLock<String> = OnceLock::new();
    DATA_URI.get_or_init(|| {
        format!(
            "data:image/jpeg;base64,{}",
            STANDARD.encode(ONBOARDING_VISUAL_JPEG)
        )
    })
}

/// One dead-end page.
pub struct Page<'a> {
    /// Browser tab title.
    pub title: &'a str,
    /// Headline.
    pub heading: &'a str,
    /// Lead paragraph.
    pub body: &'a str,
    /// Smaller follow-up line, usually "close this tab and…".
    pub hint: Option<&'a str>,
    /// Colour the headline with `--destructive`.
    pub destructive: bool,
}

/// Render a page.
///
/// Every caller-supplied field is HTML-escaped here rather than at the call
/// site, so a caller cannot forget: these strings routinely carry provider- or
/// server-supplied text, and this page is served from the app's own origin.
pub fn render(page: Page<'_>) -> String {
    let hint = match page.hint {
        Some(hint) => format!("\n        <p class=\"hint\">{}</p>", html_escape(hint)),
        None => String::new(),
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<style>{base}{extra}</style>
</head>
<body>
<main class="split">
  <section class="form-col">
    <div class="content">
      {light}
      {dark}
      <div class="header">
        <h1>{heading}</h1>
        <p>{body}</p>{hint}
      </div>
    </div>
  </section>
  <aside class="visual-col" aria-hidden="true">
    <img class="visual-image" src="{visual}" alt="">
  </aside>
</main>
</body>
</html>"#,
        title = html_escape(page.title),
        base = STYLE_BASE,
        extra = if page.destructive {
            DESTRUCTIVE_STYLE
        } else {
            ""
        },
        light = BRAND_MARK_LIGHT_SVG,
        dark = BRAND_MARK_DARK_SVG,
        heading = html_escape(page.heading),
        body = html_escape(page.body),
        hint = hint,
        visual = onboarding_visual_data_uri(),
    )
}

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(destructive: bool) -> String {
        render(Page {
            title: "T",
            heading: "H",
            body: "B",
            hint: Some("Hint"),
            destructive,
        })
    }

    #[test]
    fn carries_the_shared_chrome() {
        let html = sample(false);
        // Design tokens, both schemes, the brand mark, and the visual-column
        // image travel with the page — it is served to a browser that may be
        // offline, so nothing is allowed to be a separate request.
        assert!(html.contains("--background: oklch(0.99 0.003 73)"));
        assert!(html.contains("prefers-color-scheme: dark"));
        assert!(html.contains("brand-mark--light"));
        assert!(html.contains("brand-mark--dark"));
        assert!(html.contains("class=\"visual-image\" src=\"data:image/jpeg;base64,"));
        assert!(!html.contains("<link"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn visual_image_data_uri_is_identical_across_calls() {
        // Exercises the `OnceLock` path more than once in the same process
        // (tests may run in any order/count) and confirms it never produces
        // a different encode of the same bytes.
        assert_eq!(onboarding_visual_data_uri(), onboarding_visual_data_uri());
    }

    #[test]
    fn only_the_destructive_variant_recolors_the_headline() {
        assert!(sample(true).contains("h1 { color: var(--destructive); }"));
        assert!(!sample(false).contains("h1 { color: var(--destructive); }"));
    }

    /// These strings routinely carry provider- or server-supplied text, and
    /// the page is served from the app's own origin.
    #[test]
    fn escapes_every_caller_supplied_field() {
        let html = render(Page {
            title: "<script>t</script>",
            heading: "<script>h</script>",
            body: "<script>b</script>",
            hint: Some("<script>n</script>"),
            destructive: false,
        });
        for raw in ["<script>t", "<script>h", "<script>b", "<script>n"] {
            assert!(!html.contains(raw), "leaked {raw}");
        }
        assert!(html.contains("&lt;script&gt;b&lt;/script&gt;"));
    }

    #[test]
    fn omits_the_hint_line_when_there_is_none() {
        let html = render(Page {
            title: "T",
            heading: "H",
            body: "B",
            hint: None,
            destructive: false,
        });
        assert!(!html.contains("class=\"hint\""));
    }

    #[test]
    fn escapes_the_usual_suspects() {
        assert_eq!(html_escape("a&b<c>\"d\""), "a&amp;b&lt;c&gt;&quot;d&quot;");
    }
}
