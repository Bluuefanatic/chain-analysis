// Script-type colour palette (matches Bitcoin output type significance)
const SCRIPT_COLORS = {
    p2wpkh: '#3b82f6',
    p2tr: '#8b5cf6',
    p2sh: '#f59e0b',
    p2pkh: '#10b981',
    p2wsh: '#06b6d4',
    op_return: '#ef4444',
    unknown: '#64748b',
};

export default function BlockStats({ block }) {
    const s = block.analysis_summary ?? {};
    const fee = s.fee_rate_stats ?? {};
    const dist = s.script_type_distribution ?? {};

    return (
        <section className="block-stats">
            <div className="stats-header">
                <h2>Block #{block.block_height}</h2>
                <span className="block-hash" title={block.block_hash}>
                    {block.block_hash?.slice(0, 20)}…
                </span>
            </div>

            <div className="stats-grid">
                <StatCard
                    label="Transactions"
                    value={s.total_transactions_analyzed ?? block.tx_count ?? 0}
                />
                <StatCard
                    label="Flagged"
                    value={s.flagged_transactions ?? 0}
                    highlight
                />
                <StatCard label="Min Fee" value={`${fee.min_sat_vb ?? 0} sat/vB`} />
                <StatCard label="Median Fee" value={`${fee.median_sat_vb ?? 0} sat/vB`} />
                <StatCard label="Max Fee" value={`${fee.max_sat_vb ?? 0} sat/vB`} />
                <StatCard label="Mean Fee" value={`${fee.mean_sat_vb ?? 0} sat/vB`} />
            </div>

            <ScriptDistribution dist={dist} />

            <div className="heuristics-applied">
                <h3>Heuristics Applied</h3>
                <div className="heuristic-tags">
                    {(s.heuristics_applied ?? []).map(h => (
                        <span key={h} className="heuristic-tag">{h}</span>
                    ))}
                    {(s.heuristics_applied ?? []).length === 0 && (
                        <span className="heuristic-tag" style={{ color: '#64748b' }}>none</span>
                    )}
                </div>
            </div>
        </section>
    );
}

function StatCard({ label, value, highlight = false }) {
    return (
        <div className={`stat-card${highlight ? ' stat-card--highlight' : ''}`}>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
        </div>
    );
}

function ScriptDistribution({ dist }) {
    const total = Object.values(dist).reduce((s, v) => s + v, 0);
    const entries = Object.entries(dist).filter(([, v]) => v > 0);

    return (
        <div className="script-dist">
            <h3>Output Script Types</h3>
            {total === 0 ? (
                <p className="no-data" style={{ padding: 0, textAlign: 'left' }}>
                    No output data
                </p>
            ) : (
                <>
                    <div className="bar-track">
                        {entries.map(([type, count]) => (
                            <div
                                key={type}
                                className="bar-segment"
                                style={{
                                    width: `${((count / total) * 100).toFixed(2)}%`,
                                    backgroundColor: SCRIPT_COLORS[type] ?? '#64748b',
                                }}
                                title={`${type}: ${count} (${((count / total) * 100).toFixed(1)}%)`}
                            />
                        ))}
                    </div>

                    <div className="bar-legend">
                        {entries.map(([type, count]) => (
                            <span key={type} className="legend-item">
                                <span
                                    className="legend-dot"
                                    style={{ backgroundColor: SCRIPT_COLORS[type] ?? '#64748b' }}
                                />
                                {type}&nbsp;({count})
                            </span>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
