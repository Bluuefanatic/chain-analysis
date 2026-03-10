export const CLASSIFICATION_COLORS = {
    simple_payment: { bg: '#dbeafe', text: '#1d4ed8', border: '#93c5fd' },
    consolidation: { bg: '#fff7ed', text: '#c2410c', border: '#fdba74' },
    coinjoin: { bg: '#fef2f2', text: '#b91c1c', border: '#fca5a5' },
    self_transfer: { bg: '#f0fdf4', text: '#15803d', border: '#86efac' },
    batch_payment: { bg: '#faf5ff', text: '#7e22ce', border: '#d8b4fe' },
    unknown: { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' },
};

export const CLASSIFICATION_LABELS = {
    simple_payment: 'Simple Payment',
    consolidation: 'Consolidation',
    coinjoin: 'CoinJoin',
    self_transfer: 'Self Transfer',
    batch_payment: 'Batch Payment',
    unknown: 'Unknown',
};

export default function ClassificationBadge({ classification }) {
    const c = CLASSIFICATION_COLORS[classification] ?? CLASSIFICATION_COLORS.unknown;
    return (
        <span
            className="badge"
            style={{ backgroundColor: c.bg, color: c.text, borderColor: c.border }}
        >
            {CLASSIFICATION_LABELS[classification] ?? classification}
        </span>
    );
}
