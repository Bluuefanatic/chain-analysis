import { Fragment } from 'react';
import ClassificationBadge from './ClassificationBadge.jsx';
import HeuristicResults from './HeuristicResults.jsx';

// CoinJoin and Consolidation get a highlighted row (potential privacy concern)
const HIGHLIGHTED = new Set(['coinjoin', 'consolidation']);

export default function TransactionList({ transactions, expandedTxid, onExpand }) {
    if (transactions.length === 0) {
        return (
            <p className="no-data">No transactions match the current filter.</p>
        );
    }

    return (
        <div className="tx-list">
            <table className="tx-table">
                <thead>
                    <tr>
                        <th>TXID</th>
                        <th>Classification</th>
                        <th>Heuristics Detected</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    {transactions.map(tx => {
                        const isExpanded = expandedTxid === tx.txid;
                        const detectedCount = Object.values(tx.heuristics ?? {}).filter(
                            r => r?.detected
                        ).length;
                        const isHighlight = HIGHLIGHTED.has(tx.classification);

                        return (
                            <Fragment key={tx.txid}>
                                <tr
                                    className={[
                                        'tx-row',
                                        isHighlight ? 'tx-row--highlight' : '',
                                        isExpanded ? 'tx-row--expanded' : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                    onClick={() => onExpand(isExpanded ? null : tx.txid)}
                                    title={tx.txid}
                                >
                                    <td className="tx-txid">
                                        <code>
                                            {tx.txid?.slice(0, 16)}…{tx.txid?.slice(-8)}
                                        </code>
                                    </td>

                                    <td>
                                        <ClassificationBadge
                                            classification={tx.classification}
                                        />
                                    </td>

                                    <td className="tx-detected">
                                        {detectedCount > 0 ? (
                                            <span className="detected-count">
                                                {detectedCount} detected
                                            </span>
                                        ) : (
                                            <span className="none-detected">—</span>
                                        )}
                                    </td>

                                    <td className="tx-expand-btn">
                                        {isExpanded ? '▲' : '▼'}
                                    </td>
                                </tr>

                                {isExpanded && (
                                    <tr className="tx-detail-row">
                                        <td colSpan={4}>
                                            <HeuristicResults heuristics={tx.heuristics} />
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
