// ═══════════════════════════════════════════════════════
// CRYPTO TERMINAL — app.js
// ═══════════════════════════════════════════════════════

window.CRYPTO_APP_BUNDLE_LOADED = true;

const CGAPI  = 'https://api.coingecko.com/api/v3';
const FNGAPI = 'https://api.alternative.me/fng/?limit=1';
const REFRESH_MS = 60_000;
const ANALYSIS_HORIZONS = [
  { id:'INTRADAY', label:'Intraday', detail:'1–24 ore', changeKey:'price_change_percentage_1h_in_currency', samples:24, emaFast:8, emaSlow:21, riskMin:.015, riskMax:.05, riskScale:.7 },
  { id:'SWING', label:'Swing', detail:'2–5 giorni', changeKey:'price_change_percentage_24h_in_currency', samples:72, emaFast:20, emaSlow:50, riskMin:.025, riskMax:.08, riskScale:1 },
  { id:'POSITION', label:'Posizionale', detail:'1–3 settimane', changeKey:'price_change_percentage_7d_in_currency', samples:168, emaFast:24, emaSlow:72, riskMin:.04, riskMax:.12, riskScale:1.35 },
];
const MAJOR_COIN_IDS = ['bitcoin','ethereum','binancecoin','solana','ripple','dogecoin','cardano','avalanche-2','chainlink','polkadot'];
const EXCLUDED_ASSET_IDS = new Set(['tether','usd-coin','dai','first-digital-usd','ethena-usde','paypal-usd','wrapped-bitcoin','staked-ether','wrapped-steth','binance-staked-sol']);

let ST = {
  coins: [], global: null, trending: [], fng: null,
  loading: true, error: null, lastUpdate: null,
  sortKey: 'market_cap', sortDir: 'desc',
  aiData: {}, aiLoading: new Set(),
  rsiView: '1d', tab: 'signals',
  horizon: 'SWING', fetchInFlight: false,
  now: Date.now(),
};

// ── Formatters ─────────────────────────────────────────

const fmtP = (n) => {
  if (n == null) return '—';
  if (n >= 1e3)  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1)    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 0.01) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
};
const fmtL = (n) => {
  if (n == null) return '—';
  if (n >= 1e12) return (n/1e12).toFixed(2)+'T';
  if (n >= 1e9)  return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6)  return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3)  return (n/1e3).toFixed(2)+'K';
  return n.toFixed(0);
};
const fmtPct = (n, d=2) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;',
})[char]);
const safeImage = value => {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ? esc(url.href) : '';
  } catch (_) {
    return '';
  }
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function emaLast(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) ema = values[i] * multiplier + ema * (1 - multiplier);
  return ema;
}

function computeMarketPulse(coins, market, sentiment) {
  const tradable = coins.filter(coin => !EXCLUDED_ASSET_IDS.has(coin.id));
  const breadth24 = tradable.length ? tradable.filter(c => (c.price_change_percentage_24h_in_currency ?? 0) > 0).length / tradable.length * 100 : 50;
  const breadth7d = tradable.length ? tradable.filter(c => (c.price_change_percentage_7d_in_currency ?? 0) > 0).length / tradable.length * 100 : 50;
  const avg24 = average(tradable.map(c => c.price_change_percentage_24h_in_currency ?? 0)) ?? 0;
  const btc = coins.find(coin => coin.id === 'bitcoin');
  const marketChange = market?.market_cap_change_percentage_24h_usd ?? avg24;
  const totalMarketCap = market?.total_market_cap?.usd;
  const totalVolume = market?.total_volume?.usd;
  const turnover = totalMarketCap && totalVolume ? totalVolume / totalMarketCap * 100 : null;

  let score = 50;
  score += marketChange >= 0 ? 12 : -12;
  score += breadth24 >= 58 ? 12 : breadth24 <= 42 ? -12 : 0;
  score += breadth7d >= 55 ? 10 : breadth7d <= 45 ? -10 : 0;
  score += (btc?.price_change_percentage_7d_in_currency ?? 0) >= 0 ? 8 : -8;
  if (turnover != null && turnover >= 6) score += marketChange >= 0 ? 4 : -4;
  if ((sentiment?.value ?? 50) >= 80 || (sentiment?.value ?? 50) <= 20) score -= 4;
  score = Math.round(clamp(score, 0, 100));

  const avgMove = average(tradable.map(c => Math.abs(c.price_change_percentage_24h_in_currency ?? 0))) ?? 0;
  const risk = avgMove >= 6 || (sentiment?.value ?? 50) >= 80 || (sentiment?.value ?? 50) <= 20 ? 'ALTO' : avgMove >= 3.5 ? 'MEDIO' : 'CONTENUTO';
  if (score >= 68) return { score,risk,breadth24,breadth7d,avg24,turnover,status:'SEGNALI POSITIVI',action:'COSTRUTTIVO',guidance:'Il mercato mostra partecipazione e momentum. Valuta solo setup confermati, preferendo ingressi su pullback.' };
  if (score <= 38) return { score,risk,breadth24,breadth7d,avg24,turnover,status:'ALTA CAUTELA',action:'DIFENSIVO',guidance:'Breadth e momentum sono deboli. Evita nuovi long aggressivi e attendi una stabilizzazione.' };
  return { score,risk,breadth24,breadth7d,avg24,turnover,status:'MEGLIO ATTENDERE',action:'NEUTRALE',guidance:'I segnali non sono allineati. Mantieni size ridotta e attendi conferme su prezzo e ampiezza di mercato.' };
}

