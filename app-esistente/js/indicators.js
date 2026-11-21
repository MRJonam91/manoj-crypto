// ═══════════════════════════════════════════
// INDICATORI TECNICI
// ═══════════════════════════════════════════

function calcRSI(prices, period = 14) {
  if (!Array.isArray(prices) || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  if (al === 0) return 100;
  if (ag === 0) return 0;
  return 100 - 100 / (1 + ag / al);
}

function getDailyRSI(sparkline) {
  if (!sparkline || sparkline.length < 15) return null;
  return calcRSI(sparkline.slice(-Math.min(48, sparkline.length)), 14);
}

function getWeeklyRSI(sparkline) {
  if (!sparkline || sparkline.length < 7) return null;
  const hpd = sparkline.length / 7;
  const daily = [];
  for (let i = 1; i <= 7; i++) {
    const idx = Math.min(Math.round(i * hpd) - 1, sparkline.length - 1);
    if (sparkline[idx] != null) daily.push(sparkline[idx]);
  }
  if (daily.length < 7) return null;
  return calcRSI(daily, 6);
}

function getVolatility(sparkline) {
  if (!sparkline || sparkline.length < 2) return null;
  const rets = [];
  for (let i = 1; i < sparkline.length; i++)
    rets.push((sparkline[i] - sparkline[i - 1]) / sparkline[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

// Calcola MACD semplificato dalla sparkline
function getMACD(sparkline) {
  if (!sparkline || sparkline.length < 26) return null;
  const ema = (arr, period) => {
    const k = 2 / (period + 1);
    let val = arr[0];
    for (let i = 1; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
    return val;
  };
  const ema12 = ema(sparkline.slice(-26), 12);
  const ema26 = ema(sparkline.slice(-26), 26);
  return ema12 - ema26;
}

function generateSignal(coin) {
  const { rsi_1d: r1, rsi_7d: r7,
          price_change_percentage_1h_in_currency: ch1h,
          price_change_percentage_24h_in_currency: ch24,
          price_change_percentage_7d_in_currency: ch7d,
          total_volume: vol, market_cap: mc } = coin;
  const vr = mc ? vol / mc : 0;

  if (r1 != null && r1 < 30 && ch1h > 0 && vr > 0.05)
    return { type: 'STRONG_BUY',  label: 'STRONG BUY',  score: 85 + Math.min(15, 30 - r1),   reason: 'Oversold + reversal in atto',           priority: 1 };
  if (r1 != null && r1 < 40 && ch24 > -5 && ch7d > 0)
    return { type: 'BUY',         label: 'BUY',          score: 65 + Math.min(15, 40 - r1),   reason: 'Oversold con trend positivo settimanale', priority: 2 };
  if (r1 != null && r1 > 70 && ch1h < 0)
    return { type: 'STRONG_SELL', label: 'STRONG SELL', score: 85 + Math.min(15, r1 - 70),   reason: 'Overbought + correzione iniziata',        priority: 1 };
  if (ch24 > 12 && vr > 0.15 && (r1 == null || r1 < 75))
    return { type: 'BREAKOUT',    label: 'BREAKOUT',     score: 75 + Math.min(20, ch24 - 12), reason: 'Rottura rialzista con volumi alti',       priority: 2 };
  if (ch24 < -12 && vr > 0.15)
    return { type: 'BREAKDOWN',   label: 'BREAKDOWN',    score: 75 + Math.min(20, -ch24 - 12),reason: 'Rottura ribassista con volumi alti',      priority: 2 };
  if (r1 != null && r1 > 60 && ch24 < 3 && ch7d < 0)
    return { type: 'SELL',        label: 'SELL',         score: 60 + Math.min(15, r1 - 60),   reason: 'Overbought con trend negativo',          priority: 3 };
  if (r1 != null && r1 >= 45 && r1 <= 65 && ch7d > 5 && ch24 > 0)
    return { type: 'ACCUMULATE',  label: 'ACCUMULATE',  score: 55 + Math.min(20, ch7d),       reason: 'Uptrend solido, RSI neutro',             priority: 3 };
  return null;
}

// ═══════════════════════════════════════════
// CALCOLO LIVELLI DI TRADING ALGORITMICO
// ═══════════════════════════════════════════

function calcTradeLevels(coin) {
  const sig = coin.signal;
  if (!sig) return null;

  const price = coin.current_price;
  const vol = coin.volatility || 2; // %
  const isLong  = ['STRONG_BUY','BUY','BREAKOUT','ACCUMULATE'].includes(sig.type);
  const isShort = ['STRONG_SELL','SELL','BREAKDOWN'].includes(sig.type);
  if (!isLong && !isShort) return null;

  // Risk: 1.5x volatilità (min 2%, max 12%)
  const riskPct = Math.max(0.02, Math.min(0.12, (vol / 100) * 1.5));
  const rrStrong = 2.5, rrNormal = 2.0;
  const rr = sig.type.includes('STRONG') || sig.type === 'BREAKOUT' ? rrStrong : rrNormal;

  if (isLong) {
    const sl    = price * (1 - riskPct);
    const risk  = price - sl;
    return { direction: 'LONG', entry: price, stop_loss: sl,
             tp1: price + risk * 1.2, tp2: price + risk * rr, tp3: price + risk * (rr * 1.6) };
  } else {
    const sl    = price * (1 + riskPct);
    const risk  = sl - price;
    return { direction: 'SHORT', entry: price, stop_loss: sl,
             tp1: price - risk * 1.2, tp2: price - risk * rr, tp3: price - risk * (rr * 1.6) };
  }
}

// ═══════════════════════════════════════════
// SPARKLINE SVG (no librerie esterne)
// ═══════════════════════════════════════════

function sparklineSVG(data, positive, w = 120, h = 30) {
  if (!data || data.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y];
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `M${pts[0][0].toFixed(1)},${h} ` + pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${w},${h} Z`;
  const col = positive ? '#a3e635' : '#fb7185';
  const gid = `sg${positive ? 'p' : 'n'}${Math.random().toString(36).slice(2,6)}`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${col}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" stroke="${col}" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
  </svg>`;
}
