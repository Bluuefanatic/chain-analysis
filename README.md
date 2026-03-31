# Sherlock

Sherlock is a Bitcoin block analysis toolkit that parses raw block artifacts and surfaces behavioral heuristics through both machine-readable reports and an interactive web explorer.

It was originally built during the Summer of Bitcoin challenge and has been refined into a reusable, contributor-friendly project focused on transparent heuristic analysis.

## Why Sherlock

- Works directly from raw Bitcoin data files: blk.dat, rev.dat, and xor.dat.
- Produces reproducible outputs suitable for research notes, dashboards, and audits.
- Keeps heuristic logic explicit and inspectable rather than hidden behind black-box scoring.
- Supports both CLI-first workflows and browser-based exploration.

## Core Features

- Raw parsing pipeline for block and undo files.
- Heuristic engine with pluggable detectors.
- Transaction classification into:
  - simple_payment
  - consolidation
  - coinjoin
  - self_transfer
  - batch_payment
  - unknown
- JSON and Markdown report generation.
- Web UI with:
  - block selector
  - statistics cards
  - script type distribution
  - heuristic chips
  - classification filters
  - transaction table with expandable details
- Upload and analyze flow for blk.dat, rev.dat, xor.dat from the UI, using the same analysis pipeline as preloaded data.

## Architecture

```text
blk.dat + rev.dat + xor.dat
        |
        v
Parsers (block, transaction, rev)
        |
        v
Heuristic engine (cioh, change_detection, coinjoin, consolidation, address_reuse, round_number_payment)
        |
        v
Classifier + stats aggregation
        |
        v
Report writers (JSON + Markdown)
        |
        v
Web API + React visualizer
```

For detailed heuristic design notes and trade-offs, see APPROACH.md.

## Tech Stack

- Node.js 20.x
- ESM modules
- React + Vite
- Node built-in HTTP server for API and static hosting

## Repository Layout

```text
src/
  parser/         # blk/rev/tx parsing
  heuristics/     # heuristic implementations
  analysis/       # classifier, fee stats, script types, heuristic runner
  reports/        # json + markdown report generators
  web/            # API server + React app
out/              # generated and committed report outputs
fixtures/         # sample block artifacts
```

## Quick Start

### 1. Setup

```bash
./setup.sh
```

This installs dependencies and decompresses fixture files.

### 2. Run CLI analysis

```bash
./cli.sh --block fixtures/blk04330.dat fixtures/rev04330.dat fixtures/xor.dat
```

Expected outputs:

- out/blk04330.json
- out/blk04330.md

### 3. Start the web app

```bash
./web.sh
```

The command prints a URL, typically:

```text
http://127.0.0.1:3000
```

Open it in your browser and explore results.

## Upload and Analyze from UI

The web app supports direct upload of:

- blk.dat
- rev.dat
- xor.dat

Use the Upload and Analyze section in the UI.

Implementation notes:

- Files are sent to POST /api/upload.
- Backend invokes the existing CLI analysis pipeline.
- The resulting block data is indexed into the same in-memory store used by preloaded reports.
- UI reuses existing rendering/state paths, so all current views update without a separate code path.

## API Overview

- GET /api/health
  - Returns service health and data counts.
- GET /api/blocks
  - Returns list of loaded blocks with summary metadata.
- GET /api/block/:height
  - Returns one analyzed block by height.
- GET /api/tx/:txid
  - Returns one transaction and block context.
- POST /api/upload
  - Accepts multipart form with blkFile, revFile, xorFile.
  - Runs analysis and returns analyzed block payload.

## NPM Scripts

- npm run setup
- npm run cli
- npm run web
- npm run build:web
- npm run dev:web
- npm run test
- npm run test:parser

## Development Workflow

### Run tests

```bash
npm run test
```

### Frontend development mode

```bash
npm run dev:web
```

Vite serves the UI and proxies /api requests to the backend on PORT (default 3000).

### Build frontend

```bash
npm run build:web
```

## Output Contracts

JSON reports are emitted in a consistent schema used by both CLI consumers and the web app. See source and tests under:

- src/reports/jsonReport.js
- src/reports/jsonReport.test.js

Markdown reports are generated for human review under:

- src/reports/markdownReport.js
- src/reports/markdownReport.test.js

## Demo

Demo walkthrough link is available in demo.md.

## Contributing

Contributions are welcome, especially around:

- additional heuristics
- false-positive analysis and confidence calibration
- richer visual analytics
- performance improvements for large block files
- test coverage for edge-case transactions

Suggested PR checklist:

- add or update tests with each behavior change
- keep CLI and web paths consistent with the same analysis pipeline
- avoid schema-breaking output changes unless intentionally versioned
- document notable trade-offs in APPROACH.md

## Roadmap Ideas

- streaming analysis progress in UI for large uploads
- optional persistence layer for analyzed datasets
- heuristic explainability panels with comparative signals
- benchmark suite for parser and report generation speed

## Acknowledgments

Built as part of Summer of Bitcoin and expanded as a practical open-source chain analysis project.