function deriveTechnicalView(coin, horizon, marketPulse) {
  const prices = (coin.sparkline || []).slice(-horizon.samples);
  const price = Number.isFinite(coin.current_price) && coin.current_price > 0 ? coin.current_price : prices[prices.length - 1];
  const emaFast = emaLast(prices, horizon.emaFast);
  const emaSlow = emaLast(prices, horizon.emaSlow);
  const rsi = calcRSI(prices, 14);
  const momentum = coin[horizon.changeKey] ?? 0;
  const change24 = coin.price_change_percentage_24h_in_currency ?? 0;
  const change7d = coin.price_change_percentage_7d_in_currency ?? 0;
  const volumeRatio = coin.market_cap ? coin.total_volume / coin.market_cap : 0;

  let score = 50;
  if (emaFast != null) score += price >= emaFast ? 10 : -10;
  if (emaFast != null && emaSlow != null) score += emaFast >= emaSlow ? 14 : -14;
  score += momentum >= 0 ? 10 : -10;
  score += change24 >= 0 ? 6 : -6;
  score += change7d >= 0 ? 8 : -8;
  if (rsi != null) {
    if (rsi >= 55 && rsi <= 72) score += 8;
    else if (rsi <= 45 && rsi >= 28) score -= 8;
    else if (rsi > 72) score -= 4;
    else if (rsi < 28) score += 4;
  }
  if (volumeRatio >= .04) score += momentum >= 0 ? 4 : -4;
  score += (marketPulse.score - 50) * .15;
  score = Math.round(clamp(score, 0, 100));

  const bullish = emaFast != null && emaSlow != null && price >= emaFast && emaFast >= emaSlow;
  const bearish = emaFast != null && emaSlow != null && price <= emaFast && emaFast <= emaSlow;
  const trend = bullish ? 'RIALZISTA' : bearish ? 'RIBASSISTA' : 'LATERALE';
  const overextended = (score >= 50 && rsi != null && rsi > 72) || (score < 50 && rsi != null && rsi < 28);
  let action = 'ATTENDI CONFERMA', direction = 'NEUTRALE';
  if (score >= 70 && !overextended) { action = 'SETUP LONG'; direction = 'LONG'; }
  else if (score <= 30 && !overextended) { action = 'SETUP SHORT'; direction = 'SHORT'; }
  else if (score >= 60) { action = 'ATTENDI PULLBACK'; direction = 'LONG'; }
  else if (score <= 40) { action = 'MASSIMA CAUTELA'; direction = 'SHORT'; }

  const hourlyVol = (coin.volatility ?? 1) / 100;
  const dailyVol = hourlyVol * Math.sqrt(24);
  const range24 = coin.high_24h && coin.low_24h && price ? (coin.high_24h - coin.low_24h) / price : 0;
  const riskPct = clamp(Math.max(dailyVol * 1.15, range24 * .5) * horizon.riskScale, horizon.riskMin, horizon.riskMax);
  let levels = null;
  if (price > 0 && (action === 'SETUP LONG' || action === 'SETUP SHORT')) {
    const isLong = action === 'SETUP LONG';
    const zoneA = price * (1 + (isLong ? -.18 : -.05) * riskPct);
    const zoneB = price * (1 + (isLong ? .05 : .18) * riskPct);
    levels = {
      entryLow:Math.min(zoneA,zoneB), entryHigh:Math.max(zoneA,zoneB),
      stop:price * (1 + (isLong ? -1 : 1) * riskPct),
      tp1:price * (1 + (isLong ? 1 : -1) * riskPct * 1.5),
      tp2:price * (1 + (isLong ? 1 : -1) * riskPct * 2.5), riskPct:riskPct * 100,
    };
  }
  const rsiState = rsi == null ? 'n/d' : rsi > 72 ? 'teso' : rsi < 28 ? 'scarico' : 'equilibrato';
  return {
    coin,action,direction,trend,score,confidence:Math.round(Math.max(score,100-score)),rsi,momentum,volumeRatio,levels,
    reasons:[emaFast != null && emaSlow != null ? `EMA ${horizon.emaFast}/${horizon.emaSlow} ${emaFast >= emaSlow ? 'positiva' : 'negativa'}` : 'EMA non disponibile',`Momentum ${horizon.label.toLowerCase()} ${fmtPct(momentum)}`,`RSI 14 ${rsi == null ? 'n/d' : rsi.toFixed(0)} · ${rsiState}`],
  };
}

// ── HTML Helpers ────────────────────────────────────────

const pct = (v, cls='') => {
  if (v == null) return `<span class="text-muted mono">—</span>`;
  return `<span class="mono ${v >= 0 ? 'up' : 'dn'} ${cls}">${fmtPct(v)}</span>`;
};

const rsiBadge = (v) => {
  if (v == null) return `<span class="mono text-muted">—</span>`;
  let cls = 'rsi-neu';
  if (v < 30) cls = 'rsi-os'; else if (v > 70) cls = 'rsi-ob';
  else if (v < 45) cls = 'rsi-bear'; else if (v > 55) cls = 'rsi-bull';
  return `<span class="rsi-badge ${cls}">${v.toFixed(0)}</span>`;
};

const sigBadge = (sig) => {
  if (!sig) return '';
  const map = {
    STRONG_BUY:'sig-sbuy', BUY:'sig-buy', BREAKOUT:'sig-brk',
    ACCUMULATE:'sig-acc', STRONG_SELL:'sig-ssell', SELL:'sig-sell', BREAKDOWN:'sig-brkd'
  };
  return `<span class="sig-badge ${map[sig.type]||''}">${sig.label}</span>`;
};

const dirBadge = (dir) => {
  const safeDir = dir === 'LONG' || dir === 'SHORT' ? dir : 'NEUTRALE';
  if (safeDir === 'NEUTRALE') return `<span class="dir-badge neu">NEUTRALE</span>`;
  return `<span class="dir-badge ${safeDir === 'LONG' ? 'long' : 'short'}">${safeDir}</span>`;
};

// ── Fetch ───────────────────────────────────────────────

