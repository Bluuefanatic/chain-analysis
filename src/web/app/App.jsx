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
    const [blkFile, setBlkFile] = useState(null);
    const [revFile, setRevFile] = useState(null);
    const [xorFile, setXorFile] = useState(null);
    const [uploading, setUploading] = useState(false);

    function refreshBlockList(nextSelected = null) {
        return fetch('/api/blocks')
            .then(r => r.json())
            .then(data => {
                if (data.ok && data.blocks.length > 0) {
                    setBlockList(data.blocks);

                    if (typeof nextSelected === 'number') {
                        setSelectedHeight(nextSelected);
                        return;
                    }

                    if (selectedHeight === null) {
                        setSelectedHeight(data.blocks[0].block_height);
                    }
                }
            });
    }

    // Fetch the list of available blocks on mount
    useEffect(() => {
        refreshBlockList()
            .catch(() => setError('Failed to connect to API. Is the server running?'));
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

    function handleUploadAnalyze() {
        if (!blkFile || !revFile || !xorFile) {
            setError('Please select blk.dat, rev.dat, and xor.dat before uploading.');
            return;
        }

        setError(null);
        setUploading(true);

        const formData = new FormData();
        formData.append('blkFile', blkFile);
        formData.append('revFile', revFile);
        formData.append('xorFile', xorFile);

        fetch('/api/upload', {
            method: 'POST',
            body: formData,
        })
            .then(r => r.json())
            .then(async data => {
                if (!data.ok) {
                    setError(data.error ?? 'Upload failed.');
                    return;
                }

                const uploadedHeights = data.uploaded_block_heights ?? [];
                const nextHeight = uploadedHeights.length > 0
                    ? uploadedHeights[uploadedHeights.length - 1]
                    : null;

                if (data.block) {
                    setBlockData(data.block);
                    setExpandedTxid(null);
                    setFilter('all');
                }

                await refreshBlockList(nextHeight);
            })
            .catch(() => setError('Failed to upload and analyze files.'))
            .finally(() => setUploading(false));
    }

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

                <section className="upload-panel">
                    <h2>Upload Raw Block Files</h2>
                    <div className="upload-grid">
                        <label>
                            blk.dat
                            <input
                                type="file"
                                accept=".dat"
                                onChange={e => setBlkFile(e.target.files?.[0] ?? null)}
                            />
                        </label>
                        <label>
                            rev.dat
                            <input
                                type="file"
                                accept=".dat"
                                onChange={e => setRevFile(e.target.files?.[0] ?? null)}
                            />
                        </label>
                        <label>
                            xor.dat
                            <input
                                type="file"
                                accept=".dat"
                                onChange={e => setXorFile(e.target.files?.[0] ?? null)}
                            />
                        </label>
                    </div>
                    <button
                        type="button"
                        className="upload-btn"
                        onClick={handleUploadAnalyze}
                        disabled={uploading}
                    >
                        {uploading ? 'Analyzing…' : 'Upload & Analyze'}
                    </button>
                </section>

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
