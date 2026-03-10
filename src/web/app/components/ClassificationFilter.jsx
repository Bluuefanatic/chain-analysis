import { CLASSIFICATION_COLORS, CLASSIFICATION_LABELS } from './ClassificationBadge.jsx';

const ALL_CLASSES = [
    'simple_payment',
    'consolidation',
    'coinjoin',
    'self_transfer',
    'batch_payment',
    'unknown',
];

export default function ClassificationFilter({ transactions, active, onFilter }) {
    // Tally transactions per classification
    const counts = {};
    for (const tx of transactions) {
        const c = tx.classification ?? 'unknown';
        counts[c] = (counts[c] ?? 0) + 1;
    }

    // Only show buttons for classifications that actually appear
    const present = ALL_CLASSES.filter(c => counts[c] > 0);

    return (
        <div className="filter-bar">
            <button
                className={`filter-btn${active === 'all' ? ' active' : ''}`}
                onClick={() => onFilter('all')}
            >
                All ({transactions.length})
            </button>

            {present.map(cls => {
                const c = CLASSIFICATION_COLORS[cls];
                const isActive = active === cls;
                return (
                    <button
                        key={cls}
                        className={`filter-btn${isActive ? ' active' : ''}`}
                        style={
                            isActive
                                ? { backgroundColor: c.bg, color: c.text, borderColor: c.border }
                                : {}
                        }
                        onClick={() => onFilter(cls)}
                    >
                        {CLASSIFICATION_LABELS[cls]} ({counts[cls]})
                    </button>
                );
            })}
        </div>
    );
}