async function fetchAll(silent = false) {
  if (ST.fetchInFlight) return;
  ST.fetchInFlight = true;
  if (!silent) { ST.loading = true; render(); }
  try {
    const [coinsR, globalR, trendR] = await Promise.allSettled([
      fetch(`${CGAPI}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d`),
      fetch(`${CGAPI}/global`),
      fetch(`${CGAPI}/search/trending`),
    ]);

    let fngData = null;
    try {
      const fr = await fetch(FNGAPI);
      if (fr.ok) { const j = await fr.json(); fngData = j?.data?.[0] || null; }
    } catch (_) {}

    if (coinsR.status !== 'fulfilled' || !coinsR.value.ok)
      throw new Error('Rate limit CoinGecko o errore di rete. Riprovo tra 60s.');

    const raw = await coinsR.value.json();
    ST.coins = raw.map(c => {
      const sp  = c.sparkline_in_7d?.price || [];
      const coin = { ...c, sparkline: sp,
        rsi_1d: getDailyRSI(sp), rsi_7d: getWeeklyRSI(sp), volatility: getVolatility(sp) };
      coin.signal = generateSignal(coin);
      coin.levels = calcTradeLevels(coin);
      return coin;
    });

    if (globalR.status === 'fulfilled' && globalR.value.ok) {
      const g = await globalR.value.json(); ST.global = g.data;
    }
    if (trendR.status === 'fulfilled' && trendR.value.ok) {
      const t = await trendR.value.json(); ST.trending = t.coins || [];
    }
    if (fngData) ST.fng = fngData;

    ST.lastUpdate = new Date(); ST.error = null;
  } catch (e) {
    ST.error = e.message || 'Errore sconosciuto';
  } finally {
    ST.fetchInFlight = false;
    ST.loading = false; render();
  }
}

// ── AI Analysis ─────────────────────────────────────────

async function requestAI(coinId) {
  const coin = ST.coins.find(c => c.id === coinId);
  if (!coin || ST.aiLoading.has(coinId)) return;
  ST.aiLoading.add(coinId);
  renderAICard(coinId);

  const fngVal = ST.fng ? parseInt(ST.fng.value, 10) : null;
  const mkt = {
    fng:       fngVal ?? '—',
    btcDom:    ST.global?.market_cap_percentage?.btc?.toFixed(1) ?? '—',
    mcapChange: ST.global?.market_cap_change_percentage_24h_usd?.toFixed(2) ?? '—',
  };
  const payload = {
    coin: {
      name:       coin.name,
      symbol:     coin.symbol.toUpperCase(),
      price:      fmtP(coin.current_price),
      ch1h:       (coin.price_change_percentage_1h_in_currency ?? 0).toFixed(2),
      ch24h:      (coin.price_change_percentage_24h_in_currency ?? 0).toFixed(2),
      ch7d:       (coin.price_change_percentage_7d_in_currency ?? 0).toFixed(2),
      rsi1d:      coin.rsi_1d != null ? coin.rsi_1d.toFixed(1) : '—',
      rsi7d:      coin.rsi_7d != null ? coin.rsi_7d.toFixed(1) : '—',
      volatility: coin.volatility != null ? coin.volatility.toFixed(2) : '—',
      volRatio:   coin.market_cap ? ((coin.total_volume / coin.market_cap) * 100).toFixed(2) : '—',
      signal:     coin.signal ? coin.signal.label : 'nessuno',
      rank:       coin.market_cap_rank,
    },
    market: mkt,
  };

  try {
    const res = await fetch('api/ai.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Errore server');
    ST.aiData[coinId] = { ok: true, data };
  } catch (e) {
    ST.aiData[coinId] = { ok: false, error: e.message };
  } finally {
    ST.aiLoading.delete(coinId);
    renderAICard(coinId);
  }
}

function renderAICard(coinId) {
  const el = [...document.querySelectorAll('[data-ai]')].find(node => node.dataset.ai === coinId);
  if (!el) return;
  if (ST.aiLoading.has(coinId)) {
    el.innerHTML = `<div class="ai-loading"><span class="spin"></span> Analisi AI in corso…</div>`;
    return;
  }
  const r = ST.aiData[coinId];
  if (!r) { el.innerHTML = ''; return; }
  if (!r.ok) {
    el.innerHTML = `<div class="ai-error">⚠ ${esc(r.error)}</div>`; return;
  }
  const d = r.data;
  const coin = ST.coins.find(c => c.id === coinId);
  const risk = ['ALTO','MEDIO','BASSO'].includes(d.rischio) ? d.rischio : 'MEDIO';
  const confidence = clamp(Number(d.confidenza) || 0, 0, 100);
  el.innerHTML = `
    <div class="ai-result">
      <div class="ai-header">
        <span class="ai-label">● AI Analysis</span>
        ${dirBadge(d.direzione)}
        <span class="ai-conf conf-${risk.toLowerCase()}">${risk} RISCHIO</span>
        <span class="ai-conf">Confidenza: <strong>${confidence}%</strong></span>
        <span class="ai-tf mono">${esc(d.timeframe)}</span>
      </div>
      <p class="ai-text">${esc(d.analisi)}</p>
      <div class="levels-grid">
        <div class="lv entry">
          <div class="lv-label">ENTRY</div>
          <div class="lv-val mono">$${fmtP(d.entry)}</div>
        </div>
        <div class="lv sl">
          <div class="lv-label">STOP LOSS</div>
          <div class="lv-val mono dn">$${fmtP(d.stop_loss)}</div>
          <div class="lv-pct mono">${coin ? fmtPct(((d.stop_loss - d.entry) / d.entry) * 100) : ''}</div>
        </div>
        <div class="lv tp">
          <div class="lv-label">TP 1</div>
          <div class="lv-val mono up">$${fmtP(d.take_profit_1)}</div>
          <div class="lv-pct mono">${coin ? fmtPct(((d.take_profit_1 - d.entry) / d.entry) * 100) : ''}</div>
        </div>
        <div class="lv tp">
          <div class="lv-label">TP 2</div>
          <div class="lv-val mono up">$${fmtP(d.take_profit_2)}</div>
          <div class="lv-pct mono">${coin ? fmtPct(((d.take_profit_2 - d.entry) / d.entry) * 100) : ''}</div>
        </div>
        ${d.take_profit_3 ? `<div class="lv tp">
          <div class="lv-label">TP 3</div>
          <div class="lv-val mono up">$${fmtP(d.take_profit_3)}</div>
          <div class="lv-pct mono">${coin ? fmtPct(((d.take_profit_3 - d.entry) / d.entry) * 100) : ''}</div>
        </div>` : ''}
      </div>
      ${d.note ? `<p class="ai-note">📌 ${esc(d.note)}</p>` : ''}
    </div>`;
}

