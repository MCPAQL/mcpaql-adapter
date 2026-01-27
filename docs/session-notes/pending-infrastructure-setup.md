# Pending Work: Infrastructure Setup

## Summary

Infrastructure setup for the mcpaql-adapter repository - a TypeScript library for building MCP-AQL compliant adapters.

## Current State

- Repository exists with basic structure
- No CI/CD workflows
- No branch protection or git flow
- Issues #1-7 created to track infrastructure work

## Work To Complete

### 1. Git Flow Setup (Issue #1)

**Purpose**: Establish consistent branching strategy

Tasks:
- Create `develop` branch from `main`
- Configure branch protection for `main` (require PRs, CI passing)
- Configure branch protection for `develop` (require CI passing)
- Document branching strategy in CONTRIBUTING.md

Branch naming conventions:
- `feature/*` - New features
- `fix/*` - Bug fixes
- `release/*` - Release preparation

### 2. CI Workflow (Issue #2)

**Purpose**: Automated build, test, and lint on every PR

Tasks:
- Create `.github/workflows/ci.yml`
- Configure ESLint for code style
- Configure Prettier for formatting
- Set up test framework (Jest or Vitest)
- Add coverage reporting
- Test on Node 18.x, 20.x, 22.x

### 3. Release Workflow (Issue #3)

**Purpose**: Automated npm publishing on version tags

Tasks:
- Create `.github/workflows/release.yml`
- Configure NPM_TOKEN secret
- Set up GitHub release creation
- Add provenance attestation for npm
- Document release process

Trigger: Push of `v*.*.*` tags

### 4. Issue and PR Templates (Issue #4)

**Purpose**: Standardize contributions

Tasks:
- Create `.github/ISSUE_TEMPLATE/bug_report.md`
- Create `.github/ISSUE_TEMPLATE/feature_request.md`
- Create `.github/ISSUE_TEMPLATE/config.yml`
- Create `.github/PULL_REQUEST_TEMPLATE.md`

### 5. CODEOWNERS (Issue #5)

**Purpose**: Automatic review assignment

Tasks:
- Create `.github/CODEOWNERS`
- Define ownership for `/src/`, `/.github/`, `/package.json`
- Note: Requires creating GitHub teams

### 6. CodeQL Security Scanning (Issue #6)

**Purpose**: Automated vulnerability detection

Tasks:
- Create `.github/workflows/codeql.yml`
- Configure for JavaScript/TypeScript
- Run on PRs, pushes, and weekly schedule
- Enable security alerts in repo settings

### 7. Dependabot (Issue #7)

**Purpose**: Automated dependency updates

Tasks:
- Create `.github/dependabot.yml`
- Configure npm ecosystem updates (weekly)
- Configure GitHub Actions updates (weekly)
- Set up update grouping

## Prerequisites

- GitHub teams must be created for CODEOWNERS:
  - `@MCPAQL/maintainers`
  - `@MCPAQL/adapter-maintainers` (optional, can reuse maintainers)
- NPM_TOKEN secret must be configured for releases
- Branch protection requires GitHub Pro for private repos

## Recommended Order

1. CI workflow (#2) - Test infrastructure first
2. CodeQL (#6) and Dependabot (#7) - Security early
3. Git flow (#1) - Can now require CI in protection
4. Templates (#4) and CODEOWNERS (#5) - Process
5. Release workflow (#3) - Last, needs package ready

## Reference

See `MCPAQL/spec` repository for examples of completed infrastructure.
