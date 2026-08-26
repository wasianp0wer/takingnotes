import { useCallback, useEffect, useRef, useState } from 'react';

import { HuionNoteBLE, type HuionPage, type HuionPenPoint } from '@/utils/huionBLE';

/**
 * Probe for task #2: does the Huion Note write to internal memory (ROM)
 * while it is live-streaming over BLE?
 *
 * Method: snapshot ROM, stream and write, snapshot ROM again, diff.
 *
 * Confound this probe is built to expose: the pad may only commit the
 * *current* page to ROM on a page turn. A "no change" result is therefore
 * ambiguous until you also run the page-turn variant, which is why the
 * experiments below are run as a set rather than a single test.
 */

interface PageStat {
  pageNum: number;
  strokes: number;
  points: number;
}

interface Snapshot {
  id: number;
  label: string;
  at: string;
  pageCount: number;
  totalStrokes: number;
  totalPoints: number;
  pages: PageStat[];
  suspectTruncated: boolean;
  durationMs: number;
}

interface LiveStats {
  points: number;
  strokes: number;
  pageTurns: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

const EMPTY_LIVE: LiveStats = { points: 0, strokes: 0, pageTurns: 0, bbox: null };

const EXPERIMENTS = [
  {
    id: 'control',
    title: 'A. Control — offline write',
    detail:
      'Do NOT stream. Snapshot, write a mark on paper, press the page-turn button, snapshot again. ' +
      'Establishes that ROM capture works at all and whether a page turn is needed to commit.',
  },
  {
    id: 'stream-no-turn',
    title: 'B. Stream, no page turn',
    detail:
      'Snapshot, start streaming, write a mark, stop streaming, snapshot again. ' +
      'If ROM gained ink, the pad stores while streaming and commits without a page turn.',
  },
  {
    id: 'stream-with-turn',
    title: 'C. Stream, then page turn',
    detail:
      'Snapshot, start streaming, write a mark, press the page-turn button, stop streaming, snapshot again. ' +
      'Disambiguates B: if C gains ink but B did not, the pad stores while streaming but only commits on page turn.',
  },
] as const;

function summarizePages(pages: HuionPage[]): PageStat[] {
  return pages.map((page) => ({
    pageNum: page.pageNum,
    strokes: page.strokes.length,
    points: page.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
  }));
}

function diffSnapshots(before: Snapshot, after: Snapshot) {
  const beforeByPage = new Map(before.pages.map((p) => [p.pageNum, p]));
  const afterByPage = new Map(after.pages.map((p) => [p.pageNum, p]));

  const newPages: PageStat[] = [];
  const changedPages: { pageNum: number; pointsBefore: number; pointsAfter: number }[] = [];

  for (const [pageNum, afterPage] of afterByPage) {
    const beforePage = beforeByPage.get(pageNum);
    if (!beforePage) {
      newPages.push(afterPage);
    } else if (beforePage.points !== afterPage.points) {
      changedPages.push({
        pageNum,
        pointsBefore: beforePage.points,
        pointsAfter: afterPage.points,
      });
    }
  }

  const gainedPoints =
    newPages.reduce((sum, p) => sum + p.points, 0) +
    changedPages.reduce((sum, p) => sum + (p.pointsAfter - p.pointsBefore), 0);

  return {
    pageCountDelta: after.pageCount - before.pageCount,
    newPages,
    changedPages,
    gainedPoints,
    romChanged: newPages.length > 0 || changedPages.length > 0,
  };
}

export function ProbeApp() {
  const huionRef = useRef<HuionNoteBLE | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastLivePointRef = useRef<HuionPenPoint | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [status, setStatus] = useState('Not connected');
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [live, setLive] = useState<LiveStats>(EMPTY_LIVE);
  const [snapshotLabel, setSnapshotLabel] = useState('before');
  const [truncationSeen, setTruncationSeen] = useState(false);

  const addLog = useCallback((msg: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${msg}`;
    setLog((prev) => [...prev.slice(-600), line]);
    if (/timed out|interrupted by disconnect/i.test(msg)) {
      setTruncationSeen(true);
    }
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const drawLivePoint = useCallback((point: HuionPenPoint) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const previous = lastLivePointRef.current;
    const down = point.status > 0;

    if (down && previous && previous.status > 0) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, point.pressure * 4);
      ctx.beginPath();
      ctx.moveTo(previous.x * canvas.width, previous.y * canvas.height);
      ctx.lineTo(point.x * canvas.width, point.y * canvas.height);
      ctx.stroke();
    }

    lastLivePointRef.current = point;
  }, []);

  const handlePen = useCallback((point: HuionPenPoint) => {
    // Read the previous pen state BEFORE drawLivePoint overwrites the ref.
    const wasDown = (lastLivePointRef.current?.status ?? 0) > 0;
    const isDown = point.status > 0;
    const startedStroke = isDown && !wasDown;

    drawLivePoint(point);

    setLive((prev) => {
      const bbox = prev.bbox ?? { minX: 1, minY: 1, maxX: 0, maxY: 0 };
      return {
        ...prev,
        points: prev.points + 1,
        strokes: prev.strokes + (startedStroke ? 1 : 0),
        bbox: isDown
          ? {
              minX: Math.min(bbox.minX, point.x),
              minY: Math.min(bbox.minY, point.y),
              maxX: Math.max(bbox.maxX, point.x),
              maxY: Math.max(bbox.maxY, point.y),
            }
          : prev.bbox,
      };
    });
  }, [drawLivePoint]);

  const connect = useCallback(async () => {
    setBusy('Connecting');
    try {
      const huion = new HuionNoteBLE();
      huion.onLog = (msg) => { addLog(msg); console.log('[huion]', msg); };
      huion.onStatus = setStatus;
      huion.onPen = handlePen;
      huion.onNextPage = () => {
        addLog('*** PAGE TURN button pressed (0x8A) ***');
        setLive((prev) => ({ ...prev, pageTurns: prev.pageTurns + 1 }));
      };
      huionRef.current = huion;

      await huion.connect();
      setConnected(true);
      setDeviceName(huion.deviceName);
      addLog(
        `Connected. model="${huion.config.modelName}" isA4=${huion.config.isA4} ` +
        `page=${huion.config.pageWidth}x${huion.config.pageHeight} battery=${huion.config.battery}`,
      );
    } catch (error) {
      addLog(`CONNECT FAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [addLog, handlePen]);

  const disconnect = useCallback(async () => {
    setBusy('Disconnecting');
    try {
      await huionRef.current?.disconnect();
    } finally {
      huionRef.current = null;
      setConnected(false);
      setStreaming(false);
      setBusy(null);
    }
  }, []);

  const takeSnapshot = useCallback(async () => {
    const huion = huionRef.current;
    if (!huion) return;

    setBusy('Reading device memory (this can take ~15s per stored page)');
    setTruncationSeen(false);
    const startedAt = performance.now();

    try {
      addLog(`--- SNAPSHOT "${snapshotLabel}" start ---`);
      const pages = await huion.downloadPages();
      const durationMs = Math.round(performance.now() - startedAt);
      const pageStats = summarizePages(pages);

      const snapshot: Snapshot = {
        id: Date.now(),
        label: snapshotLabel,
        at: new Date().toLocaleTimeString(),
        pageCount: pages.length,
        totalStrokes: pageStats.reduce((sum, p) => sum + p.strokes, 0),
        totalPoints: pageStats.reduce((sum, p) => sum + p.points, 0),
        pages: pageStats,
        suspectTruncated: truncationSeen,
        durationMs,
      };

      setSnapshots((prev) => [...prev, snapshot]);
      addLog(
        `--- SNAPSHOT "${snapshot.label}": ${snapshot.pageCount} pages, ` +
        `${snapshot.totalStrokes} strokes, ${snapshot.totalPoints} points (${durationMs}ms) ---`,
      );
    } catch (error) {
      addLog(`SNAPSHOT FAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [addLog, snapshotLabel, truncationSeen]);

  const startStreaming = useCallback(async () => {
    const huion = huionRef.current;
    if (!huion) return;
    setBusy('Starting stream');
    try {
      lastLivePointRef.current = null;
      setLive(EMPTY_LIVE);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);

      await huion.startStreaming();
      setStreaming(true);
      addLog('>>> STREAMING ON — write a distinctive mark on the pad now');
    } catch (error) {
      addLog(`START STREAM FAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [addLog]);

  const stopStreaming = useCallback(async () => {
    const huion = huionRef.current;
    if (!huion) return;
    setBusy('Stopping stream');
    try {
      await huion.stopStreaming();
      setStreaming(false);
      addLog(`<<< STREAMING OFF — captured ${live.points} points in ${live.strokes} strokes`);
    } catch (error) {
      addLog(`STOP STREAM FAILED: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [addLog, live.points, live.strokes]);

  const lastTwo = snapshots.slice(-2);
  const diff = lastTwo.length === 2 ? diffSnapshots(lastTwo[0], lastTwo[1]) : null;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Huion ROM / streaming probe</h1>
      <p style={S.sub}>
        Task #2 — does the pad write to internal memory while live-streaming?
        Run experiments A, B and C below, then compare each pair of snapshots.
      </p>

      <div style={S.warn}>
        <strong>Before you start:</strong> clear the pad, or start with only a page or two stored.
        Each snapshot re-downloads <em>every</em> stored page and takes roughly 15&nbsp;s per page.
        Snapshots are read-only — this probe never sends a delete command.
      </div>

      {/* ---- Connection ---- */}
      <section style={S.card}>
        <div style={S.row}>
          <button style={S.btn(!connected && !busy)} onClick={connect} disabled={connected || !!busy}>
            Connect
          </button>
          <button style={S.btn(connected && !busy)} onClick={disconnect} disabled={!connected || !!busy}>
            Disconnect
          </button>
          <span style={S.status}>
            {connected ? `${deviceName || 'connected'} — ${status}` : status}
            {streaming ? '  •  STREAMING' : ''}
          </span>
        </div>
        {busy && <div style={S.busy}>{busy}…</div>}
      </section>

      {/* ---- Experiments ---- */}
      <section style={S.card}>
        <h2 style={S.h2}>Experiments</h2>
        {EXPERIMENTS.map((experiment) => (
          <div key={experiment.id} style={S.experiment}>
            <div style={S.expTitle}>{experiment.title}</div>
            <div style={S.expDetail}>{experiment.detail}</div>
            <button
              style={S.btnSmall(connected && !busy)}
              disabled={!connected || !!busy}
              onClick={() => addLog(`===== BEGIN EXPERIMENT: ${experiment.title} =====`)}
            >
              Mark start in log
            </button>
          </div>
        ))}
      </section>

      {/* ---- Controls ---- */}
      <section style={S.card}>
        <h2 style={S.h2}>Controls</h2>
        <div style={S.row}>
          <label style={S.label}>Snapshot label</label>
          <input
            style={S.input}
            value={snapshotLabel}
            onChange={(e) => setSnapshotLabel(e.target.value)}
            placeholder="e.g. B-before"
          />
          <button style={S.btn(connected && !busy)} onClick={takeSnapshot} disabled={!connected || !!busy}>
            Snapshot ROM
          </button>
        </div>
        <div style={S.row}>
          <button
            style={S.btn(connected && !streaming && !busy)}
            onClick={startStreaming}
            disabled={!connected || streaming || !!busy}
          >
            Start streaming
          </button>
          <button
            style={S.btn(connected && streaming && !busy)}
            onClick={stopStreaming}
            disabled={!connected || !streaming || !!busy}
          >
            Stop streaming
          </button>
        </div>
      </section>

      {/* ---- Live capture ---- */}
      <section style={S.card}>
        <h2 style={S.h2}>Live capture</h2>
        <div style={S.row}>
          <Stat label="points" value={live.points} />
          <Stat label="strokes" value={live.strokes} />
          <Stat label="page turns" value={live.pageTurns} />
          <Stat
            label="bbox"
            value={
              live.bbox
                ? `${live.bbox.minX.toFixed(2)},${live.bbox.minY.toFixed(2)} → ` +
                  `${live.bbox.maxX.toFixed(2)},${live.bbox.maxY.toFixed(2)}`
                : '—'
            }
          />
        </div>
        <canvas ref={canvasRef} width={420} height={560} style={S.canvas} />
      </section>

      {/* ---- Snapshots ---- */}
      <section style={S.card}>
        <h2 style={S.h2}>Snapshots</h2>
        {snapshots.length === 0 ? (
          <div style={S.muted}>None yet.</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                {['label', 'time', 'pages', 'strokes', 'points', 'took', 'per-page points'].map((h) => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id}>
                  <td style={S.td}>
                    {snapshot.label}
                    {snapshot.suspectTruncated && <span style={S.badge}>TRUNCATED?</span>}
                  </td>
                  <td style={S.td}>{snapshot.at}</td>
                  <td style={S.td}>{snapshot.pageCount}</td>
                  <td style={S.td}>{snapshot.totalStrokes}</td>
                  <td style={S.td}>{snapshot.totalPoints}</td>
                  <td style={S.td}>{snapshot.durationMs}ms</td>
                  <td style={S.td}>
                    {snapshot.pages.map((p) => `p${p.pageNum}:${p.points}`).join('  ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---- Verdict ---- */}
      {diff && (
        <section style={S.card}>
          <h2 style={S.h2}>
            Diff — “{lastTwo[0].label}” → “{lastTwo[1].label}”
          </h2>
          <div style={S.verdict(diff.romChanged)}>
            {diff.romChanged
              ? `ROM CHANGED — gained ${diff.gainedPoints} points across ` +
                `${diff.newPages.length} new page(s) and ${diff.changedPages.length} modified page(s).`
              : 'ROM UNCHANGED — device memory is byte-identical in point counts.'}
          </div>
          <ul style={S.list}>
            <li>page count delta: {diff.pageCountDelta}</li>
            <li>
              new pages:{' '}
              {diff.newPages.length
                ? diff.newPages.map((p) => `p${p.pageNum} (${p.points} pts)`).join(', ')
                : 'none'}
            </li>
            <li>
              modified pages:{' '}
              {diff.changedPages.length
                ? diff.changedPages
                    .map((p) => `p${p.pageNum} ${p.pointsBefore}→${p.pointsAfter}`)
                    .join(', ')
                : 'none'}
            </li>
            <li>live points captured during this run: {live.points}</li>
          </ul>
          {(lastTwo[0].suspectTruncated || lastTwo[1].suspectTruncated) && (
            <div style={S.warnInline}>
              One of these snapshots logged a download timeout or disconnect, so it may be
              incomplete. Re-run before trusting this diff.
            </div>
          )}
        </section>
      )}

      {/* ---- Log ---- */}
      <section style={S.card}>
        <h2 style={S.h2}>Protocol log</h2>
        <div style={S.log}>
          {log.map((line, i) => (
            <div key={i} style={S.logLine}>{line}</div>
          ))}
          <div ref={logEndRef} />
        </div>
        <button style={S.btnSmall(true)} onClick={() => setLog([])}>Clear log</button>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={S.stat}>
      <div style={S.statValue}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

const S = {
  page: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    background: '#171717',
    color: '#e5e5e5',
    minHeight: '100vh',
    padding: '24px',
    maxWidth: 980,
    margin: '0 auto',
  } as const,
  h1: { fontSize: 22, margin: '0 0 4px' } as const,
  h2: { fontSize: 14, margin: '0 0 12px', color: '#a3a3a3', textTransform: 'uppercase' } as const,
  sub: { color: '#a3a3a3', margin: '0 0 16px', lineHeight: 1.5 } as const,
  card: {
    background: '#232323',
    border: '1px solid #383838',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
  } as const,
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } as const,
  btn: (enabled: boolean) => ({
    background: enabled ? '#2563eb' : '#333',
    color: enabled ? '#fff' : '#777',
    border: 'none',
    borderRadius: 6,
    padding: '9px 16px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: 13,
    fontFamily: 'inherit',
  }) as const,
  btnSmall: (enabled: boolean) => ({
    background: 'transparent',
    color: enabled ? '#93c5fd' : '#666',
    border: `1px solid ${enabled ? '#3b82f6' : '#444'}`,
    borderRadius: 5,
    padding: '5px 10px',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: 11,
    fontFamily: 'inherit',
  }) as const,
  status: { color: '#a3a3a3', fontSize: 12 } as const,
  busy: { color: '#fbbf24', fontSize: 12 } as const,
  label: { fontSize: 12, color: '#a3a3a3' } as const,
  input: {
    background: '#171717',
    border: '1px solid #444',
    borderRadius: 5,
    color: '#e5e5e5',
    padding: '8px 10px',
    fontFamily: 'inherit',
    fontSize: 12,
    width: 160,
  } as const,
  experiment: { borderTop: '1px solid #333', paddingTop: 10, marginTop: 10 } as const,
  expTitle: { fontSize: 13, marginBottom: 4, color: '#e5e5e5' } as const,
  expDetail: { fontSize: 12, color: '#a3a3a3', lineHeight: 1.5, marginBottom: 8 } as const,
  canvas: { background: '#fafaf5', borderRadius: 6, border: '1px solid #444' } as const,
  stat: { minWidth: 90 } as const,
  statValue: { fontSize: 20, color: '#38bdf8' } as const,
  statLabel: { fontSize: 11, color: '#a3a3a3' } as const,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as const,
  th: { textAlign: 'left', color: '#a3a3a3', padding: '6px 8px', borderBottom: '1px solid #444' } as const,
  td: { padding: '6px 8px', borderBottom: '1px solid #2e2e2e' } as const,
  badge: { marginLeft: 6, color: '#fbbf24', fontSize: 10 } as const,
  muted: { color: '#777', fontSize: 12 } as const,
  verdict: (changed: boolean) => ({
    background: changed ? '#14532d' : '#3f1d1d',
    border: `1px solid ${changed ? '#16a34a' : '#dc2626'}`,
    color: changed ? '#bbf7d0' : '#fecaca',
    borderRadius: 6,
    padding: '10px 12px',
    fontSize: 13,
    marginBottom: 10,
  }) as const,
  list: { fontSize: 12, color: '#d4d4d4', lineHeight: 1.7, margin: 0, paddingLeft: 18 } as const,
  warn: {
    background: '#422006',
    border: '1px solid #a16207',
    color: '#fde68a',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 12,
    lineHeight: 1.5,
    marginBottom: 16,
  } as const,
  warnInline: {
    marginTop: 10,
    color: '#fbbf24',
    fontSize: 12,
    lineHeight: 1.5,
  } as const,
  log: {
    background: '#0f0f0f',
    border: '1px solid #333',
    borderRadius: 6,
    padding: 10,
    height: 260,
    overflowY: 'auto',
    fontSize: 11,
    marginBottom: 10,
  } as const,
  logLine: { color: '#a3a3a3', lineHeight: 1.6, whiteSpace: 'pre-wrap' } as const,
};
