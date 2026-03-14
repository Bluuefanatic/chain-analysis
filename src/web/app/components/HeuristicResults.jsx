const HEURISTIC_LABELS = {
    cioh: 'Common Input Ownership',
    change_detection: 'Change Detection',
    coinjoin: 'CoinJoin Detection',
    consolidation: 'Consolidation',
    address_reuse: 'Address Reuse',
    round_number_payment: 'Round Number Payment',
};

function formatConfidenceLabel(confidence) {
    if (typeof confidence !== 'number') return null;

    const pct = confidence * 100;

    // Some heuristics intentionally down-weight confidence for edge cases
    // (e.g. very high input-count CIOH). Show an explanatory label instead of
    // a bare 0% to avoid implying "not detected".
    if (pct === 0) return 'very low confidence';
    if (pct < 1) return `${pct.toFixed(1)}% confidence`;
    return `${pct.toFixed(0)}% confidence`;
}

function formatNumber(n) {
    return new Intl.NumberFormat('en-US').format(n);
}

function formatRatio(ratio) {
    if (typeof ratio !== 'number') return null;
    return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

function buildHeuristicFacts(result) {
    const facts = [];

    if (typeof result?.input_count === 'number') {
        facts.push(`inputs: ${formatNumber(result.input_count)}`);
    }

    if (typeof result?.output_count === 'number') {
        facts.push(`outputs: ${formatNumber(result.output_count)}`);
    }

    if (typeof result?.ratio === 'number') {
        facts.push(`ratio: ${formatRatio(result.ratio)}`);
    }

    if (typeof result?.equal_output_count === 'number' && result.equal_output_count > 0) {
        facts.push(`equal outputs: ${formatNumber(result.equal_output_count)}`);
    }

    if (typeof result?.denomination_sats === 'number' && result.denomination_sats > 0) {
        facts.push(`denomination: ${formatNumber(result.denomination_sats)} sat`);
    }

    if (typeof result?.cadence_sats === 'number' && result.cadence_sats > 0) {
        facts.push(`cadence: ${formatNumber(result.cadence_sats)} sat`);
    }

    if (Array.isArray(result?.reused_indices) && result.reused_indices.length > 0) {
        const sample = result.reused_indices.slice(0, 3).join(', ');
        const suffix = result.reused_indices.length > 3 ? ', ...' : '';
        facts.push(`reused outputs: #${sample}${suffix}`);
    }

    if (Array.isArray(result?.payment_indices) && result.payment_indices.length > 0) {
        const sample = result.payment_indices.slice(0, 3).join(', ');
        const suffix = result.payment_indices.length > 3 ? ', ...' : '';
        facts.push(`round outputs: #${sample}${suffix}`);
    }

    return facts;
}

export default function HeuristicResults({ heuristics }) {
    const entries = Object.entries(heuristics ?? {});

    if (entries.length === 0) {
        return <p className="no-heuristics">No heuristic data available.</p>;
    }

    // Show detected heuristics first
    const sorted = [...entries].sort(([, a], [, b]) =>
        (b?.detected ? 1 : 0) - (a?.detected ? 1 : 0)
    );

    return (
        <div className="heuristic-results">
            {sorted.map(([id, result]) => (
                <div
                    key={id}
                    className={`heuristic-row ${result?.detected ? 'detected' : 'not-detected'}`}
                >
                    <span className="heuristic-indicator">
                        {result?.detected ? '●' : '○'}
                    </span>

                    <span className="heuristic-name">
                        {HEURISTIC_LABELS[id] ?? id}
                    </span>

                    {result?.detected && result?.confidence !== undefined && (
                        <span className="heuristic-confidence">
                            {formatConfidenceLabel(result.confidence)}
                        </span>
                    )}

                    {result?.detected && result?.method && (
                        <span className="heuristic-method">
                            via {result.method}
                        </span>
                    )}

                    {result?.detected && result?.likely_change_index !== undefined && (
                        <span className="heuristic-detail">
                            change → output #{result.likely_change_index}
                        </span>
                    )}

                    {result?.detected &&
                        buildHeuristicFacts(result).map((fact, idx) => (
                            <span key={`${id}-fact-${idx}`} className="heuristic-detail">
                                {fact}
                            </span>
                        ))}
                </div>
            ))}
        </div>
    );
}
