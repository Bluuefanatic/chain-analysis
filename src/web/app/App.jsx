import { useState, useEffect } from 'react';
import BlockSelector from './components/BlockSelector.jsx';
import BlockStats from './components/BlockStats.jsx';
import ClassificationFilter from './components/ClassificationFilter.jsx';
import TransactionList from './components/TransactionList.jsx';

export default function App() {
    const [blockList, setBlockList] = useState([]);
    const [selectedHeight, setSelectedHeight] = useState(null);
    const [blockData, setBlockData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [filter, setFilter] = useState('all');
    const [expandedTxid, setExpandedTxid] = useState(null);
    const [error, setError] = useState(null);

    // Fetch the list of available blocks on mount
    useEffect(() => {
        fetch('/api/blocks')
            .then(r => r.json())
            .then(data => {
                if (data.ok && data.blocks.length > 0) {
                    setBlockList(data.blocks);
                    setSelectedHeight(data.blocks[0].block_height);
                }
            })
            .catch(() => setError('Failed to connect to API. Is the server running?'));
    }, []);

    // Fetch block detail whenever the selected height changes
    useEffect(() => {
        if (selectedHeight === null) return;
        setLoading(true);
        setBlockData(null);
        setExpandedTxid(null);
        setFilter('all');
        fetch(`/api/block/${selectedHeight}`)
            .then(r => r.json())
            .then(data => {
                if (data.ok) setBlockData(data.block);
                else setError(`Block at height ${selectedHeight} not found.`);
                setLoading(false);
            })
            .catch(() => {
                setError('Failed to load block data.');
                setLoading(false);
            });
    }, [selectedHeight]);

    const transactions = blockData?.transactions ?? [];
    const filtered =
        filter === 'all'
            ? transactions
            : transactions.filter(tx => tx.classification === filter);

    return (
        <div className="app">
            <header className="app-header">
                <div className="header-brand">
                    <span className="header-icon">🔍</span>
                    <h1>Sherlock</h1>
                    <span className="header-sub">Bitcoin Chain Analysis</span>
                </div>
                <BlockSelector
                    blocks={blockList}
                    selected={selectedHeight}
                    onSelect={h => setSelectedHeight(h)}
                />
            </header>

            <main className="app-main">
                {error && <div className="error-banner">⚠ {error}</div>}

                {!loading && !error && blockList.length === 0 && (
                    <div className="empty-state">
                        <p>No analysis data found.</p>
                        <p>
                            Run <code>./cli.sh --block &lt;blk.dat&gt; &lt;rev.dat&gt; &lt;xor.dat&gt;</code> to
                            generate reports, then restart the server.
                        </p>
                    </div>
                )}

                {loading && <div className="spinner">Loading block #{selectedHeight}…</div>}

                {blockData && (
                    <>
                        <BlockStats block={blockData} />

                        <section className="transactions-section">
                            <div className="transactions-header">
                                <h2>
                                    Transactions&nbsp;
                                    <span className="tx-count">
                                        {filtered.length} / {transactions.length}
                                    </span>
                                </h2>
                                <ClassificationFilter
                                    transactions={transactions}
                                    active={filter}
                                    onFilter={f => {
                                        setFilter(f);
                                        setExpandedTxid(null);
                                    }}
                                />
                            </div>
                            <TransactionList
                                transactions={filtered}
                                expandedTxid={expandedTxid}
                                onExpand={setExpandedTxid}
                            />
                        </section>
                    </>
                )}
            </main>
        </div>
    );
}
