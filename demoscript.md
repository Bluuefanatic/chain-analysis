# Sherlock Demo Script — Under 2 Minutes

**Screen setup:** browser open at http://127.0.0.1:3000, showing Block #847,493.
**Total target time:** ~110 seconds speaking + ~10 seconds for clicks = under 2 minutes.

---

## [0:00 – 0:14] INTRO — What chain analysis is

*[Block stats panel visible in background]*

> "Bitcoin is public but pseudonymous — every transaction is visible on-chain, but addresses aren't labelled. Chain analysis uses pattern recognition to reverse that anonymity. Sherlock is a local analysis engine. Let's walk through a real block."

---

## [0:14 – 0:28] BLOCK-LEVEL STATISTICS

*[Point at the stats panel: TRANSACTIONS, FLAGGED, fee cards, script bar, heuristic chips]*

> "Block 847,493 holds 3,572 transactions. Already, 2,566 of them — 72% — triggered at least one heuristic. Fee rates ranged from 3 to 900 sat-per-vbyte, median 33. The coloured bar shows output script types: SegWit and Taproot dominate, but legacy P2PKH is still present — useful for fingerprinting older wallet software."

---

## [0:28 – 0:50] COMMON INPUT OWNERSHIP HEURISTIC (CIOH)

*[Click **Consolidation** filter tab → scroll to / click on txid `75e43e68424a54a3…c00d48d2` → expand row]*

> "The Common Input Ownership Heuristic says: if a transaction spends multiple UTXOs, they almost certainly belong to the same wallet. Here's an extreme example — 126 inputs collapsed into a single output. One entity just swept 126 separate coins into one. That's a clustering signal: 126 coin histories now link to the same owner."

> "Important nuance: Sherlock still marks CIOH as detected here, but confidence can fall to near zero at very high input counts. That's intentional — large fan-in transactions can overlap with collaborative patterns, so we keep the signal but down-weight certainty."

---

## [0:50 – 1:07] CHANGE DETECTION

*[Click **All** tab → click on txid `60da3a5044f46b7e…75a8b44f` → expand row → point at "change → output #1"]*

> "Most payments send change back to yourself. Change detection identifies which output is yours. For this transaction, Sherlock flags output number 1 as likely change — the script type matches the inputs, it's the smaller of the two outputs, and it's not a round number. The other output is the actual payment."

---

## [1:07 – 1:25] COINJOIN — AND A SPECIFIC INTERESTING TRANSACTION

*[Click **CoinJoin** filter tab → click on txid `a64680586f5db485…ab48762f` → expand row]*

> "CoinJoin is a privacy technique where multiple people combine inputs to produce many equal-value outputs — breaking the link between sender and recipient. This transaction has 100 outputs of exactly 44,790 satoshis each. Sherlock detected it via the equal-output count. Notice the classification overrides CIOH — the more specific label wins."

---

## [1:25 – 1:45] TRANSACTION CLASSIFICATION + WRAP-UP

*[Show filter tabs — click through Simple Payment, Batch Payment, Self Transfer briefly]*

> "Every transaction gets one label: simple payment, batch payment, consolidation, CoinJoin, self-transfer, or unknown. In this block: 27 CoinJoins trying to hide, 168 consolidations revealing wallet sweeps, 630 batch payments showing merchant activity. Together, six heuristics flag 72% of transactions — that's what chain analysis reveals about Bitcoin's so-called privacy."

---

## UI COVERAGE CHECKLIST

| Required topic | UI element used |
|---|---|
| What chain analysis is + why it matters | Intro narration over live block stats |
| CIOH — assumes + reveals | Consolidation filter → 126-input tx expanded → CIOH detected state + low confidence nuance shown |
| Change detection | Simple payment tx expanded → "change → output #1" + method shown |
| Another heuristic (CoinJoin) | CoinJoin filter → 100-equal-output tx → denomination_sats shown |
| Transaction classification | Filter tabs (All / Simple Payment / CoinJoin / etc.) + ClassificationBadge |
| Block-level stats (fees, scripts, flagged) | Stats cards + script type bar + FLAGGED card |
| Specific interesting transaction | `a64680586f5db485…ab48762f` — 100-output CoinJoin |

---

## KEY TXIDS TO NAVIGATE TO

| Transaction | Short TXID (shown in UI) | Why notable |
|---|---|---|
| Consolidation | `75e43e68424a54a3…c00d48d2` | 126 inputs → 1 output, ratio 126.0 |
| Change Detection + Address Reuse | `60da3a5044f46b7e…75a8b44f` | Change at output #1; reused script |
| CoinJoin (STAR tx) | `a64680586f5db485…ab48762f` | 100 equal outputs @ 44,790 sat |