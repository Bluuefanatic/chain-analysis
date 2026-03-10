const HEURISTIC_LABELS = {
    cioh: 'Common Input Ownership',
    change_detection: 'Change Detection',
    coinjoin: 'CoinJoin Detection',
    consolidation: 'Consolidation',
    address_reuse: 'Address Reuse',
    round_number_payment: 'Round Number Payment',
};

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
                            {(result.confidence * 100).toFixed(0)}% confidence
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
                </div>
            ))}
        </div>
    );
}
