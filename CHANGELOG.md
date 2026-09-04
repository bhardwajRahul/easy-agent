# Changelog

All notable changes to Easy Agent are documented in this file.

## [Unreleased]

## [0.1.1] - 2026-09-04

### Changed

- Updated the public project status after the first npm publication and registry cold-cache verification.

## [0.1.0] - 2026-08-15

### Added

- First npm-distributable Easy Agent CLI release.
- Single-file ESM bundle with source maps and no runtime dependency tree.
- Node.js 22 runtime gate, npm package boundary checks, and release verification.
- npm-backed macOS/Linux installer and provenance-enabled tag release workflow.

### Changed

- The npm package and primary command are named `eagent`.
- `easy-agent` is installed as the long command alias.
- The former development-only `agent` command is no longer registered because it is ambiguous and collision-prone.