// ── Section Builders ─────────────────────────────────────

function buildTicker(coins) {
  const list = [...coins.slice(0, 10), ...coins.slice(0, 10)];
  return list.map(c => {
    const ch = c.price_change_percentage_24h_in_currency;
    return `<span class="tick-item">
      <img src="${safeImage(c.image)}" class="tick-img" alt="" loading="lazy">
      <span class="mono fw6 text-sm">${esc(c.symbol.toUpperCase())}</span>
      <span class="mono">\$${fmtP(c.current_price)}</span>
      ${pct(ch)}
    </span>`;
  }).join('');
}

function buildKPI(g, coins, sentiment) {
  const avg24 = coins.reduce((s,c) => s + (c.price_change_percentage_24h_in_currency||0), 0) / Math.max(1, coins.length);
  const pos   = coins.filter(c => (c.price_change_percentage_24h_in_currency||0) > 0).length;
  return `
    <div class="kpi-item accent">
      <div class="kpi-label">Market Cap</div>
      <div class="kpi-val mono">\$${fmtL(g.total_market_cap?.usd)}</div>
      <div class="kpi-sub mono ${(g.market_cap_change_percentage_24h_usd||0) >= 0 ? 'up':'dn'}">${fmtPct(g.market_cap_change_percentage_24h_usd)}</div>
    </div>
    <div class="kpi-item">
      <div class="kpi-label">Volume 24h</div>
      <div class="kpi-val mono">\$${fmtL(g.total_volume?.usd)}</div>
      <div class="kpi-sub mono">${g.total_market_cap?.usd ? ((g.total_volume.usd/g.total_market_cap.usd)*100).toFixed(2)+'% MCap' : ''}</div>
    </div>
    <div class="kpi-item">
      <div class="kpi-label">BTC Dominance</div>
      <div class="kpi-val mono">${g.market_cap_percentage?.btc?.toFixed(1)}%</div>
      <div class="kpi-sub mono">ETH ${g.market_cap_percentage?.eth?.toFixed(1)}%</div>
    </div>
    <div class="kpi-item">
      <div class="kpi-label">Cryptos Attive</div>
      <div class="kpi-val mono">${fmtL(g.active_cryptocurrencies)}</div>
      <div class="kpi-sub mono">${g.markets} markets</div>
    </div>
    <div class="kpi-item">
      <div class="kpi-label">Top 100 · 24h Avg</div>
      <div class="kpi-val mono ${avg24>=0?'up':'dn'}">${fmtPct(avg24)}</div>
      <div class="kpi-sub mono">${pos}/100 positive</div>
    </div>
    <div class="kpi-item fng-item">
      ${fngGauge(sentiment.value, sentiment.label)}
    </div>`;
}

function fngGauge(v, label) {
  const val = v ?? 50;
  const angle = (val / 100) * 180 - 90;
  let col = '#fb7185';
  if (val >= 75) col = '#a3e635';
  else if (val >= 55) col = '#84cc16';
  else if (val >= 45) col = '#a1a1aa';
  else if (val >= 25) col = '#f97316';
  return `<div class="fng-wrap">
    <svg viewBox="0 0 100 60" width="90" height="55">
      <defs><linearGradient id="fng-g" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#fb7185"/>
        <stop offset="25%" stop-color="#f97316"/>
        <stop offset="50%" stop-color="#a1a1aa"/>
        <stop offset="75%" stop-color="#84cc16"/>
        <stop offset="100%" stop-color="#a3e635"/>
      </linearGradient></defs>
      <path d="M 8 50 A 42 42 0 0 1 92 50" stroke="url(#fng-g)" stroke-width="6" fill="none" stroke-linecap="round"/>
      <g transform="rotate(${angle} 50 50)">
        <line x1="50" y1="50" x2="50" y2="14" stroke="#f4f4f5" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="50" cy="50" r="3" fill="#f4f4f5"/>
      </g>
    </svg>
    <div>
      <div class="kpi-label">Fear & Greed · alt.me</div>
      <div class="kpi-val mono" style="color:${col}">${val}</div>
      <div class="kpi-sub" style="color:${col};font-size:9px">${esc(label || '—')}</div>
    </div>
  </div>`;
}

function buildTop10(coins) {
  return coins.slice(0, 10).map(c => {
    const ch = c.price_change_percentage_24h_in_currency;
    const pos = (ch ?? 0) >= 0;
    return `<div class="top10-card">
      <div class="top10-rank">#${c.market_cap_rank}</div>
      <div class="top10-head">
        <img src="${safeImage(c.image)}" class="coin-img" alt="" loading="lazy">
        <div>
          <div class="mono fw6 text-xs">${esc(c.symbol.toUpperCase())}</div>
          <div class="text-muted" style="font-size:10px">${esc(c.name)}</div>
        </div>
      </div>
      <div class="mono top10-price">\$${fmtP(c.current_price)}</div>
      <div class="top10-row">
        ${pct(ch,'text-xs')}
        ${rsiBadge(c.rsi_1d)}
      </div>
      <div class="top10-spark">${sparklineSVG(c.sparkline, pos, 140, 30)}</div>
    </div>`;
  }).join('');
}

