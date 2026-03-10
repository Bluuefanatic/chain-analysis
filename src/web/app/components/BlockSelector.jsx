export default function BlockSelector({ blocks, selected, onSelect }) {
    if (blocks.length === 0) return null;

    return (
        <div className="block-selector">
            <label htmlFor="block-select">Block Height</label>
            <select
                id="block-select"
                value={selected ?? ''}
                onChange={e => onSelect(Number(e.target.value))}
            >
                {blocks.map(b => (
                    <option key={b.block_height} value={b.block_height}>
                        #{b.block_height} — {b.tx_count} txs
                        {b.flagged_transactions > 0
                            ? ` · ${b.flagged_transactions} flagged`
                            : ''}
                    </option>
                ))}
            </select>
        </div>
    );
}
