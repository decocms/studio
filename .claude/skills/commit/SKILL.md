---
name: commit
description: Prepare code for review by running quality checks, creating conventional commits, and opening pull requests. Use when the user wants to commit changes, create a PR, prepare for code review, or asks to commit their work.
disable-model-invocation: true
---

I'm getting ready for code review. Please follow these steps:

## 0. Branch Check
If you're on the `main` branch, create a new feature branch first before making any commits.

## 1. Quality Assurance Checks
Run the following commands in order:
1. bun run fmt
2. bun run lint
3. bun run check:ci
4. bun run knip
5. bun test

If any checks fail, address the issues before proceeding.

## 2. Create Commits
Split the file changes into logical commits following Conventional Commit format:
- `type(scope): message` (e.g., `feat(chat): add thread deletion`, `fix(auth): resolve token expiry`)
- Use types: feat, fix, refactor, docs, chore, test, etc.

Push all commits to the remote branch.

## 3. Create or Update Pull Request
Use the `gh` CLI tool to create or update the PR. The PR description MUST follow the structure defined in `.github/pull_request_template.md`.

**Important**: 
- Read `.github/pull_request_template.md` and follow its structure exactly
- Analyze the git diff and commits to generate accurate content for each section
- For "How to Test", provide specific, actionable steps based on the actual changes
- Mark "N/A" for Screenshots and Migration Notes if not applicable
- Ensure the PR title follows Conventional Commit format

## 4. Report Results
Finally, report the GitHub PR URL.