function buildSignals(coins) {
  const sigs = coins.filter(c => c.signal)
    .sort((a,b) => {
      if (a.signal.priority !== b.signal.priority) return a.signal.priority - b.signal.priority;
      return b.signal.score - a.signal.score;
    }).slice(0, 15);

  if (!sigs.length) return `<div class="empty">Nessun segnale rilevato — mercato laterale</div>`;

  return sigs.map(c => {
    const sig  = c.signal;
    const lvl  = c.levels;
    const ch24 = c.price_change_percentage_24h_in_currency;
    const aiR  = ST.aiData[c.id];
    const aiLd = ST.aiLoading.has(c.id);

    const levelBar = lvl ? `
      <div class="algo-levels">
        <span class="lv-tag">ENTRY <span class="mono">\$${fmtP(lvl.entry)}</span></span>
        <span class="lv-tag sl">SL <span class="mono dn">\$${fmtP(lvl.stop_loss)}</span></span>
        <span class="lv-tag tp">TP1 <span class="mono up">\$${fmtP(lvl.tp1)}</span></span>
        <span class="lv-tag tp">TP2 <span class="mono up">\$${fmtP(lvl.tp2)}</span></span>
      </div>` : '';

    const btnLabel = aiLd ? '<span class="spin"></span> Carico…' : (aiR ? '↻ Rianalizza AI' : '✦ Analisi AI');

    return `<div class="sig-row sig-${sig.type.toLowerCase()}">
      <img src="${safeImage(c.image)}" class="coin-img" alt="" loading="lazy">
      <div class="sig-body">
        <div class="sig-top">
          <span class="mono fw6 text-xs">${esc(c.symbol.toUpperCase())}</span>
          ${sigBadge(sig)}
          <span class="text-muted" style="font-size:10px">${sig.reason}</span>
        </div>
        <div class="sig-mid">
          <span class="mono">\$${fmtP(c.current_price)}</span>
          ${pct(ch24)}
          <span class="rsi-sm">RSI1D ${rsiBadge(c.rsi_1d)}</span>
          <span class="rsi-sm">RSI7D ${rsiBadge(c.rsi_7d)}</span>
          ${c.volatility != null ? `<span class="mono text-muted text-xs">Vol ${c.volatility.toFixed(1)}%</span>` : ''}
        </div>
        ${levelBar}
        <div class="ai-zone" data-ai="${esc(c.id)}"></div>
      </div>
      <div class="sig-right">
        <div class="mono sig-score" style="color:inherit">${sig.score.toFixed(0)}</div>
        <div style="font-size:9px;color:#71717a">CONF.</div>
        <button class="ai-btn" type="button" data-ai-request="${esc(c.id)}" ${aiLd ? 'disabled' : ''}>${btnLabel}</button>
      </div>
    </div>`;
  }).join('');
}

function buildRSI(coins, period, type) {
  const rsiKey = period === '1d' ? 'rsi_1d' : 'rsi_7d';
  const isOver = type === 'oversold';
  const filtered = coins
    .filter(c => { const r = c[rsiKey]; return r != null && (isOver ? r < 30 : r > 70); })
    .sort((a,b) => { const ra = a[rsiKey], rb = b[rsiKey]; return isOver ? ra - rb : rb - ra; })
    .slice(0, 10);

  const cls  = isOver ? 'up' : 'dn';
  const lbl  = isOver ? 'OVERSOLD' : 'OVERBOUGHT';
  const pLbl = period === '1d' ? '1D' : '7D';

  if (!filtered.length)
    return `<div class="rsi-box"><div class="rsi-box-head ${cls}">${lbl} · ${pLbl} <span class="rsi-count">0</span></div><div class="empty sm">Nessun asset</div></div>`;

  const rows = filtered.map(c => {
    const r   = c[rsiKey];
    const ch  = c.price_change_percentage_24h_in_currency;
    return `<div class="rsi-row">
      <span class="text-muted mono" style="font-size:10px;width:22px">#${c.market_cap_rank}</span>
      <img src="${safeImage(c.image)}" class="coin-img-sm" alt="" loading="lazy">
      <span class="mono fw6 text-xs flex-1">${esc(c.symbol.toUpperCase())}</span>
      <span class="mono text-sm text-muted">\$${fmtP(c.current_price)}</span>
      ${pct(ch,'text-xs')}
      <span class="mono fw7 ${cls}" style="width:32px;text-align:right">${r.toFixed(0)}</span>
    </div>`;
  }).join('');

  return `<div class="rsi-box">
    <div class="rsi-box-head ${cls}">${lbl} · ${pLbl} <span class="rsi-count">${filtered.length}</span></div>
    ${rows}
  </div>`;
}

function buildTrending(trending, gainers, losers, volLeaders) {
  const trHTML = trending.slice(0, 6).map((t, i) => {
    const item = t.item;
    return `<div class="mini-row">
      <span class="mono text-xs" style="color:#f97316;width:16px">#${i+1}</span>
      <img src="${safeImage(item.small)}" class="coin-img-sm" alt="" loading="lazy">
      <span class="mono fw6 text-xs flex-1">${esc(item.symbol)}</span>
      <span class="text-muted" style="font-size:10px">${item.market_cap_rank ? '#'+item.market_cap_rank : ''}</span>
    </div>`;
  }).join('');

  const moverRow = (c) => `<div class="mini-row">
    <img src="${safeImage(c.image)}" class="coin-img-sm" alt="" loading="lazy">
    <span class="mono fw6 text-xs flex-1">${esc(c.symbol.toUpperCase())}</span>
    <span class="mono text-xs text-muted">\$${fmtP(c.current_price)}</span>
    ${pct(c.price_change_percentage_24h_in_currency,'text-xs')}
  </div>`;

  const volRow = (c) => {
    const ratio = c.market_cap ? (c.total_volume / c.market_cap * 100).toFixed(1) : '—';
    return `<div class="mini-row">
      <img src="${safeImage(c.image)}" class="coin-img-sm" alt="" loading="lazy">
      <span class="mono fw6 text-xs flex-1">${esc(c.symbol.toUpperCase())}</span>
      <span class="mono text-xs" style="color:#22d3ee">${ratio}%</span>
    </div>`;
  };

  return `
    <div class="sidebar-block">
      <div class="sb-title" style="color:#f97316">🔥 Trending CoinGecko</div>
      ${trHTML}
    </div>
    <div class="sidebar-block">
      <div class="sb-title up">▲ Top Gainers · 24h</div>
      ${gainers.map(moverRow).join('')}
    </div>
    <div class="sidebar-block">
      <div class="sb-title dn">▼ Top Losers · 24h</div>
      ${losers.map(moverRow).join('')}
    </div>
    <div class="sidebar-block">
      <div class="sb-title" style="color:#22d3ee">⬡ Volume Leaders</div>
      ${volLeaders.map(volRow).join('')}
    </div>`;
}

function buildTable(coins, sortKey, sortDir) {
  const sorted = [...coins].sort((a,b) => {
    const va = a[sortKey] ?? -Infinity, vb = b[sortKey] ?? -Infinity;
    return sortDir === 'desc' ? vb - va : va - vb;
  });

  const th = (k, label, align='right') => {
    const active = sortKey === k;
    const arrow  = active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '';
    return `<th class="th-${align} sortable${active?' active':''}" data-key="${k}">${label}${arrow}</th>`;
  };

  const rows = sorted.map(c => {
    const pos7 = (c.price_change_percentage_7d_in_currency ?? 0) >= 0;
    return `<tr>
      <td class="td-left mono text-muted">${c.market_cap_rank}</td>
      <td class="td-left">
        <div class="coin-cell">
          <img src="${safeImage(c.image)}" class="coin-img-sm" alt="" loading="lazy">
          <div>
            <div class="mono fw6 text-xs">${esc(c.symbol.toUpperCase())}</div>
            <div class="text-muted" style="font-size:10px">${esc(c.name)}</div>
          </div>
        </div>
      </td>
      <td class="td-right mono">\$${fmtP(c.current_price)}</td>
      <td class="td-right">${pct(c.price_change_percentage_1h_in_currency)}</td>
      <td class="td-right">${pct(c.price_change_percentage_24h_in_currency)}</td>
      <td class="td-right">${pct(c.price_change_percentage_7d_in_currency)}</td>
      <td class="td-right mono text-muted">\$${fmtL(c.total_volume)}</td>
      <td class="td-right mono">\$${fmtL(c.market_cap)}</td>
      <td class="td-center">${rsiBadge(c.rsi_1d)}</td>
      <td class="td-center">${rsiBadge(c.rsi_7d)}</td>
      <td class="td-right mono text-muted">${c.volatility != null ? c.volatility.toFixed(1)+'%' : '—'}</td>
      <td class="td-right">${sparklineSVG(c.sparkline, pos7, 100, 24)}</td>
    </tr>`;
  }).join('');

  return `<div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          ${th('market_cap_rank','#','left')}
          <th class="th-left">Asset</th>
          ${th('current_price','Price')}
          ${th('price_change_percentage_1h_in_currency','1h')}
          ${th('price_change_percentage_24h_in_currency','24h')}
          ${th('price_change_percentage_7d_in_currency','7d')}
          ${th('total_volume','Volume 24h')}
          ${th('market_cap','Market Cap')}
          ${th('rsi_1d','RSI 1D','center')}
          ${th('rsi_7d','RSI 7D','center')}
          ${th('volatility','Volat.')}
          <th class="th-right">7d Trend</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildHorizonTabs() {
  return ANALYSIS_HORIZONS.map(horizon => `
    <button class="horizon-tab${ST.horizon === horizon.id ? ' active' : ''}" data-horizon="${horizon.id}" role="tab" aria-selected="${ST.horizon === horizon.id}">
      <span>${horizon.label}</span><small>${horizon.detail}</small>
    </button>`).join('');
}

function buildTechnicalCard(view, horizon) {
  const { coin, action, direction, trend, score, confidence, rsi, volumeRatio, levels, reasons } = view;
  const tone = action === 'SETUP LONG' ? 'positive' : action === 'SETUP SHORT' || action === 'MASSIMA CAUTELA' ? 'negative' : 'waiting';
  const trendClass = trend === 'RIALZISTA' ? 'up' : trend === 'RIBASSISTA' ? 'dn' : 'text-muted';
  const levelGrid = levels ? `
    <div class="decision-levels">
      <div><span>Entry zone</span><strong>$${fmtP(levels.entryLow)}–$${fmtP(levels.entryHigh)}</strong></div>
      <div class="level-stop"><span>Stop loss</span><strong>$${fmtP(levels.stop)}</strong></div>
      <div class="level-target"><span>TP 1 · 1.5R</span><strong>$${fmtP(levels.tp1)}</strong></div>
      <div class="level-target"><span>TP 2 · 2.5R</span><strong>$${fmtP(levels.tp2)}</strong></div>
      <p>Scenario ${direction} · rischio prezzo–SL ${levels.riskPct.toFixed(1)}% · invalido oltre lo stop</p>
    </div>` : `
    <div class="decision-empty">Nessun livello attivo: attendi allineamento di trend, momentum e RSI sul profilo ${horizon.label.toLowerCase()}.</div>`;

  return `<article class="decision-card ${tone}">
    <div class="decision-card-head">
      <div class="decision-asset">
        <img src="${safeImage(coin.image)}" alt="" loading="lazy">
        <div><strong>${esc(coin.symbol.toUpperCase())}</strong><small>${esc(coin.name)} · #${coin.market_cap_rank}</small></div>
      </div>
      <div class="decision-price"><strong>$${fmtP(coin.current_price)}</strong>${pct(coin.price_change_percentage_24h_in_currency,'text-xs')}</div>
    </div>
    <div class="decision-verdict">
      <div><span>Indicazione</span><strong>${action}</strong></div>
      <div><span>Confluenza</span><strong>${confidence}<small>/100</small></strong></div>
    </div>
    <div class="confidence-track"><i style="width:${confidence}%"></i></div>
    <div class="decision-metrics">
      <div><span>Trend</span><strong class="${trendClass}">${trend}</strong></div>
      <div><span>RSI 14</span><strong>${rsi == null ? '—' : rsi.toFixed(1)}</strong></div>
      <div><span>Vol/MCap</span><strong>${(volumeRatio * 100).toFixed(1)}%</strong></div>
    </div>
    <div class="decision-reasons">${reasons.map(reason => `<span>${esc(reason)}</span>`).join('')}</div>
    ${levelGrid}
    <div class="decision-foot">Score direzionale ${score}/100 · scenario tecnico informativo, non ordine operativo.</div>
  </article>`;
}

function buildMarketAdvisor(coins, market, sentiment) {
  const horizon = ANALYSIS_HORIZONS.find(item => item.id === ST.horizon) || ANALYSIS_HORIZONS[1];
  const pulse = computeMarketPulse(coins, market, sentiment);
  const byId = new Map(coins.map(coin => [coin.id, coin]));
  const configured = MAJOR_COIN_IDS.map(id => byId.get(id)).filter(Boolean);
  const fallback = coins.filter(coin => !EXCLUDED_ASSET_IDS.has(coin.id) && !configured.some(item => item.id === coin.id));
  const views = [...configured, ...fallback].slice(0, 8).map(coin => deriveTechnicalView(coin, horizon, pulse));
  const tone = pulse.action === 'COSTRUTTIVO' ? 'positive' : pulse.action === 'DIFENSIVO' ? 'negative' : 'waiting';

  return `<section class="section decision-desk" aria-labelledby="decision-title">
    <div class="decision-heading">
      <div><h2 id="decision-title">Market Decision Desk</h2><p>Regime di mercato · principali crypto · scenari Entry / SL / TP</p></div>
      <div class="horizon-tabs" role="tablist" aria-label="Orizzonte di analisi">${buildHorizonTabs()}</div>
    </div>
    <div class="risk-banner"><strong>⚠ Dati indicativi CoinGecko.</strong> Non è un feed exchange. Verifica liquidità, spread e conferma candela prima di operare.</div>
    <div class="market-pulse ${tone}">
      <div class="pulse-summary">
        <div><span>Market stance</span><small>Score ${pulse.score}/100</small></div>
        <h3>${pulse.status}</h3>
        <strong>Regime ${pulse.action} · rischio ${pulse.risk}</strong>
        <p>${pulse.guidance}</p>
      </div>
      <div class="pulse-metrics">
        <div><span>Breadth 24h</span><strong class="${pulse.breadth24 >= 50 ? 'up' : 'dn'}">${pulse.breadth24.toFixed(0)}%</strong><small>asset positivi</small></div>
        <div><span>Breadth 7d</span><strong class="${pulse.breadth7d >= 50 ? 'up' : 'dn'}">${pulse.breadth7d.toFixed(0)}%</strong><small>partecipazione trend</small></div>
        <div><span>Media 24h</span><strong class="${pulse.avg24 >= 0 ? 'up' : 'dn'}">${fmtPct(pulse.avg24)}</strong><small>top market ex stable</small></div>
        <div><span>Turnover</span><strong>${pulse.turnover == null ? '—' : pulse.turnover.toFixed(1) + '%'}</strong><small>volume / market cap</small></div>
      </div>
    </div>
    <div class="decision-subhead"><div><strong>Focus principali</strong><span>Livelli mostrati solo con confluenza forte · ${horizon.label}</span></div><small>Aggiornamento ogni 60s</small></div>
    <div class="decision-grid">${views.map(view => buildTechnicalCard(view,horizon)).join('')}</div>
  </section>`;
}

// ── Main Render ──────────────────────────────────────────

function render() {
  const app = document.getElementById('app');

  if (ST.loading && !ST.coins.length) {
    app.innerHTML = `<div class="loading-screen"><div class="spin lg"></div><div class="mono text-muted">Loading market data…</div></div>`;
    return;
  }

  const coins   = ST.coins;
  const g       = ST.global;
  const fngVal  = ST.fng ? parseInt(ST.fng.value, 10) : null;
  const sentiment = calcSentiment(coins, fngVal, ST.fng?.value_classification);

  const gainers = [...coins].sort((a,b) =>
    (b.price_change_percentage_24h_in_currency??-Infinity) - (a.price_change_percentage_24h_in_currency??-Infinity)).slice(0,5);
  const losers  = [...coins].sort((a,b) =>
    (a.price_change_percentage_24h_in_currency??Infinity) - (b.price_change_percentage_24h_in_currency??Infinity)).slice(0,5);
  const volLead = [...coins].sort((a,b) => {
    const ra = a.market_cap ? a.total_volume/a.market_cap : 0;
    const rb = b.market_cap ? b.total_volume/b.market_cap : 0;
    return rb - ra;
  }).slice(0,5);

  const sec = ST.lastUpdate ? Math.max(0, Math.floor((ST.now - ST.lastUpdate.getTime()) / 1000)) : null;

  app.innerHTML = `
    ${ST.error ? `<div class="error-bar">⚠ ${esc(ST.error)}</div>` : ''}

    <!-- TICKER -->
    <div class="ticker-wrap">
      <div class="ticker-live">● LIVE</div>
      <div class="ticker-fade left"></div>
      <div class="ticker-fade right"></div>
      <div class="ticker">${buildTicker(coins)}</div>
    </div>

    <!-- KPI -->
    ${g ? `<div class="kpi-bar">${buildKPI(g, coins, sentiment)}</div>` : ''}

    <!-- MARKET DECISION DESK -->
    ${buildMarketAdvisor(coins, g, sentiment)}

    <!-- TOP 10 -->
    <section class="section">
      <div class="sec-head">
        <div class="sec-title">Top 10 Live</div>
        <div class="sec-sub mono">By Market Cap · sparkline 7gg · RSI 24h</div>
      </div>
      <div class="top10-grid">${buildTop10(coins)}</div>
    </section>

    <!-- SEGNALI + SIDEBAR -->
    <div class="main-grid">
      <section class="section col-main">
        <div class="sec-head">
          <div class="sec-title" style="color:#a3e635">Segnali Trading</div>
          <div class="sec-sub mono">RSI + variazione + Vol/MCap · entry/SL/TP algoritmici · AI su richiesta</div>
        </div>
        <div id="signals-list">${buildSignals(coins)}</div>
        <p class="disclaimer">I segnali sono derivati algoritmicamente. <strong>Non costituiscono consulenza finanziaria.</strong></p>
      </section>

      <aside class="sidebar">
        ${buildTrending(ST.trending, gainers, losers, volLead)}
      </aside>
    </div>

    <!-- RSI MATRIX -->
    <section class="section">
      <div class="sec-head">
        <div class="sec-title" style="color:#22d3ee">Matrice RSI</div>
        <div class="sec-sub mono">Oversold &lt;30 · Overbought &gt;70 · Wilder smoothing</div>
      </div>
      <div class="rsi-grid">
        ${buildRSI(coins,'1d','oversold')}
        ${buildRSI(coins,'1d','overbought')}
        ${buildRSI(coins,'7d','oversold')}
        ${buildRSI(coins,'7d','overbought')}
      </div>
    </section>

    <!-- TABLE -->
    <section class="section">
      <div class="sec-head">
        <div class="sec-title">Top 100 · Full Matrix</div>
        <div class="sec-sub mono">Clicca le intestazioni per ordinare</div>
      </div>
      ${buildTable(coins, ST.sortKey, ST.sortDir)}
    </section>

    <!-- FOOTER -->
    <footer class="footer">
      <div><div class="footer-title">Data Sources</div>CoinGecko Public API · alternative.me F&G Index<br><span class="text-muted">No API key · Auto-refresh 60s</span></div>
      <div><div class="footer-title">Indicatori Tecnici</div>RSI Wilder(14) su sparkline orarie · RSI7D = Wilder(6) su 7 close daily</div>
      <div><div class="footer-title">Disclaimer</div><span class="text-muted">Strumento analitico informativo. <strong>Non è consulenza finanziaria.</strong> Opera solo con capitale che puoi permetterti di perdere.</span></div>
    </footer>`;

  // Event delegation: table sort
  document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      if (ST.sortKey === k) ST.sortDir = ST.sortDir === 'desc' ? 'asc' : 'desc';
      else { ST.sortKey = k; ST.sortDir = 'desc'; }
      render();
    });
  });

  document.querySelectorAll('[data-horizon]').forEach(tab => {
    tab.addEventListener('click', () => {
      ST.horizon = tab.dataset.horizon;
      render();
    });
  });

  document.querySelectorAll('[data-ai-request]').forEach(button => {
    button.addEventListener('click', () => requestAI(button.dataset.aiRequest));
  });

  // Restore AI zones
  Object.keys(ST.aiData).forEach(id => { if (ST.aiData[id]) renderAICard(id); });
  ST.aiLoading.forEach(id => renderAICard(id));
}

function calcSentiment(coins, fngVal, classification) {
  if (fngVal != null) return { value: fngVal, label: classification?.toUpperCase() || '—' };
  if (!coins.length)  return { value: null, label: null };
  const avg = coins.reduce((s,c) => s + (c.price_change_percentage_24h_in_currency||0), 0) / coins.length;
  const v   = Math.max(0, Math.min(100, 50 + avg * 2.5));
  let label = 'NEUTRAL';
  if (v >= 75) label = 'EXTREME GREED';
  else if (v >= 55) label = 'GREED';
  else if (v <= 25) label = 'EXTREME FEAR';
  else if (v <= 45) label = 'FEAR';
  return { value: Math.round(v), label };
}

// ── Bootstrap ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Clock tick
  setInterval(() => { ST.now = Date.now(); updateClock(); }, 1000);

  // Header buttons
  document.getElementById('btn-refresh').addEventListener('click', () => {
    document.getElementById('btn-refresh').classList.add('spinning');
    fetchAll(false).finally(() => {
      document.getElementById('btn-refresh').classList.remove('spinning');
    });
  });

  fetchAll();
  setInterval(() => fetchAll(true), REFRESH_MS);
});

function updateClock() {
  const el = document.getElementById('last-sync');
  if (!el || !ST.lastUpdate) return;
  const s = Math.max(0, Math.floor((ST.now - ST.lastUpdate.getTime()) / 1000));
  el.textContent = s < 60 ? `${s}s ago` : `${Math.floor(s/60)}m ago`;
}
