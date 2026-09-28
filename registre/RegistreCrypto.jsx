/**
 * Registre Crypto : suivi personnel de portefeuille et de marché crypto.
 *
 * Composant React autonome (hooks + Recharts), exécutable tel quel en artifact.
 * - Cours : API publique CoinGecko (sans clé), requêtes espacées en file d'attente,
 *   cache mémoire, repli exponentiel sur erreur ou HTTP 429, actualisation toutes les 60 s.
 * - Mode dégradé : dernières données reçues (cache) ; à défaut, cours simulés signalés.
 * - Données utilisateur : état React uniquement (aucun localStorage) ;
 *   sauvegarde / restauration JSON, import / export CSV des transactions.
 * - Calculs : prix de revient unitaire moyen pondéré (frais d'achat inclus),
 *   plus-values latentes et réalisées (frais de vente déduits du produit de cession).
 */
import React, { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  LineChart,
} from "recharts";

/* ─────────────────────────── Constantes ─────────────────────────── */

const API_BASE = "https://api.coingecko.com/api/v3";
const REFRESH_MS = 60_000;
const MIN_GAP_MS = 1_200;
const TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const EPS = 1e-10;
const MIN_DATE = "2009-01-03";
const BACKUP_FORMAT = "registre-crypto";

const CURRENCIES = [
  { code: "EUR", label: "Euro" },
  { code: "USD", label: "Dollar US" },
  { code: "CHF", label: "Franc suisse" },
  { code: "GBP", label: "Livre sterling" },
];
const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

const PERIODS = [
  { days: 7, label: "7 J" },
  { days: 30, label: "30 J" },
  { days: 90, label: "90 J" },
  { days: 365, label: "1 an" },
];

const SERIES_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"];
const OTHER_COLOR = "var(--s-other)";
const MAX_SLICES = 7;

const VIEWS = [
  { id: "portefeuille", label: "Portefeuille", title: "Portefeuille", icon: "wallet" },
  { id: "marche", label: "Marché", title: "Marché", icon: "market" },
  { id: "alertes", label: "Alertes", title: "Alertes de prix", icon: "bell" },
  { id: "parametres", label: "Paramètres", title: "Paramètres", icon: "sliders" },
];

const PATHS = {
  top: (ccy) =>
    `/coins/markets?vs_currency=${ccy}&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h%2C7d`,
  ids: (ccy, ids) =>
    `/coins/markets?vs_currency=${ccy}&ids=${encodeURIComponent(ids.join(","))}&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=24h%2C7d`,
  history: (id, ccy, days) =>
    `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${ccy}&days=${days}${days > 90 ? "&interval=daily" : ""}`,
  search: (q) => `/search?query=${encodeURIComponent(q)}`,
  rates: () => "/exchange_rates",
};

/* ─────────────────────────── Formats (fr-FR) ─────────────────────────── */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);

const nfCache = new Map();
function nf(opts) {
  const key = JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat("fr-FR", opts);
    nfCache.set(key, f);
  }
  return f;
}
const dtfCache = new Map();
function dtf(opts) {
  const key = JSON.stringify(opts);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("fr-FR", opts);
    dtfCache.set(key, f);
  }
  return f;
}

function fmtMoney(v, cur, signed = false) {
  if (!isNum(v)) return "—";
  return nf({
    style: "currency",
    currency: cur,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(v);
}
function fmtPrice(v, cur) {
  if (!isNum(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1 || a === 0) return fmtMoney(v, cur);
  if (a >= 0.01) return nf({ style: "currency", currency: cur, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(v);
  return nf({ style: "currency", currency: cur, maximumSignificantDigits: 4 }).format(v);
}
function fmtCompact(v, cur, digits = 2) {
  if (!isNum(v)) return "—";
  return nf({ style: "currency", currency: cur, notation: "compact", maximumFractionDigits: digits }).format(v);
}
function fmtPct(v, signed = true) {
  if (!isNum(v)) return "—";
  return nf({
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(v / 100);
}
function fmtQty(v) {
  if (!isNum(v)) return "—";
  return nf({ maximumFractionDigits: 8 }).format(v);
}
/** Nombre sans séparateur de milliers, virgule décimale : pour les champs et le CSV. */
function fmtPlain(v, max = 12) {
  if (!isNum(v)) return "";
  return nf({ useGrouping: false, maximumFractionDigits: max }).format(v);
}
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
const fmtTime = (ts) => (isNum(ts) ? dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ts) : "—");
const fmtDay = (ts) => dtf({ day: "2-digit", month: "2-digit", year: "numeric" }).format(ts);
const fmtDayTime = (ts) =>
  dtf({ day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(ts);

/* ─────────────────────────── Saisie & dates ─────────────────────────── */

/** Accepte « 1 234,56 », « 1234.56 », « 1.234,56 » ; renvoie NaN si illisible. */
function parseDecimal(input) {
  if (typeof input === "number") return input;
  if (input == null) return NaN;
  let s = String(input).trim().replace(/[\s  ']/g, "");
  if (!s) return NaN;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s);
}

const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO = () => toISO(new Date());

/** AAAA-MM-JJ ou JJ/MM/AAAA (séparateurs / . -) → AAAA-MM-JJ, ou null si la date n'existe pas. */
function parseDateInput(value) {
  if (value == null) return null;
  const s = String(value).trim();
  let y;
  let m;
  let d;
  let mm = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (mm) [y, m, d] = [+mm[1], +mm[2], +mm[3]];
  else if ((mm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [+mm[1], +mm[2], +mm[3]];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function isoToTs(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
const coinMeta = (c) => ({ id: c.id, symbol: c.symbol, name: c.name, image: c.image || null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function downsample(arr, n) {
  if (!Array.isArray(arr) || arr.length <= n) return arr || [];
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
}

/* ─────────────────────────── Client CoinGecko ─────────────────────────── */

class ApiError extends Error {
  constructor(kind, message, status = 0, retryAfter = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function describeError(err) {
  if (!err) return "";
  switch (err.kind) {
    case "rate_limited":
      return "limite de requêtes CoinGecko atteinte";
    case "timeout":
      return "délai de réponse dépassé";
    case "network":
      return "CoinGecko injoignable (réseau, blocage de l'environnement ou limite de requêtes)";
    case "http":
      return `erreur du serveur CoinGecko (HTTP ${err.status})`;
    case "parse":
      return "réponse CoinGecko illisible";
    default:
      return err.message || "erreur inconnue";
  }
}

/**
 * File d'attente unique : une requête à la fois, espacées d'au moins MIN_GAP_MS.
 * Après un échec (429, réseau, 5xx), plus aucun appel avant `blockedUntil`
 * (15 s, 30 s, 60 s… plafonné à 5 min ; au moins 60 s ou Retry-After sur un 429).
 * En cas d'échec, la dernière réponse en cache est renvoyée, marquée `stale`.
 */
function createClient() {
  const cache = new Map();
  const inflight = new Map();
  let chain = Promise.resolve();
  let lastCall = 0;
  let failures = 0;
  let blockedUntil = 0;
  let lastError = null;

  function penalize(err) {
    failures += 1;
    let wait = Math.min(300_000, 15_000 * 2 ** (failures - 1));
    if (err.kind === "rate_limited") wait = Math.max(wait, 60_000);
    if (err.retryAfter > 0) wait = Math.max(wait, err.retryAfter * 1000);
    blockedUntil = Date.now() + wait;
    lastError = err;
  }

  async function hit(path) {
    if (Date.now() < blockedUntil && lastError) {
      throw new ApiError(lastError.kind, "Pause après un échec", lastError.status);
    }
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(API_BASE + path, { signal: ctrl.signal, headers: { accept: "application/json" } });
      } catch (e) {
        throw new ApiError(e && e.name === "AbortError" ? "timeout" : "network", String((e && e.message) || e));
      }
      if (res.status === 429) {
        throw new ApiError("rate_limited", "HTTP 429", 429, Number(res.headers.get("retry-after")) || 0);
      }
      if (!res.ok) throw new ApiError("http", `HTTP ${res.status}`, res.status);
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw new ApiError(ctrl.signal.aborted ? "timeout" : "parse", "Réponse illisible");
      }
      failures = 0;
      blockedUntil = 0;
      lastError = null;
      const ts = Date.now();
      cache.set(path, { data, ts });
      return { data, ts, fromCache: false, stale: false };
    } catch (err) {
      if (err instanceof ApiError && (err.kind !== "http" || err.status >= 500)) penalize(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function request(path, { ttl = 0 } = {}) {
    const cached = cache.get(path);
    if (cached && ttl > 0 && Date.now() - cached.ts < ttl) {
      return Promise.resolve({ data: cached.data, ts: cached.ts, fromCache: true, stale: false });
    }
    if (inflight.has(path)) return inflight.get(path);
    const run = () => hit(path);
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    const out = p
      .catch((err) => {
        const last = cache.get(path);
        if (last) return { data: last.data, ts: last.ts, fromCache: true, stale: true, error: err };
        throw err;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, out);
    return out;
  }

  return {
    request,
    blockedUntil: () => blockedUntil,
    blockedKind: () => (Date.now() < blockedUntil && lastError ? lastError.kind : null),
    resetBackoff: () => {
      blockedUntil = 0;
    },
  };
}

const client = createClient();

function normalizeCoin(c) {
  const spark = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name || c.id,
    image: c.image || null,
    price: isNum(c.current_price) ? c.current_price : null,
    change24h: isNum(c.price_change_percentage_24h_in_currency)
      ? c.price_change_percentage_24h_in_currency
      : isNum(c.price_change_percentage_24h)
        ? c.price_change_percentage_24h
        : null,
    change7d: isNum(c.price_change_percentage_7d_in_currency) ? c.price_change_percentage_7d_in_currency : null,
    mcap: isNum(c.market_cap) ? c.market_cap : null,
    rank: isNum(c.market_cap_rank) ? c.market_cap_rank : null,
    spark: downsample(spark.filter(isNum), 42).map((v) => ({ v })),
  };
}
const normalizeList = (data) => (Array.isArray(data) ? data.filter((c) => c && c.id).map(normalizeCoin) : []);

/* ─────────────────────────── Cours simulés (repli) ─────────────────────────── */

// Utilisés uniquement si CoinGecko n'a jamais répondu : valeurs fictives, affichées comme telles.
const DEMO_FX = { eur: 1, usd: 1.17, chf: 0.935, gbp: 0.87 };
const DEMO_COINS = [
  ["bitcoin", "BTC", "Bitcoin", 98000, 19.9e6, 0.025],
  ["ethereum", "ETH", "Ethereum", 3600, 120.7e6, 0.035],
  ["tether", "USDT", "Tether", 0.855, 185e9, 0.0004],
  ["ripple", "XRP", "XRP", 2.1, 59e9, 0.045],
  ["binancecoin", "BNB", "BNB", 780, 139e6, 0.028],
  ["solana", "SOL", "Solana", 190, 540e6, 0.05],
  ["usd-coin", "USDC", "USDC", 0.855, 75e9, 0.0004],
  ["dogecoin", "DOGE", "Dogecoin", 0.21, 150e9, 0.06],
  ["tron", "TRX", "TRON", 0.3, 94.7e9, 0.03],
  ["cardano", "ADA", "Cardano", 0.72, 36e9, 0.05],
  ["chainlink", "LINK", "Chainlink", 19, 678e6, 0.05],
  ["avalanche-2", "AVAX", "Avalanche", 26, 422e6, 0.055],
  ["stellar", "XLM", "Stellar", 0.35, 31e9, 0.045],
  ["sui", "SUI", "Sui", 3.2, 3.5e9, 0.065],
  ["hedera-hashgraph", "HBAR", "Hedera", 0.22, 42e9, 0.055],
  ["bitcoin-cash", "BCH", "Bitcoin Cash", 480, 19.9e6, 0.04],
  ["litecoin", "LTC", "Litecoin", 95, 76e6, 0.04],
  ["polkadot", "DOT", "Polkadot", 4.5, 1.6e9, 0.05],
  ["uniswap", "UNI", "Uniswap", 9, 630e6, 0.055],
  ["near", "NEAR", "NEAR Protocol", 2.8, 1.25e9, 0.06],
  ["aave", "AAVE", "Aave", 250, 15.2e6, 0.055],
  ["internet-computer", "ICP", "Internet Computer", 5.5, 540e6, 0.06],
  ["cosmos", "ATOM", "Cosmos Hub", 4.4, 470e6, 0.05],
  ["monero", "XMR", "Monero", 290, 18.4e6, 0.035],
];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
function walkSeries(r, n, stepVol, end) {
  const raw = [1];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1] * Math.exp(gauss(r) * stepVol));
  const k = end / raw[n - 1];
  return raw.map((v) => v * k);
}
function createDemoState() {
  return {
    tick: 0,
    coins: DEMO_COINS.map(([id, symbol, name, price, supply, vol]) => ({
      id,
      symbol,
      name,
      supply,
      vol,
      series: walkSeries(mulberry32(hashStr(id)), 168, vol / Math.sqrt(24), price),
    })),
  };
}
function advanceDemo(state) {
  state.tick += 1;
  for (const c of state.coins) {
    const r = mulberry32(hashStr(c.id) + state.tick * 7919);
    const last = c.series[c.series.length - 1];
    c.series = [...c.series.slice(1), last * Math.exp(gauss(r) * (c.vol / Math.sqrt(24)))];
  }
}
function demoMarket(state, cur) {
  const fx = DEMO_FX[cur.toLowerCase()] || 1;
  return state.coins
    .map((c) => {
      const s = c.series;
      const last = s[s.length - 1];
      return {
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        image: null,
        price: last * fx,
        change24h: (last / s[s.length - 25] - 1) * 100,
        change7d: (last / s[0] - 1) * 100,
        mcap: last * c.supply * fx,
        rank: 0,
        spark: downsample(s, 42).map((v) => ({ v: v * fx })),
      };
    })
    .sort((a, b) => b.mcap - a.mcap)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
function demoHistory(state, id, days, cur) {
  const c = state.coins.find((x) => x.id === id);
  if (!c) return null;
  const fx = DEMO_FX[cur.toLowerCase()] || 1;
  const n = 150;
  const now = Date.now();
  const start = now - days * DAY_MS;
  const r = mulberry32(hashStr(`${id}:${days}`));
  const raw = walkSeries(r, n, c.vol * Math.sqrt(days / n), c.series[c.series.length - 1]);
  return raw.map((v, i) => [start + (i * (now - start)) / (n - 1), v * fx]);
}

/* ─────────────────────────── Calculs du portefeuille ─────────────────────────── */

// Ordre comptable : date, puis achats avant ventes le même jour, puis ordre de saisie.
function sortTx(list) {
  return [...list].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.type === b.type ? 0 : a.type === "achat" ? -1 : 1) ||
      (a.createdAt || 0) - (b.createdAt || 0),
  );
}

/** Vérifie qu'aucune vente ne dépasse le solde détenu à sa date. */
function validateLedger(transactions) {
  const qty = new Map();
  for (const t of sortTx(transactions)) {
    const q = qty.get(t.coinId) || 0;
    if (t.type === "vente") {
      if (t.quantity > q + Math.max(EPS, q * 1e-9)) return { ok: false, tx: t, available: q };
      qty.set(t.coinId, Math.max(0, q - t.quantity));
    } else {
      qty.set(t.coinId, q + t.quantity);
    }
  }
  return { ok: true };
}
function ledgerMessage(check) {
  const t = check.tx;
  return `La vente du ${fmtDate(t.date)} (${fmtQty(t.quantity)} ${t.symbol}) dépasse le solde détenu à cette date (${fmtQty(check.available)} ${t.symbol}).`;
}
function balanceAt(transactions, coinId, dateISO) {
  let q = 0;
  for (const t of sortTx(transactions)) {
    if (t.coinId !== coinId || t.date > dateISO) continue;
    q += t.type === "achat" ? t.quantity : -t.quantity;
  }
  return Math.max(0, q);
}

/**
 * Méthode du prix moyen pondéré : les frais d'achat entrent dans le coût de revient,
 * une vente sort `quantité × PRU` du coût et dégage (produit net − coût sorti) en réalisé.
 * `conv(montant, devise)` convertit vers la devise d'affichage (NaN si impossible).
 */
function computePositions(transactions, conv) {
  const map = new Map();
  for (const t of sortTx(transactions)) {
    let p = map.get(t.coinId);
    if (!p) {
      p = {
        coinId: t.coinId,
        symbol: t.symbol,
        name: t.name,
        image: t.image || null,
        qty: 0,
        cost: 0,
        realized: 0,
        soldCost: 0,
        fees: 0,
        buyCount: 0,
        sellCount: 0,
        firstDate: t.date,
      };
      map.set(t.coinId, p);
    }
    p.symbol = t.symbol || p.symbol;
    p.name = t.name || p.name;
    p.image = t.image || p.image;
    const price = conv(t.price, t.currency);
    const fees = conv(t.fees || 0, t.currency);
    p.fees += fees;
    if (t.type === "achat") {
      p.cost += t.quantity * price + fees;
      p.qty += t.quantity;
      p.buyCount += 1;
    } else {
      const pru = p.qty > 0 ? p.cost / p.qty : 0;
      const out = t.quantity * pru;
      p.realized += t.quantity * price - fees - out;
      p.soldCost += out;
      p.cost -= out;
      p.qty -= t.quantity;
      p.sellCount += 1;
      if (p.qty <= EPS) {
        p.qty = 0;
        p.cost = 0;
      }
    }
  }
  return [...map.values()].map((p) => ({ ...p, pru: p.qty > 0 ? p.cost / p.qty : null }));
}

function enrichPositions(positions, priceMap) {
  return positions.map((p) => {
    const c = priceMap.get(p.coinId);
    const price = c && isNum(c.price) ? c.price : null;
    const value = price != null ? p.qty * price : null;
    const latent = value != null && isNum(p.cost) ? value - p.cost : null;
    const latentPct = latent != null && p.cost > 0 ? (latent / p.cost) * 100 : null;
    const ch = c ? c.change24h : null;
    const value24h = value != null && isNum(ch) && ch > -100 ? value / (1 + ch / 100) : null;
    const realizedPct = p.soldCost > 0 && isNum(p.realized) ? (p.realized / p.soldCost) * 100 : null;
    return { ...p, image: p.image || (c && c.image) || null, price, value, latent, latentPct, value24h, realizedPct };
  });
}

function summarize(rows) {
  const open = rows.filter((r) => r.qty > 0);
  const priced = open.filter((r) => r.value != null);
  const pricedCost = sum(priced, (r) => r.cost);
  const value = priced.length ? sum(priced, (r) => r.value) : open.length ? null : 0;
  const latent = priced.length ? value - pricedCost : null;
  const soldCost = sum(rows, (r) => r.soldCost);
  const realized = sum(rows, (r) => r.realized);
  const with24 = priced.filter((r) => r.value24h != null);
  const v24 = sum(with24, (r) => r.value24h);
  const change24 = with24.length ? sum(with24, (r) => r.value) - v24 : null;
  return {
    value,
    cost: sum(open, (r) => r.cost),
    latent,
    latentPct: latent != null && pricedCost > 0 ? (latent / pricedCost) * 100 : null,
    realized,
    realizedPct: soldCost > 0 ? (realized / soldCost) * 100 : null,
    change24,
    change24Pct: change24 != null && v24 > 0 ? (change24 / v24) * 100 : null,
    fees: sum(rows, (r) => r.fees),
    sells: sum(rows, (r) => r.sellCount),
    openCount: open.length,
    missing: open.length - priced.length,
  };
}

function buildSlices(rows, total) {
  const open = rows.filter((r) => r.qty > 0 && isNum(r.value) && r.value > 0);
  if (!open.length || !(total > 0)) return [];
  const byValue = [...open].sort((a, b) => b.value - a.value);
  const kept = byValue.length > MAX_SLICES + 1 ? byValue.slice(0, MAX_SLICES) : byValue;
  const keep = new Set(kept.map((r) => r.coinId));
  // Couleur attachée à l'actif (ordre d'acquisition), pas à son rang.
  const slices = open
    .filter((r) => keep.has(r.coinId))
    .sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.name.localeCompare(b.name))
    .map((r, i) => ({
      key: r.coinId,
      name: r.name,
      symbol: r.symbol,
      value: r.value,
      pct: (r.value / total) * 100,
      color: SERIES_COLORS[i],
    }));
  const rest = open.filter((r) => !keep.has(r.coinId));
  if (rest.length) {
    const v = sum(rest, (r) => r.value);
    slices.push({ key: "__autres", name: `Autres (${rest.length})`, symbol: "", value: v, pct: (v / total) * 100, color: OTHER_COLOR, members: rest.map((r) => r.coinId) });
  }
  return slices;
}

/** Actifs détenus à un moment de la période : ceux dont on charge l'historique. */
function coinsActiveInPeriod(transactions, startTs) {
  const ids = new Set();
  const before = new Map();
  for (const t of sortTx(transactions)) {
    if (isoToTs(t.date) >= startTs) {
      ids.add(t.coinId);
      continue;
    }
    before.set(t.coinId, (before.get(t.coinId) || 0) + (t.type === "achat" ? t.quantity : -t.quantity));
  }
  for (const [id, q] of before) if (q > EPS) ids.add(id);
  return [...ids].sort();
}

function replayEvents(txs, conv) {
  const events = [];
  let qty = 0;
  let cost = 0;
  for (const t of txs) {
    const price = conv(t.price, t.currency);
    const fees = conv(t.fees || 0, t.currency);
    if (t.type === "achat") {
      cost += t.quantity * price + fees;
      qty += t.quantity;
    } else {
      const pru = qty > 0 ? cost / qty : 0;
      cost -= t.quantity * pru;
      qty -= t.quantity;
      if (qty <= EPS) {
        qty = 0;
        cost = 0;
      }
    }
    events.push({ ts: isoToTs(t.date), qty, cost });
  }
  return events;
}
function lastAtOrBefore(arr, t, getTs) {
  let lo = 0;
  let hi = arr.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (getTs(arr[mid]) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
function priceAt(points, t) {
  const i = lastAtOrBefore(points, t, (p) => p[0]);
  if (i >= 0) return points[i][1];
  return points.length && points[0][0] - t < 2 * DAY_MS ? points[0][1] : null;
}

/** Valeur et capital investi du portefeuille sur une grille de 120 points. */
function buildValueSeries({ transactions, histories, days, conv, priceMap }) {
  const now = Date.now();
  const start = now - days * DAY_MS;
  const groups = new Map();
  for (const t of sortTx(transactions)) {
    if (!groups.has(t.coinId)) groups.set(t.coinId, []);
    groups.get(t.coinId).push(t);
  }
  const coins = [];
  for (const [id, txs] of groups) {
    const hist = histories.get(id);
    if (!hist || !hist.length) continue;
    const live = priceMap.get(id);
    coins.push({ events: replayEvents(txs, conv), hist, live: live && isNum(live.price) ? live.price : null });
  }
  const N = 120;
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = i === N - 1 ? now : start + (i * (now - start)) / (N - 1);
    let value = 0;
    let invested = 0;
    let gap = false;
    for (const c of coins) {
      const k = lastAtOrBefore(c.events, t, (e) => e.ts);
      if (k < 0 || c.events[k].qty <= 0) continue;
      const price = i === N - 1 && c.live != null ? c.live : priceAt(c.hist, t);
      if (!isNum(price)) {
        gap = true;
        continue;
      }
      value += c.events[k].qty * price;
      invested += c.events[k].cost;
    }
    out.push({ t, value: gap ? null : value, invested: gap ? null : invested });
  }
  return out;
}

/* ─────────────────────────── Validation des transactions ─────────────────────────── */

function validateTxFields(f) {
  const e = {};
  if (!f.coin) e.coin = "Choisissez un actif.";
  if (f.type !== "achat" && f.type !== "vente") e.type = "Type d'opération inconnu (achat ou vente).";
  if (!f.date) e.date = "Date invalide (format JJ/MM/AAAA).";
  else if (f.date < MIN_DATE) e.date = "La date doit être postérieure au 03/01/2009 (premier bloc Bitcoin).";
  else if (f.date > todayISO()) e.date = "La date ne peut pas être dans le futur.";
  if (!isNum(f.quantity) || f.quantity <= 0) e.quantity = "La quantité doit être un nombre strictement positif.";
  else if (f.quantity > 1e15) e.quantity = "Quantité trop élevée.";
  if (!isNum(f.price) || f.price < 0) e.price = "Le prix unitaire doit être un nombre positif ou nul.";
  if (!isNum(f.fees) || f.fees < 0) e.fees = "Les frais doivent être un nombre positif ou nul.";
  if (!CURRENCY_CODES.includes(f.currency)) e.currency = `Devise non prise en charge (${CURRENCY_CODES.join(", ")}).`;
  return e;
}
const txKey = (t) => [t.coinId, t.type, t.date, t.quantity, t.price, t.fees || 0, t.currency].join("|");

/* ─────────────────────────── CSV ─────────────────────────── */

const CSV_HEADERS = ["date", "type", "actif_id", "symbole", "nom", "quantite", "prix_unitaire", "frais", "devise", "note"];
const CSV_EXAMPLE = "15/01/2025;achat;bitcoin;BTC;Bitcoin;0,05;92500;4,5;EUR;Achat mensuel";
const CSV_ALIASES = {
  date: ["date", "jour"],
  type: ["type", "operation", "sens", "nature"],
  coinId: ["actifid", "idactif", "id", "coingeckoid", "coingecko", "coin"],
  symbol: ["symbole", "symbol", "ticker", "actif", "crypto"],
  name: ["nom", "name", "libelle"],
  quantity: ["quantite", "qte", "quantity", "qty", "volume"],
  price: ["prixunitaire", "prix", "price", "cours", "prixunit"],
  fees: ["frais", "fees", "fee", "commission"],
  currency: ["devise", "currency", "monnaie"],
  note: ["note", "notes", "commentaire", "memo"],
};
const CSV_LABELS = { date: "date", type: "type", quantity: "quantite", price: "prix_unitaire" };

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function transactionsToCSV(transactions) {
  const lines = [CSV_HEADERS.join(";")];
  for (const t of sortTx(transactions)) {
    lines.push(
      [
        fmtDate(t.date),
        t.type,
        t.coinId,
        t.symbol,
        t.name,
        fmtPlain(t.quantity),
        fmtPlain(t.price),
        fmtPlain(t.fees || 0),
        t.currency,
        t.note || "",
      ]
        .map(csvCell)
        .join(";"),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

function parseCSV(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] || "";
  const counts = { ";": 0, ",": 0, "\t": 0 };
  let inQ = false;
  for (const ch of first) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch] += 1;
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ";";
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ cells: row, line: rowLine });
      row = [];
      field = "";
      line++;
      rowLine = line;
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push({ cells: row, line: rowLine });
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}

function parseType(v) {
  const s = norm(v).trim();
  if (["achat", "buy", "a", "b", "acheter", "purchase", "entree"].includes(s)) return "achat";
  if (["vente", "sell", "v", "s", "vendre", "sale", "sortie"].includes(s)) return "vente";
  return null;
}

/** Analyse un CSV : transactions valides, doublons ignorés, erreurs par ligne, contrôle du solde. */
function analyzeCSV(text, { resolveCoin, defaultCurrency, existing }) {
  const rows = parseCSV(text);
  if (!rows.length) return { valid: [], duplicates: 0, errors: [{ line: 0, message: "Le fichier est vide." }] };
  const header = rows[0].cells.map((h) => norm(h).replace(/[^a-z0-9]/g, ""));
  const col = {};
  for (const [key, aliases] of Object.entries(CSV_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx >= 0) col[key] = idx;
  }
  const missing = ["date", "type", "quantity", "price"].filter((k) => col[k] == null).map((k) => CSV_LABELS[k]);
  if (col.coinId == null && col.symbol == null) missing.push("actif_id ou symbole");
  if (missing.length) {
    return {
      valid: [],
      duplicates: 0,
      errors: [{ line: rows[0].line, message: `Colonnes manquantes : ${missing.join(", ")}. En-tête attendu : ${CSV_HEADERS.join(";")}` }],
    };
  }
  const existingKeys = new Set(existing.map(txKey));
  const valid = [];
  const errors = [];
  const lineOf = new Map();
  let duplicates = 0;
  const base = Date.now();
  rows.slice(1).forEach((r, i) => {
    const get = (k) => (col[k] == null ? "" : String(r.cells[col[k]] == null ? "" : r.cells[col[k]]).trim());
    const coin = resolveCoin({ id: get("coinId").toLowerCase(), symbol: get("symbol"), name: get("name") });
    const feesRaw = get("fees");
    const fields = {
      coin,
      type: parseType(get("type")),
      date: parseDateInput(get("date")),
      quantity: parseDecimal(get("quantity")),
      price: parseDecimal(get("price")),
      fees: feesRaw ? parseDecimal(feesRaw) : 0,
      currency: (get("currency") || defaultCurrency).toUpperCase(),
    };
    const errs = validateTxFields(fields);
    if (errs.coin) errs.coin = `actif introuvable (${get("coinId") || get("symbol") || "vide"}) : renseignez l'identifiant CoinGecko dans actif_id.`;
    if (Object.keys(errs).length) {
      errors.push({ line: r.line, message: Object.values(errs).join(" ") });
      return;
    }
    const tx = {
      id: uid(),
      coinId: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      image: coin.image || null,
      type: fields.type,
      date: fields.date,
      quantity: fields.quantity,
      price: fields.price,
      fees: fields.fees,
      currency: fields.currency,
      note: get("note").slice(0, 140),
      createdAt: base + i,
    };
    if (existingKeys.has(txKey(tx))) {
      duplicates += 1;
      return;
    }
    lineOf.set(tx.id, r.line);
    valid.push(tx);
  });
  // Écarte les ventes importées qui rendraient un solde négatif.
  let guard = valid.length + 1;
  while (guard-- > 0) {
    const check = validateLedger([...existing, ...valid]);
    if (check.ok) break;
    let culprit = lineOf.has(check.tx.id) ? check.tx : null;
    if (!culprit) {
      culprit = sortTx(valid.filter((t) => t.type === "vente" && t.coinId === check.tx.coinId && t.date <= check.tx.date)).pop() || null;
    }
    if (!culprit) {
      errors.push({ line: 0, message: ledgerMessage(check) });
      valid.length = 0;
      break;
    }
    errors.push({ line: lineOf.get(culprit.id), message: ledgerMessage({ tx: culprit, available: balanceAt([...existing, ...valid.filter((t) => t.id !== culprit.id)], culprit.coinId, culprit.date) }) });
    valid.splice(valid.indexOf(culprit), 1);
  }
  errors.sort((a, b) => a.line - b.line);
  return { valid, duplicates, errors };
}

/* ─────────────────────────── Sauvegarde JSON ─────────────────────────── */

function buildBackup({ settings, transactions, watchlist, alerts }) {
  return JSON.stringify(
    { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), settings, transactions, watchlist, alerts },
    null,
    2,
  );
}

function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(String(text || "").replace(/^﻿/, ""));
  } catch (e) {
    return { ok: false, error: "Le contenu n'est pas un JSON valide." };
  }
  if (!obj || obj.format !== BACKUP_FORMAT) {
    return { ok: false, error: "Ce fichier n'est pas une sauvegarde Registre Crypto (champ « format » absent ou différent)." };
  }
  if (!Array.isArray(obj.transactions)) return { ok: false, error: "Sauvegarde incomplète : liste « transactions » absente." };
  const problems = [];
  const transactions = [];
  obj.transactions.forEach((t, i) => {
    const tx = {
      id: String((t && t.id) || uid()),
      coinId: String((t && t.coinId) || ""),
      symbol: String((t && t.symbol) || "").toUpperCase(),
      name: String((t && (t.name || t.coinId)) || ""),
      image: t && typeof t.image === "string" ? t.image : null,
      type: t && t.type,
      date: parseDateInput(t && t.date),
      quantity: Number(t && t.quantity),
      price: Number(t && t.price),
      fees: t && t.fees != null ? Number(t.fees) : 0,
      currency: String((t && t.currency) || "EUR").toUpperCase(),
      note: String((t && t.note) || "").slice(0, 140),
      createdAt: Number(t && t.createdAt) || Date.now() + i,
    };
    const errs = validateTxFields({ ...tx, coin: tx.coinId ? tx : null });
    if (Object.keys(errs).length) problems.push(`Transaction n° ${i + 1} : ${Object.values(errs)[0]}`);
    else transactions.push(tx);
  });
  if (problems.length) {
    return { ok: false, error: `Sauvegarde refusée : ${problems.length} transaction(s) invalide(s).`, details: problems.slice(0, 12) };
  }
  const ledger = validateLedger(transactions);
  if (!ledger.ok) return { ok: false, error: `Sauvegarde refusée : ${ledgerMessage(ledger)}` };
  const watchlist = Array.isArray(obj.watchlist) ? [...new Set(obj.watchlist.filter((x) => typeof x === "string" && x))] : [];
  const alerts = (Array.isArray(obj.alerts) ? obj.alerts : [])
    .filter(
      (a) =>
        a &&
        typeof a.coinId === "string" &&
        (a.direction === "above" || a.direction === "below") &&
        isNum(Number(a.threshold)) &&
        Number(a.threshold) > 0 &&
        CURRENCY_CODES.includes(String(a.currency || "").toUpperCase()),
    )
    .map((a) => ({
      id: String(a.id || uid()),
      coinId: a.coinId,
      symbol: String(a.symbol || a.coinId).toUpperCase(),
      name: String(a.name || a.coinId),
      image: typeof a.image === "string" ? a.image : null,
      direction: a.direction,
      threshold: Number(a.threshold),
      currency: String(a.currency).toUpperCase(),
      createdAt: Number(a.createdAt) || Date.now(),
      triggeredAt: isNum(a.triggeredAt) ? a.triggeredAt : null,
      triggeredPrice: isNum(a.triggeredPrice) ? a.triggeredPrice : null,
      triggeredCurrency: typeof a.triggeredCurrency === "string" ? a.triggeredCurrency : null,
      simulated: !!a.simulated,
      seen: true,
    }));
  const s = obj.settings || {};
  const settings = {};
  if (CURRENCY_CODES.includes(s.currency)) settings.currency = s.currency;
  if (s.theme === "light" || s.theme === "dark") settings.theme = s.theme;
  return {
    ok: true,
    data: { transactions, watchlist, alerts, settings },
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : null,
  };
}

/* ─────────────────────────── Portefeuille d'exemple ─────────────────────────── */

function buildSamplePortfolio(currency, priceMap) {
  const fx = DEMO_FX[currency.toLowerCase()] || 1;
  const px = (id, fallbackEur) => {
    const c = priceMap.get(id);
    return c && isNum(c.price) ? c.price : fallbackEur * fx;
  };
  const round = (v) => (v >= 1 ? Math.round(v * 100) / 100 : Number(v.toPrecision(4)));
  const day = (n) => toISO(new Date(Date.now() - n * DAY_MS));
  const base = Date.now();
  const mk = (i, coinId, symbol, name, type, daysAgo, quantity, factor, fallback, fees) => ({
    id: uid(),
    coinId,
    symbol,
    name,
    image: priceMap.get(coinId) ? priceMap.get(coinId).image : null,
    type,
    date: day(daysAgo),
    quantity,
    price: round(px(coinId, fallback) * factor),
    fees,
    currency,
    note: "Exemple",
    createdAt: base + i,
  });
  return [
    mk(0, "bitcoin", "BTC", "Bitcoin", "achat", 420, 0.05, 0.62, 98000, 4.5),
    mk(1, "ethereum", "ETH", "Ethereum", "achat", 300, 1.2, 0.8, 3600, 3),
    mk(2, "bitcoin", "BTC", "Bitcoin", "achat", 150, 0.03, 0.9, 98000, 2.5),
    mk(3, "solana", "SOL", "Solana", "achat", 75, 12, 0.85, 190, 1.8),
    mk(4, "ethereum", "ETH", "Ethereum", "vente", 40, 0.4, 1.12, 3600, 2),
    mk(5, "chainlink", "LINK", "Chainlink", "achat", 20, 40, 0.95, 19, 1),
  ];
}

/* ─────────────────────────── Fichiers (export) ─────────────────────────── */

let downloadsCapability = null;
function initDownloadsCapability() {
  try {
    const c = typeof window !== "undefined" ? window.claude : null;
    if (c && typeof c.use === "function") {
      Promise.resolve(c.use("downloads"))
        .then((d) => {
          downloadsCapability = d || null;
        })
        .catch(() => {});
    }
  } catch (e) {
    /* capacité absente : repli sur le lien de téléchargement */
  }
}
async function saveFile(filename, content, mime) {
  if (downloadsCapability) {
    try {
      await downloadsCapability.save({ filename, data: content });
      return "saved";
    } catch (e) {
      if (e && e.code === "declined") return "declined";
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return "started";
  } catch (e) {
    return "failed";
  }
}

function detectTheme() {
  try {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch (e) {
    return "light";
  }
}

/* ─────────────────────────── Styles ─────────────────────────── */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;600;700&display=swap');
.rc{
  --bg:#F3F5F8;--surface:#FFFFFF;--surface-2:#F6F8FA;--surface-3:#EBEFF4;
  --ink:#121A24;--ink-2:#3E4A59;--muted:#667385;--rule:#DEE3EA;--rule-2:#C7CFDA;
  --accent:#1D4B99;--accent-soft:#E6EDF9;--btn:#1D4B99;--btn-hover:#173E80;--btn-ink:#FFFFFF;
  --gain:#0E7A3E;--gain-soft:#E2F3E9;--loss:#B42318;--loss-soft:#FCE8E5;
  --warn:#8A5300;--warn-soft:#FDF1DB;--warn-rule:#EDC67C;
  --demo:#553E9C;--demo-soft:#EFEBFA;--demo-rule:#C8BCEB;
  --focus:#2F6BE0;--av-l:88%;
  --shadow:0 1px 2px rgba(18,26,36,.06),0 8px 24px rgba(18,26,36,.08);
  --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s8:#e34948;--s-other:#98A2AF;
  --font:'Public Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;font-family:var(--font);font-size:14px;line-height:1.45;color:var(--ink);background:var(--bg);
  min-height:100vh;-webkit-font-smoothing:antialiased;text-align:left;
}
.rc[data-theme="dark"]{
  --bg:#0E131A;--surface:#141B24;--surface-2:#19212C;--surface-3:#222C39;
  --ink:#E6EBF1;--ink-2:#B4BFCC;--muted:#8B97A7;--rule:#253040;--rule-2:#354356;
  --accent:#8EB3F6;--accent-soft:#1B2A45;--btn:#3A68C4;--btn-hover:#4777D3;--btn-ink:#FFFFFF;
  --gain:#4CC585;--gain-soft:#12301F;--loss:#F4786C;--loss-soft:#3A1916;
  --warn:#E9AE4A;--warn-soft:#30240E;--warn-rule:#5A4217;
  --demo:#B9A8F3;--demo-soft:#231C3B;--demo-rule:#453970;
  --focus:#7FA6F5;--av-l:28%;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 28px rgba(0,0,0,.4);
  --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;--s-other:#6B7686;
  color-scheme:dark;
}
.rc *,.rc *::before,.rc *::after{box-sizing:border-box}
.rc h1,.rc h2,.rc h3,.rc p,.rc ul{margin:0}
.rc ul{padding:0;list-style:none}
.rc button,.rc input,.rc select,.rc textarea{font:inherit;color:inherit}
.rc button{cursor:pointer}
.rc :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.rc-num{font-variant-numeric:tabular-nums}
.rc-mono{font-family:var(--mono);font-size:12.5px}
.rc-muted{color:var(--muted)}
.rc-up{color:var(--gain)}.rc-down{color:var(--loss)}
.rc-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

.rc-shell{display:flex;min-height:100vh}
.rc-rail{display:none}
.rc-main{flex:1;min-width:0;display:flex;flex-direction:column}
.rc-top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;padding:10px 16px;
  background:var(--bg);background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--rule)}
.rc-top-title{font-size:17px;font-weight:650;letter-spacing:-.01em;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-top-meta{display:none;font-size:12px;color:var(--muted);white-space:nowrap}
.rc-brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.01em;font-size:15px}
.rc-brand-mark{width:28px;height:28px;border-radius:7px;background:var(--btn);color:var(--btn-ink);display:grid;place-items:center;flex:none}
.rc-brand small{display:block;font-size:11.5px;font-weight:500;color:var(--muted);letter-spacing:0}
.rc-top .rc-brand-text{display:none}
.rc-content{width:100%;max-width:1240px;margin:0 auto;padding:16px 16px calc(92px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:16px}
.rc-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:30;display:grid;grid-template-columns:repeat(4,1fr);background:var(--surface);
  border-top:1px solid var(--rule);padding-bottom:env(safe-area-inset-bottom,0px)}
.rc-tab{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 4px 8px;border:0;background:none;font-size:11px;font-weight:600;color:var(--muted)}
.rc-tab[aria-current="page"]{color:var(--accent)}
.rc-badge{min-width:17px;height:17px;padding:0 5px;border-radius:9px;background:var(--loss);color:#fff;font-size:10.5px;font-weight:700;display:inline-grid;place-items:center;line-height:1}
.rc-tab .rc-badge{position:absolute;top:3px;left:calc(50% + 5px)}
.rc-tab .rc-dirty{position:absolute;top:6px;left:calc(50% + 9px)}
.rc-dirty{width:8px;height:8px;border-radius:50%;background:var(--warn);display:inline-block}
@media (min-width:560px){.rc-top-meta{display:inline}}
@media (min-width:960px){
  .rc-rail{display:flex;flex-direction:column;gap:22px;width:236px;flex:none;padding:18px 14px;border-right:1px solid var(--rule);
    background:var(--surface);position:sticky;top:0;height:100vh}
  .rc-tabbar{display:none}
  .rc-top{padding:12px 28px}
  .rc-top .rc-brand{display:none}
  .rc-content{padding:24px 28px 48px;gap:20px}
}
.rc-nav{display:flex;flex-direction:column;gap:2px}
.rc-nav-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;border:0;background:none;font-weight:550;color:var(--ink-2);text-align:left}
.rc-nav-item:hover{background:var(--surface-2)}
.rc-nav-item[aria-current="page"]{background:var(--accent-soft);color:var(--accent)}
.rc-nav-item .rc-badge,.rc-nav-item .rc-dirty{margin-left:auto}
.rc-rail-foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding:12px 10px 4px;border-top:1px solid var(--rule);font-size:12px;color:var(--muted)}

.rc-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;font-size:12px;font-weight:650;white-space:nowrap}
.rc-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.rc-pill.ok{color:var(--gain);background:var(--gain-soft)}
.rc-pill.ok::before{animation:rc-pulse 2.4s ease-in-out infinite}
.rc-pill.warn{color:var(--warn);background:var(--warn-soft)}
.rc-pill.demo{color:var(--demo);background:var(--demo-soft)}
.rc-pill.muted{color:var(--muted);background:var(--surface-3)}
@keyframes rc-pulse{50%{opacity:.3}}
@keyframes rc-spin{to{transform:rotate(360deg)}}
.rc-spin{animation:rc-spin 1s linear infinite}

.rc-card{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:16px;min-width:0}
.rc-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px 12px;flex-wrap:wrap;margin-bottom:14px}
.rc-card-title{font-size:15px;font-weight:650;letter-spacing:-.005em}
.rc-card-sub{font-size:12px;color:var(--muted);margin-top:2px}
.rc-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.rc-h2{font-size:15px;font-weight:650}
.rc-footnote{font-size:12px;color:var(--muted)}

.rc-kpis{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rc-kpi{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px;min-width:0;container-type:inline-size}
.rc-kpi-hero{grid-column:1/-1}
.rc-kpi-label{font-size:12px;color:var(--muted);font-weight:600}
.rc-kpi-value{font-size:19px;font-size:clamp(15px,9cqi,20px);font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere;line-height:1.2}
.rc-kpi-hero .rc-kpi-value{font-size:clamp(28px,6vw,44px);font-size:clamp(24px,10.5cqi,46px);letter-spacing:-.025em;line-height:1.08}
.rc-kpi-sub{font-size:12px;color:var(--ink-2);display:flex;gap:4px 8px;flex-wrap:wrap;align-items:center}
@media (min-width:720px){.rc-kpis{grid-template-columns:repeat(3,1fr)}}
@media (min-width:1180px){.rc-kpis{grid-template-columns:1.5fr 1fr 1fr 1fr}.rc-kpi-hero{grid-column:auto}}

.rc-grid-2{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
@media (min-width:1100px){.rc-grid-2{grid-template-columns:minmax(0,1.75fr) minmax(0,1fr);gap:20px}}

.rc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--rule-2);
  background:var(--surface);color:var(--ink);font-weight:600;font-size:13px;white-space:nowrap;text-decoration:none}
.rc-btn:hover{background:var(--surface-2)}
.rc-btn:disabled{opacity:.5;cursor:not-allowed}
.rc-btn.primary{background:var(--btn);border-color:var(--btn);color:var(--btn-ink)}
.rc-btn.primary:hover{background:var(--btn-hover)}
.rc-btn.ghost{background:transparent;border-color:transparent;color:var(--accent)}
.rc-btn.ghost:hover{background:var(--accent-soft)}
.rc-btn.danger{color:var(--loss)}
.rc-btn.danger.solid{background:var(--loss);border-color:var(--loss);color:#fff}
.rc-btn.sm{height:30px;padding:0 10px;font-size:12.5px}
.rc-icon-btn{width:32px;height:32px;display:inline-grid;place-items:center;border-radius:8px;border:0;background:transparent;color:var(--muted);flex:none}
.rc-icon-btn:hover{background:var(--surface-3);color:var(--ink)}
.rc-icon-btn:disabled{opacity:.45;cursor:not-allowed}
.rc-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rc-link{border:0;background:none;padding:0;color:var(--accent);font-weight:600;text-decoration:underline;text-underline-offset:2px}

.rc-seg{display:inline-flex;padding:3px;border-radius:9px;background:var(--surface-3);gap:2px;flex-wrap:wrap}
.rc-seg button{border:0;background:transparent;height:28px;padding:0 11px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--ink-2);white-space:nowrap}
.rc-seg button[aria-pressed="true"]{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.14)}

.rc-delta{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.rc-delta.up{color:var(--gain)}.rc-delta.down{color:var(--loss)}.rc-delta.flat{color:var(--muted)}
.rc-arrow{font-size:.72em;margin-right:3px;position:relative;top:-.08em}
.rc-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:6px;font-size:12px;font-weight:650;white-space:nowrap}
.rc-chip.up{background:var(--gain-soft);color:var(--gain)}.rc-chip.down{background:var(--loss-soft);color:var(--loss)}.rc-chip.flat{background:var(--surface-3);color:var(--muted)}
.rc-type{display:inline-block;padding:1px 8px;border-radius:5px;font-size:11.5px;font-weight:650}
.rc-type.achat{background:var(--accent-soft);color:var(--accent)}
.rc-type.vente{background:var(--warn-soft);color:var(--warn)}

.rc-asset{display:flex;align-items:center;gap:10px;min-width:0}
.rc-asset-text{min-width:0}
.rc-asset-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-asset-sym{font-size:12px;color:var(--muted);white-space:nowrap}
.rc-av{width:24px;height:24px;border-radius:50%;flex:none;object-fit:cover;background:var(--surface-3)}
.rc-av-txt{display:inline-grid;place-items:center;font-size:8.5px;font-weight:700;letter-spacing:-.02em;color:var(--ink-2);background:hsl(var(--h) 42% var(--av-l))}
.rc-swatch{width:10px;height:10px;border-radius:3px;flex:none;display:inline-block}

.rc-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.rc-table{width:100%;border-collapse:collapse;font-size:13px}
.rc-table th{font-size:11.5px;font-weight:600;color:var(--muted);text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);white-space:nowrap;background:var(--surface-2)}
.rc-table td{padding:10px;border-bottom:1px solid var(--rule);vertical-align:middle}
.rc-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rc-table tbody tr:last-child td{border-bottom:0}
.rc-table tbody tr:hover td{background:var(--surface-2)}
.rc-table tr.closed td{color:var(--muted)}
.rc-table .rc-cell-sub{font-size:11.5px;color:var(--muted);font-weight:400}
.rc-table-wrap{border:1px solid var(--rule);border-radius:10px;overflow:hidden}
.rc-show-sm{display:none!important}
@media (max-width:719px){
  .rc-table-wrap{border:0;border-radius:0;overflow:visible}
  .rc-stack thead{display:none}
  .rc-stack,.rc-stack tbody,.rc-stack tr,.rc-stack td{display:block;width:100%}
  .rc-stack tr{padding:10px 0;border-bottom:1px solid var(--rule)}
  .rc-stack tbody tr:last-child{border-bottom:0}
  .rc-stack tbody tr:hover td{background:none}
  .rc-stack td{border:0!important;padding:3px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:right}
  .rc-stack td::before{content:attr(data-label);color:var(--muted);font-size:12px;text-align:left;font-weight:500}
  .rc-stack td.rc-td-main{padding-bottom:6px;text-align:left}
  .rc-stack td.rc-td-main::before,.rc-stack td.rc-td-actions::before{display:none}
  .rc-stack td.rc-td-actions{justify-content:flex-end}
  .rc-stack td.rc-hide-sm{display:none}
  .rc-show-sm{display:inline-block!important}
  }

.rc-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.rc-search{position:relative;flex:1 1 220px;min-width:0}
.rc-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none}
.rc-search .rc-input{padding-left:34px}
.rc-mkt{border:1px solid var(--rule);border-radius:12px;background:var(--surface);overflow:hidden}
.rc-mkt-row{display:grid;grid-template-columns:30px minmax(0,1fr) auto 32px;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--rule);min-height:58px}
.rc-mkt-row:last-child{border-bottom:0}
.rc-mkt-row:not(.rc-mkt-head):hover{background:var(--surface-2)}
.rc-mkt-head{display:none;min-height:0;padding-top:8px;padding-bottom:8px;background:var(--surface-2);font-size:11.5px;color:var(--muted);font-weight:600}
.rc-mkt .c-rank,.rc-mkt .c-24h,.rc-mkt .c-7d,.rc-mkt .c-mcap,.rc-mkt .c-spark{display:none}
.rc-mkt .c-price,.rc-mkt .c-24h,.rc-mkt .c-7d,.rc-mkt .c-mcap{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rc-mkt .c-price{font-weight:600}
.rc-sort{border:0;background:none;padding:0;font:inherit;color:inherit;display:inline-flex;align-items:center;gap:2px;white-space:nowrap}
.rc-sort[aria-pressed="true"]{color:var(--ink)}
.rc-star{width:28px;height:28px;display:grid;place-items:center;border:0;background:none;border-radius:7px;color:var(--rule-2)}
.rc-star:hover{background:var(--surface-3);color:var(--muted)}
.rc-star.on{color:#E0A100}
.rc-only-sm{display:block}
.rc-inline-sm{display:inline}
.rc-only-sm .rc-delta{font-size:12px;font-weight:600}
.rc-sort-select{display:block}
@media (min-width:640px){
  .rc-mkt-row{grid-template-columns:30px 34px minmax(140px,1.5fr) minmax(92px,1fr) 78px 78px 104px 32px}
  .rc-mkt-head{display:grid}
  .rc-mkt .c-rank,.rc-mkt .c-24h,.rc-mkt .c-7d,.rc-mkt .c-spark{display:block}
  .rc-only-sm,.rc-inline-sm,.rc-sort-select{display:none}
}
@media (min-width:1180px){
  .rc-mkt-row{grid-template-columns:30px 34px minmax(170px,1.6fr) minmax(100px,1fr) 92px 92px minmax(96px,.9fr) 104px 32px}
  .rc-mkt .c-mcap{display:block}
}
.rc-spark-empty{color:var(--muted)}

.rc-form{display:flex;flex-direction:column;gap:14px}
.rc-field{display:flex;flex-direction:column;gap:5px;min-width:0;border:0;padding:0;margin:0}
.rc-label{font-size:12.5px;font-weight:600;color:var(--ink-2)}
.rc-input{height:38px;padding:0 11px;border-radius:8px;border:1px solid var(--rule-2);background:var(--surface);color:var(--ink);width:100%;min-width:0}
.rc-input:focus{outline:2px solid var(--focus);outline-offset:-1px}
.rc-input[aria-invalid="true"]{border-color:var(--loss);box-shadow:inset 0 0 0 1px var(--loss)}
select.rc-input{padding-right:28px}
textarea.rc-input{height:auto;min-height:150px;padding:10px 11px;font-family:var(--mono);font-size:12px;line-height:1.5;resize:vertical;white-space:pre}
.rc-help{font-size:12px;color:var(--muted)}
.rc-error{font-size:12px;color:var(--loss);font-weight:550}
.rc-row2{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}
@media (min-width:520px){.rc-row2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.rc-summary{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:13px}
.rc-quick{display:flex;gap:6px;flex-wrap:wrap}

.rc-combo{position:relative}
.rc-listbox{position:absolute;z-index:5;top:calc(100% + 4px);left:0;right:0;background:var(--surface);border:1px solid var(--rule-2);border-radius:10px;
  box-shadow:var(--shadow);max-height:264px;overflow:auto;padding:4px;margin:0;list-style:none}
.rc-option{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:7px;cursor:pointer}
.rc-option[aria-selected="true"]{background:var(--accent-soft)}
.rc-option .rc-asset-sym{margin-left:auto}
.rc-list-note{padding:8px;font-size:12px;color:var(--muted)}
.rc-selected-coin{display:flex;align-items:center;gap:8px;min-height:38px;padding:4px 4px 4px 10px;border:1px solid var(--rule-2);border-radius:8px}
.rc-selected-coin .rc-asset-name{flex:0 1 auto}
.rc-selected-coin .rc-btn{margin-left:auto}

.rc-modal-back{position:fixed;inset:0;z-index:50;background:rgba(8,12,18,.5);display:flex;align-items:flex-end;justify-content:center}
.rc-modal{background:var(--surface);color:var(--ink);width:100%;max-height:92vh;overflow:auto;border-radius:16px 16px 0 0;
  padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));box-shadow:var(--shadow)}
@media (min-width:640px){.rc-modal-back{align-items:center;padding:24px}.rc-modal{max-width:560px;border-radius:14px;padding:22px 24px}.rc-modal.wide{max-width:720px}}
.rc-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.rc-modal-title{font-size:17px;font-weight:650}
.rc-modal-foot{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:4px}

.rc-toasts{position:fixed;z-index:60;left:12px;right:12px;bottom:calc(74px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:8px;pointer-events:none}
@media (min-width:960px){.rc-toasts{left:auto;right:20px;bottom:20px;width:370px}}
.rc-toast{pointer-events:auto;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 10px;align-items:start;background:var(--surface);
  border:1px solid var(--rule-2);border-radius:12px;padding:11px 8px 11px 12px;box-shadow:var(--shadow)}
.rc-toast-icon{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;grid-row:span 2}
.rc-toast.success .rc-toast-icon{background:var(--gain-soft);color:var(--gain)}
.rc-toast.info .rc-toast-icon{background:var(--accent-soft);color:var(--accent)}
.rc-toast.warning .rc-toast-icon{background:var(--warn-soft);color:var(--warn)}
.rc-toast.error .rc-toast-icon{background:var(--loss-soft);color:var(--loss)}
.rc-toast.alert{border-color:var(--warn-rule)}
.rc-toast.alert .rc-toast-icon{background:var(--warn);color:var(--surface)}
.rc-toast-title{font-weight:650;font-size:13.5px}
.rc-toast-body{font-size:12.5px;color:var(--ink-2);grid-column:2}
.rc-toast-actions{grid-column:2;display:flex;gap:6px;margin-top:6px}
.rc-toast .rc-icon-btn{grid-row:1;grid-column:3;width:26px;height:26px}

.rc-banner{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:1px solid var(--rule);background:var(--surface);font-size:13px}
.rc-banner-body{flex:1;min-width:0}
.rc-banner-title{font-weight:650}
.rc-banner.warn{background:var(--warn-soft);border-color:var(--warn-rule)}
.rc-banner.warn>svg{color:var(--warn)}
.rc-banner.demo{background:var(--demo-soft);border-color:var(--demo-rule)}
.rc-banner.demo>svg{color:var(--demo)}
.rc-banner.info>svg{color:var(--accent)}
.rc-banner .rc-btn{flex:none}

.rc-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:26px 20px;border:1px dashed var(--rule-2);border-radius:12px;background:var(--surface)}
.rc-empty h3{font-size:16px;font-weight:650}
.rc-empty p{color:var(--ink-2);max-width:62ch}
.rc-inline-empty{padding:18px 12px;color:var(--ink-2);display:flex;flex-direction:column;gap:8px;align-items:flex-start}

.rc-skel{display:block;border-radius:6px;background:linear-gradient(90deg,var(--surface-3) 0%,var(--surface-2) 50%,var(--surface-3) 100%);background-size:200% 100%;animation:rc-shimmer 1.4s linear infinite}
@keyframes rc-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}

.rc-chart{position:relative;width:100%;min-width:0}
.rc-chart-state{height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;color:var(--ink-2);padding:0 16px;border-radius:10px;background:var(--surface-2)}
.rc-legend-inline{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--ink-2);align-items:center}
.rc-key{display:inline-block;width:14px;height:0;border-top:2px solid var(--s1);vertical-align:middle;margin-right:6px}
.rc-key.dash{border-top:2px dashed var(--ink-2)}
.rc-tip{background:var(--surface);border:1px solid var(--rule-2);border-radius:10px;padding:9px 11px;box-shadow:var(--shadow);font-size:12.5px;min-width:190px;color:var(--ink)}
.rc-tip-date{font-weight:650;margin-bottom:5px}
.rc-tip-row{display:flex;align-items:center;gap:6px;justify-content:space-between}
.rc-tip-row span:first-child{display:flex;align-items:center;color:var(--ink-2)}
.rc-tip-row b{font-variant-numeric:tabular-nums;font-weight:650}

.rc-alloc{display:flex;flex-direction:column;gap:14px}
.rc-donut{position:relative;height:200px}
.rc-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.rc-donut-center span{font-size:11.5px;color:var(--muted);font-weight:600}
.rc-donut-center strong{font-size:15px;font-weight:650;letter-spacing:-.01em}
.rc-legend{display:flex;flex-direction:column;gap:2px}
.rc-legend li{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:5px 2px;font-size:13px;border-bottom:1px solid var(--rule)}
.rc-legend li:last-child{border-bottom:0}
.rc-legend-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-legend-pct{font-weight:650;font-variant-numeric:tabular-nums}
.rc-legend-val{color:var(--muted);font-variant-numeric:tabular-nums;min-width:92px;text-align:right}

.rc-settings{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
@media (min-width:900px){.rc-settings{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.rc-setting{display:flex;flex-direction:column;gap:10px}
.rc-dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 16px;font-size:13px}
.rc-dl dt{color:var(--muted)}
.rc-dl dd{margin:0;font-variant-numeric:tabular-nums}
.rc-report{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;background:var(--surface-2);font-size:13px}
.rc-report ul{display:flex;flex-direction:column;gap:3px;max-height:160px;overflow:auto;font-size:12.5px;color:var(--ink-2)}
.rc-file{position:relative;overflow:hidden}
.rc-file input{position:absolute;inset:0;opacity:0;cursor:pointer}
.rc-file:focus-within{outline:2px solid var(--focus);outline-offset:2px}
@media (max-width:479px){.rc-hide-xs{display:none}}
.rc-code{font-family:var(--mono);font-size:12px;background:var(--surface-2);border:1px solid var(--rule);border-radius:8px;padding:8px 10px;overflow-x:auto;white-space:pre}

@media (prefers-reduced-motion:reduce){.rc *,.rc *::before{animation:none!important;transition:none!important}}
`;

/* ─────────────────────────── Icônes ─────────────────────────── */

const ICONS = {
  wallet: [
    "M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3v3a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5",
  ],
  market: ["M3 3v18h18", "m19 9-5 5-4-4-3 3"],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  sliders: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6"],
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  star: ["M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.53L12 17.5l-5.87 3.07 1.12-6.53L2.5 9.41l6.56-.95L12 2.5z"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m17 8-5-5-5 5", "M12 3v12"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
  copy: ["M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z", "M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.3-4.3"],
  alert: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z", "M12 9v4", "M12 17h.01"],
  check: ["M20 6 9 17l-5-5"],
  info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"],
  up: ["m18 15-6-6-6 6"],
  down: ["m6 9 6 6 6-6"],
  ledger: ["M5 3h14v18H5z", "M5 8h14", "M5 13h14", "M10 3v18"],
};

function Icon({ name, size = 18, filled = false, className }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {(ICONS[name] || []).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/* ─────────────────────────── Petits composants ─────────────────────────── */

function CoinAvatar({ coin, size = 24 }) {
  const [failed, setFailed] = useState(false);
  if (coin && coin.image && !failed) {
    return (
      <img
        className="rc-av"
        src={coin.image}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  const sym = ((coin && coin.symbol) || "?").slice(0, 4);
  return (
    <span
      className="rc-av rc-av-txt"
      style={{ width: size, height: size, "--h": hashStr((coin && coin.id) || sym) % 360 }}
      aria-hidden="true"
    >
      {sym}
    </span>
  );
}

function Delta({ value, chip = false }) {
  if (!isNum(value)) return <span className="rc-delta flat">—</span>;
  const dir = value > 0.004 ? "up" : value < -0.004 ? "down" : "flat";
  return (
    <span className={chip ? `rc-chip ${dir}` : `rc-delta ${dir}`}>
      {dir !== "flat" && (
        <span className="rc-arrow" aria-hidden="true">
          {dir === "up" ? "▲" : "▼"}
        </span>
      )}
      {fmtPct(value)}
    </span>
  );
}

function MoneyDelta({ value, currency }) {
  if (!isNum(value)) return <span className="rc-delta flat">—</span>;
  const dir = value > 0.004 ? "up" : value < -0.004 ? "down" : "flat";
  return <span className={`rc-delta ${dir}`}>{fmtMoney(value, currency, true)}</span>;
}

function Segmented({ options, value, onChange, label }) {
  return (
    <div className="rc-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

function Countdown({ target }) {
  const now = useNow();
  if (!target) return null;
  const s = Math.max(0, Math.ceil((target - now) / 1000));
  return <span className="rc-num">{s >= 90 ? `${Math.floor(s / 60)} min ${pad2(s % 60)} s` : `${s} s`}</span>;
}

const Sparkline = memo(function Sparkline({ data, positive }) {
  if (!data || data.length < 2) return <span className="rc-spark-empty">—</span>;
  return (
    <LineChart width={100} height={32} data={data} margin={{ top: 3, right: 2, bottom: 3, left: 2 }}>
      <YAxis hide domain={["dataMin", "dataMax"]} />
      <Line
        type="monotone"
        dataKey="v"
        stroke={positive ? "var(--gain)" : "var(--loss)"}
        strokeWidth={1.5}
        dot={false}
        isAnimationActive={false}
      />
    </LineChart>
  );
});

function Banner({ tone, icon = "alert", title, children, action }) {
  return (
    <div className={`rc-banner ${tone}`}>
      <Icon name={icon} size={18} />
      <div className="rc-banner-body">
        <div className="rc-banner-title">{title}</div>
        <div>{children}</div>
      </div>
      {action}
    </div>
  );
}

function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const el = ref.current;
    const first = el && el.querySelector("input:not([type=hidden]):not([type=file]), select, textarea, [data-autofocus]");
    if (first) first.focus();
    else if (el) el.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll("button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])")].filter(
          (n) => !n.disabled && n.offsetParent !== null,
        );
        if (!items.length) return;
        const firstItem = items[0];
        const lastItem = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") previous.focus();
    };
  }, []);
  return (
    <div
      className="rc-modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div className={`rc-modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="rc-modal-title" ref={ref} tabIndex={-1}>
        <div className="rc-modal-head">
          <h2 className="rc-modal-title" id="rc-modal-title">
            {title}
          </h2>
          <button type="button" className="rc-icon-btn" onClick={() => closeRef.current()} aria-label="Fermer">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const TOAST_ICONS = { success: "check", info: "info", warning: "alert", error: "alert", alert: "bell" };

function Toasts({ toasts, onDismiss }) {
  return (
    <div className="rc-toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`rc-toast ${t.kind}`} role={t.kind === "alert" || t.kind === "error" ? "alert" : "status"}>
          <span className="rc-toast-icon">
            <Icon name={TOAST_ICONS[t.kind] || "info"} size={15} />
          </span>
          <div className="rc-toast-title">{t.title}</div>
          <button type="button" className="rc-icon-btn" onClick={() => onDismiss(t.id)} aria-label="Fermer la notification">
            <Icon name="x" size={15} />
          </button>
          {t.body && <div className="rc-toast-body">{t.body}</div>}
          {t.action && (
            <div className="rc-toast-actions">
              <button
                type="button"
                className="rc-btn sm"
                onClick={() => {
                  t.action.onClick();
                  onDismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    live: ["En direct", "ok"],
    stale: ["Cache", "warn"],
    demo: ["Démo", "demo"],
    loading: ["Connexion…", "muted"],
  };
  const [label, tone] = map[status] || map.loading;
  return <span className={`rc-pill ${tone}`}>{label}</span>;
}

/* ─────────────────────────── Sélecteur d'actif ─────────────────────────── */

function CoinPicker({ id, value, onChange, options, onRemoteSearch, invalid, describedBy }) {
  const [editing, setEditing] = useState(!value);
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState({ status: "idle", items: [], query: "" });
  const inputRef = useRef(null);
  const q = norm(query.trim());

  const items = useMemo(() => {
    const seen = new Set();
    const out = [];
    const match = (c) => !q || norm(c.name).includes(q) || c.symbol.toLowerCase().startsWith(q) || c.id.startsWith(q);
    for (const c of options) {
      if (match(c) && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
    if (remote.query === q) {
      for (const c of remote.items) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    return out.slice(0, 40);
  }, [options, q, remote]);

  useEffect(() => setActive(0), [q]);

  const choose = (c) => {
    onChange(coinMeta(c));
    setEditing(false);
    setListOpen(false);
    setQuery("");
  };
  const searchRemote = async () => {
    if (q.length < 2) return;
    setRemote({ status: "loading", items: [], query: q });
    try {
      const res = await onRemoteSearch(query.trim());
      setRemote({ status: "done", items: res, query: q });
    } catch (err) {
      setRemote({ status: "error", items: [], query: q, error: err });
    }
  };

  if (value && !editing) {
    return (
      <div className="rc-selected-coin" id={id} aria-describedby={describedBy}>
        <CoinAvatar coin={value} size={22} />
        <span className="rc-asset-name">{value.name}</span>
        <span className="rc-asset-sym">{value.symbol}</span>
        <button
          type="button"
          className="rc-btn ghost sm"
          onClick={() => {
            setEditing(true);
            setListOpen(true);
            setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
          }}
        >
          Changer
        </button>
      </div>
    );
  }

  const listId = `${id}-list`;
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setListOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (listOpen && items[active]) choose(items[active]);
      else searchRemote();
    } else if (e.key === "Escape") {
      if (listOpen || value) {
        e.preventDefault();
        e.stopPropagation();
        setListOpen(false);
        if (value) setEditing(false);
      }
    }
  };
  const canRemote = q.length >= 2 && !(remote.query === q && remote.status !== "error");

  return (
    <div className="rc-combo">
      <input
        ref={inputRef}
        id={id}
        className="rc-input"
        type="text"
        role="combobox"
        aria-expanded={listOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && items[active] ? `${id}-opt-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder="Rechercher : bitcoin, ETH…"
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setListOpen(true);
        }}
        onFocus={() => setListOpen(true)}
        onBlur={() => setListOpen(false)}
        onKeyDown={onKeyDown}
      />
      {listOpen && (
        <ul className="rc-listbox" id={listId} role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {items.map((c, i) => (
            <li
              key={c.id}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className="rc-option"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <CoinAvatar coin={c} size={20} />
              <span className="rc-asset-name">{c.name}</span>
              <span className="rc-asset-sym">
                {c.symbol}
                {c.rank ? ` · #${c.rank}` : ""}
              </span>
            </li>
          ))}
          {!items.length && remote.status !== "loading" && (
            <li className="rc-list-note" role="presentation">
              {q ? "Aucun actif connu ne correspond." : "Aucun actif chargé pour l'instant."}
            </li>
          )}
          {remote.status === "loading" && remote.query === q && (
            <li className="rc-list-note" role="presentation">
              Recherche sur CoinGecko…
            </li>
          )}
          {remote.status === "error" && remote.query === q && (
            <li className="rc-list-note" role="presentation">
              Recherche indisponible : {describeError(remote.error)}.
            </li>
          )}
          {remote.status === "done" && remote.query === q && !remote.items.length && (
            <li className="rc-list-note" role="presentation">
              CoinGecko ne connaît aucun actif « {query.trim()} ».
            </li>
          )}
          {canRemote && (
            <li role="presentation" className="rc-list-note">
              <button type="button" className="rc-link" onClick={searchRemote}>
                Rechercher « {query.trim()} » sur CoinGecko
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ─────────────────────────── Formulaire de transaction ─────────────────────────── */

function TransactionForm({ initial, preset, currency, options, priceMap, transactions, onRemoteSearch, onSubmit, onCancel }) {
  const editing = !!initial;
  const txCurrency = (initial && initial.currency) || currency;
  const [type, setType] = useState((initial && initial.type) || (preset && preset.type) || "achat");
  const [coin, setCoin] = useState(
    initial ? { id: initial.coinId, symbol: initial.symbol, name: initial.name, image: initial.image } : (preset && preset.coin) || null,
  );
  const [date, setDate] = useState((initial && initial.date) || todayISO());
  const [qty, setQty] = useState(initial ? fmtPlain(initial.quantity) : "");
  const [price, setPrice] = useState(initial ? fmtPlain(initial.price) : "");
  const [fees, setFees] = useState(initial && initial.fees ? fmtPlain(initial.fees) : "");
  const [note, setNote] = useState((initial && initial.note) || "");
  const [errors, setErrors] = useState({});
  const formRef = useRef(null);

  const live = coin ? priceMap.get(coin.id) : null;
  const livePrice = live && isNum(live.price) && txCurrency === currency ? live.price : null;
  const others = useMemo(() => transactions.filter((t) => !initial || t.id !== initial.id), [transactions, initial]);
  const dateISO = parseDateInput(date);
  const available = coin && dateISO ? balanceAt(others, coin.id, dateISO) : null;

  const q = parseDecimal(qty);
  const p = parseDecimal(price);
  const f = fees.trim() ? parseDecimal(fees) : 0;
  const total = isNum(q) && isNum(p) && isNum(f) ? (type === "achat" ? q * p + f : q * p - f) : null;

  const submit = (e) => {
    e.preventDefault();
    const fields = { coin, type, date: dateISO, quantity: q, price: p, fees: f, currency: txCurrency };
    const errs = validateTxFields(fields);
    let tx = null;
    if (!Object.keys(errs).length) {
      tx = {
        id: initial ? initial.id : uid(),
        coinId: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        image: coin.image || (live && live.image) || null,
        type,
        date: dateISO,
        quantity: q,
        price: p,
        fees: f,
        currency: txCurrency,
        note: note.trim().slice(0, 140),
        createdAt: initial ? initial.createdAt : Date.now(),
      };
      const check = validateLedger([...others, tx]);
      if (!check.ok) {
        if (check.tx.id === tx.id) errs.quantity = ledgerMessage(check);
        else errs.form = `Modification impossible : ${ledgerMessage(check)}`;
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      const firstKey = ["coin", "date", "quantity", "price", "fees"].find((k) => errs[k]);
      const el = firstKey && formRef.current && formRef.current.querySelector(`#rc-tx-${firstKey}`);
      if (el && el.focus) el.focus();
      return;
    }
    onSubmit(tx, editing);
  };

  const err = (k) =>
    errors[k] ? (
      <p className="rc-error" id={`rc-tx-${k}-err`}>
        {errors[k]}
      </p>
    ) : null;

  return (
    <form className="rc-form" onSubmit={submit} noValidate ref={formRef}>
      <div className="rc-field">
        <span className="rc-label" id="rc-tx-type-label">
          Opération
        </span>
        <Segmented
          label="Type d'opération"
          value={type}
          onChange={setType}
          options={[
            { value: "achat", label: "Achat" },
            { value: "vente", label: "Vente" },
          ]}
        />
      </div>
      <div className="rc-field">
        <label className="rc-label" htmlFor="rc-tx-coin">
          Actif
        </label>
        <CoinPicker
          id="rc-tx-coin"
          value={coin}
          onChange={(c) => {
            setCoin(c);
            setErrors((x) => ({ ...x, coin: undefined }));
          }}
          options={options}
          onRemoteSearch={onRemoteSearch}
          invalid={!!errors.coin}
          describedBy={errors.coin ? "rc-tx-coin-err" : undefined}
        />
        {err("coin")}
      </div>
      <div className="rc-row2">
        <div className="rc-field">
          <label className="rc-label" htmlFor="rc-tx-date">
            Date
          </label>
          <input
            id="rc-tx-date"
            className="rc-input"
            type="date"
            min={MIN_DATE}
            max={todayISO()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={!!errors.date || undefined}
            aria-describedby={errors.date ? "rc-tx-date-err" : undefined}
            required
          />
          {err("date")}
        </div>
        <div className="rc-field">
          <label className="rc-label" htmlFor="rc-tx-quantity">
            Quantité {coin ? `(${coin.symbol})` : ""}
          </label>
          <input
            id="rc-tx-quantity"
            className="rc-input rc-num"
            inputMode="decimal"
            placeholder="0,00"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-invalid={!!errors.quantity || undefined}
            aria-describedby={errors.quantity ? "rc-tx-quantity-err" : "rc-tx-quantity-help"}
            autoComplete="off"
          />
          {errors.quantity ? (
            err("quantity")
          ) : type === "vente" && coin && available != null ? (
            <p className="rc-help" id="rc-tx-quantity-help">
              Solde détenu au {fmtDate(dateISO)} : {fmtQty(available)} {coin.symbol}
              {available > 0 && (
                <>
                  {" · "}
                  <button type="button" className="rc-link" onClick={() => setQty(fmtPlain(available))}>
                    tout vendre
                  </button>
                </>
              )}
            </p>
          ) : null}
        </div>
      </div>
      <div className="rc-row2">
        <div className="rc-field">
          <label className="rc-label" htmlFor="rc-tx-price">
            Prix unitaire ({txCurrency})
          </label>
          <input
            id="rc-tx-price"
            className="rc-input rc-num"
            inputMode="decimal"
            placeholder="0,00"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-invalid={!!errors.price || undefined}
            aria-describedby={errors.price ? "rc-tx-price-err" : undefined}
            autoComplete="off"
          />
          {errors.price ? (
            err("price")
          ) : livePrice != null ? (
            <p className="rc-help">
              Cours actuel {fmtPrice(livePrice, currency)} ·{" "}
              <button type="button" className="rc-link" onClick={() => setPrice(fmtPlain(livePrice, livePrice < 1 ? 8 : 2))}>
                utiliser
              </button>
            </p>
          ) : null}
        </div>
        <div className="rc-field">
          <label className="rc-label" htmlFor="rc-tx-fees">
            Frais ({txCurrency}, facultatif)
          </label>
          <input
            id="rc-tx-fees"
            className="rc-input rc-num"
            inputMode="decimal"
            placeholder="0,00"
            value={fees}
            onChange={(e) => setFees(e.target.value)}
            aria-invalid={!!errors.fees || undefined}
            aria-describedby={errors.fees ? "rc-tx-fees-err" : undefined}
            autoComplete="off"
          />
          {err("fees")}
        </div>
      </div>
      <div className="rc-field">
        <label className="rc-label" htmlFor="rc-tx-note">
          Note (facultatif)
        </label>
        <input
          id="rc-tx-note"
          className="rc-input"
          maxLength={140}
          placeholder="Plateforme, référence…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="rc-summary">
        <span className="rc-muted">{type === "achat" ? "Montant décaissé (frais inclus)" : "Montant encaissé (net de frais)"}</span>
        <strong className="rc-num">{total != null ? fmtMoney(total, txCurrency) : "—"}</strong>
      </div>
      {errors.form && (
        <p className="rc-error" role="alert">
          {errors.form}
        </p>
      )}
      <div className="rc-modal-foot">
        <button type="button" className="rc-btn" onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className="rc-btn primary">
          {editing ? "Enregistrer les modifications" : type === "achat" ? "Ajouter l'achat" : "Ajouter la vente"}
        </button>
      </div>
    </form>
  );
}

/* ─────────────────────────── Formulaire d'alerte ─────────────────────────── */

function AlertForm({ initial, presetCoin, options, priceMap, currency, onRemoteSearch, onSubmit, onCancel }) {
  const alertCurrency = (initial && initial.currency) || currency;
  const [coin, setCoin] = useState(
    initial ? { id: initial.coinId, symbol: initial.symbol, name: initial.name, image: initial.image } : presetCoin || null,
  );
  const [direction, setDirection] = useState((initial && initial.direction) || "above");
  const [threshold, setThreshold] = useState(initial ? fmtPlain(initial.threshold) : "");
  const [errors, setErrors] = useState({});
  const live = coin ? priceMap.get(coin.id) : null;
  const price = live && isNum(live.price) && alertCurrency === currency ? live.price : null;
  const th = parseDecimal(threshold);
  const gap = isNum(th) && price ? (th / price - 1) * 100 : null;
  const alreadyMet = gap != null && (direction === "above" ? th <= price : th >= price);

  const preset = (pct) => {
    if (!price) return;
    const v = price * (1 + pct / 100);
    setThreshold(fmtPlain(v, v < 1 ? 8 : 2));
    setDirection(pct >= 0 ? "above" : "below");
  };
  const submit = (e) => {
    e.preventDefault();
    const errs = {};
    if (!coin) errs.coin = "Choisissez un actif.";
    if (!isNum(th) || th <= 0) errs.threshold = "Le seuil doit être un nombre strictement positif.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSubmit({
      id: initial ? initial.id : uid(),
      coinId: coin.id,
      symbol: coin.symbol,
      name: coin.name,
      image: coin.image || (live && live.image) || null,
      direction,
      threshold: th,
      currency: alertCurrency,
      createdAt: initial ? initial.createdAt : Date.now(),
      triggeredAt: null,
      triggeredPrice: null,
      triggeredCurrency: null,
      simulated: false,
      seen: true,
    });
  };

  return (
    <form className="rc-form" onSubmit={submit} noValidate>
      <div className="rc-field">
        <label className="rc-label" htmlFor="rc-al-coin">
          Actif
        </label>
        <CoinPicker
          id="rc-al-coin"
          value={coin}
          onChange={setCoin}
          options={options}
          onRemoteSearch={onRemoteSearch}
          invalid={!!errors.coin}
          describedBy={errors.coin ? "rc-al-coin-err" : undefined}
        />
        {errors.coin && (
          <p className="rc-error" id="rc-al-coin-err">
            {errors.coin}
          </p>
        )}
      </div>
      <div className="rc-field">
        <span className="rc-label">Condition</span>
        <Segmented
          label="Condition de déclenchement"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "above", label: "Cours au-dessus de" },
            { value: "below", label: "Cours en dessous de" },
          ]}
        />
      </div>
      <div className="rc-field">
        <label className="rc-label" htmlFor="rc-al-threshold">
          Seuil ({alertCurrency})
        </label>
        <input
          id="rc-al-threshold"
          className="rc-input rc-num"
          inputMode="decimal"
          placeholder="0,00"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
          aria-invalid={!!errors.threshold || undefined}
          aria-describedby={errors.threshold ? "rc-al-threshold-err" : "rc-al-threshold-help"}
          autoComplete="off"
        />
        {errors.threshold ? (
          <p className="rc-error" id="rc-al-threshold-err">
            {errors.threshold}
          </p>
        ) : price ? (
          <p className="rc-help" id="rc-al-threshold-help">
            Cours actuel {fmtPrice(price, currency)}
            {gap != null && <> · seuil à {fmtPct(gap)} du cours</>}
          </p>
        ) : null}
        {price ? (
          <div className="rc-quick" aria-label="Seuils rapides">
            {[-10, -5, 5, 10].map((pct) => (
              <button key={pct} type="button" className="rc-btn sm" onClick={() => preset(pct)}>
                {pct > 0 ? `+${pct}` : `−${Math.abs(pct)}`} %
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {alreadyMet && (
        <Banner tone="warn" title="Condition déjà remplie">
          Le cours actuel est déjà {direction === "above" ? "au-dessus" : "en dessous"} de ce seuil : l'alerte se déclenchera dès son enregistrement.
        </Banner>
      )}
      <div className="rc-modal-foot">
        <button type="button" className="rc-btn" onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className="rc-btn primary">
          {initial ? "Enregistrer et réarmer" : "Créer l'alerte"}
        </button>
      </div>
    </form>
  );
}

/* ─────────────────────────── Import / export ─────────────────────────── */

function ExportPanel({ filename, content, mime, description, onDone, onClose }) {
  const [msg, setMsg] = useState(null);
  const taRef = useRef(null);
  const download = async () => {
    const r = await saveFile(filename, content, mime);
    if (r === "saved") {
      setMsg({ tone: "ok", text: "Fichier enregistré." });
      if (onDone) onDone();
    } else if (r === "started") {
      setMsg({ tone: "ok", text: "Téléchargement lancé. S'il ne démarre pas dans cet environnement, utilisez « Copier » puis collez dans un fichier." });
      if (onDone) onDone();
    } else if (r === "declined") {
      setMsg({ tone: "warn", text: "Enregistrement annulé." });
    } else {
      setMsg({ tone: "warn", text: "Téléchargement impossible ici : utilisez « Copier » puis collez dans un fichier." });
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setMsg({ tone: "ok", text: "Contenu copié dans le presse-papiers." });
      if (onDone) onDone();
    } catch (e) {
      if (taRef.current) {
        taRef.current.focus();
        taRef.current.select();
      }
      setMsg({ tone: "warn", text: "Copie automatique refusée : le texte est sélectionné, utilisez Ctrl+C (⌘+C sur Mac)." });
    }
  };
  return (
    <div className="rc-form">
      {description && <p className="rc-help">{description}</p>}
      <div className="rc-field">
        <label className="rc-label" htmlFor="rc-export-text">
          {filename}
        </label>
        <textarea id="rc-export-text" ref={taRef} className="rc-input" readOnly value={content} rows={8} />
      </div>
      {msg && (
        <p className={msg.tone === "ok" ? "rc-help" : "rc-error"} role="status">
          {msg.text}
        </p>
      )}
      <div className="rc-modal-foot">
        <button type="button" className="rc-btn" onClick={onClose}>
          Fermer
        </button>
        <button type="button" className="rc-btn" onClick={copy}>
          <Icon name="copy" size={16} /> Copier
        </button>
        <button type="button" className="rc-btn primary" onClick={download}>
          <Icon name="download" size={16} /> Télécharger
        </button>
      </div>
    </div>
  );
}

function ImportPanel({ format, analyze, onConfirm, onClose }) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [report, setReport] = useState(null);
  const isCSV = format === "csv";

  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5_000_000) {
      setReport({ canImport: false, summary: "Fichier trop volumineux (5 Mo maximum).", errors: [] });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || "");
      setText(content);
      setFileName(file.name);
      setReport(analyze(content));
    };
    reader.onerror = () => setReport({ canImport: false, summary: "Lecture du fichier impossible.", errors: [] });
    reader.readAsText(file, "utf-8");
  };

  return (
    <div className="rc-form">
      {isCSV ? (
        <div className="rc-field">
          <span className="rc-label">Format attendu (séparateur ; ou ,)</span>
          <div className="rc-code">{`${CSV_HEADERS.join(";")}\n${CSV_EXAMPLE}`}</div>
          <p className="rc-help">
            Dates JJ/MM/AAAA ou AAAA-MM-JJ, décimales à virgule ou à point, type « achat » ou « vente ». actif_id est l'identifiant CoinGecko
            (bitcoin, ethereum…) ; à défaut, le symbole est rapproché du top 100. Les lignes identiques à une transaction existante sont ignorées.
          </p>
        </div>
      ) : (
        <p className="rc-help">
          Restaure un fichier créé avec « Exporter la sauvegarde JSON ». L'import remplace les transactions, la watchlist, les alertes et les
          paramètres actuels.
        </p>
      )}
      <div className="rc-actions">
        <span className="rc-btn rc-file">
          <Icon name="upload" size={16} /> Choisir un fichier {isCSV ? ".csv" : ".json"}
          <input type="file" accept={isCSV ? ".csv,text/csv,text/plain" : ".json,application/json"} onChange={onFile} aria-label="Choisir un fichier" />
        </span>
        {fileName && <span className="rc-help">{fileName}</span>}
      </div>
      <div className="rc-field">
        <label className="rc-label" htmlFor="rc-import-text">
          ou collez le contenu
        </label>
        <textarea
          id="rc-import-text"
          className="rc-input"
          value={text}
          rows={6}
          onChange={(e) => {
            setText(e.target.value);
            setReport(null);
          }}
          placeholder={isCSV ? `${CSV_HEADERS.join(";")}\n…` : '{ "format": "registre-crypto", … }'}
        />
      </div>
      {report && (
        <div className="rc-report" role="status">
          <strong>{report.summary}</strong>
          {report.notes && report.notes.map((n) => <span key={n}>{n}</span>)}
          {report.errors && report.errors.length > 0 && (
            <ul>
              {report.errors.slice(0, 50).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {report.errors.length > 50 && <li>… et {report.errors.length - 50} autre(s).</li>}
            </ul>
          )}
        </div>
      )}
      <div className="rc-modal-foot">
        <button type="button" className="rc-btn" onClick={onClose}>
          Annuler
        </button>
        {!report || !report.canImport ? (
          <button type="button" className="rc-btn primary" disabled={!text.trim()} onClick={() => setReport(analyze(text))}>
            Analyser
          </button>
        ) : (
          <button type="button" className="rc-btn primary" onClick={() => onConfirm(report.payload)}>
            {report.confirmLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Graphiques du portefeuille ─────────────────────────── */

function ValueTooltip({ active, payload, label, currency, days }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  const diff = isNum(p.value) && isNum(p.invested) ? p.value - p.invested : null;
  return (
    <div className="rc-tip">
      <div className="rc-tip-date">{days <= 7 ? fmtDayTime(label) : fmtDay(label)}</div>
      <div className="rc-tip-row">
        <span>
          <i className="rc-key" />
          Valeur
        </span>
        <b>{fmtMoney(p.value, currency)}</b>
      </div>
      <div className="rc-tip-row">
        <span>
          <i className="rc-key dash" />
          Capital investi
        </span>
        <b>{fmtMoney(p.invested, currency)}</b>
      </div>
      {diff != null && (
        <div className="rc-tip-row">
          <span>Écart</span>
          <b className={diff >= 0 ? "rc-up" : "rc-down"}>{fmtMoney(diff, currency, true)}</b>
        </div>
      )}
    </div>
  );
}

function ValueChart({ data, currency, days }) {
  const tick = (t) => (days > 90 ? dtf({ month: "short", year: "2-digit" }).format(t) : dtf({ day: "2-digit", month: "2-digit" }).format(t));
  const first = data.find((d) => isNum(d.value));
  const last = [...data].reverse().find((d) => isNum(d.value));
  const label =
    first && last
      ? `Valeur du portefeuille sur ${days} jours : de ${fmtMoney(first.value, currency)} à ${fmtMoney(last.value, currency)}.`
      : "Valeur du portefeuille";
  return (
    <div className="rc-chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 22, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="rc-value-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--s1)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--s1)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--rule)" />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={tick}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--rule-2)" }}
            minTickGap={32}
          />
          <YAxis
            tickFormatter={(v) => fmtCompact(v, currency, 1)}
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={68}
            domain={["auto", "auto"]}
          />
          <Tooltip content={<ValueTooltip currency={currency} days={days} />} cursor={{ stroke: "var(--rule-2)", strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="value"
            name="Valeur"
            stroke="var(--s1)"
            strokeWidth={2}
            fill="url(#rc-value-fill)"
            dot={false}
            activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: "var(--s1)" }}
            isAnimationActive={false}
          />
          <Line
            type="stepAfter"
            dataKey="invested"
            name="Capital investi"
            stroke="var(--ink-2)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2, fill: "var(--ink-2)" }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function SliceTooltip({ active, payload, currency }) {
  if (!active || !payload || !payload.length) return null;
  const s = payload[0].payload;
  return (
    <div className="rc-tip">
      <div className="rc-tip-date">
        <span className="rc-swatch" style={{ background: s.color, marginRight: 6 }} />
        {s.name}
      </div>
      <div className="rc-tip-row">
        <span>{fmtPct(s.pct, false)}</span>
        <b>{fmtMoney(s.value, currency)}</b>
      </div>
    </div>
  );
}

function AllocationChart({ slices, total, currency }) {
  return (
    <div className="rc-alloc">
      <div className="rc-donut" role="img" aria-label={`Répartition : ${slices.map((s) => `${s.name} ${fmtPct(s.pct, false)}`).join(", ")}`}>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="66%"
              outerRadius="96%"
              startAngle={90}
              endAngle={-270}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.key} fill={s.color} />
              ))}
            </Pie>
            <Tooltip content={<SliceTooltip currency={currency} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="rc-donut-center">
          <span>Total</span>
          <strong className="rc-num">{fmtCompact(total, currency, 1)}</strong>
        </div>
      </div>
      <ul className="rc-legend">
        {slices.map((s) => (
          <li key={s.key}>
            <span className="rc-swatch" style={{ background: s.color }} />
            <span className="rc-legend-name" title={s.name}>
              {s.name} {s.symbol && <span className="rc-muted">{s.symbol}</span>}
            </span>
            <span className="rc-legend-pct">{fmtPct(s.pct, false)}</span>
            <span className="rc-legend-val">{fmtMoney(s.value, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────────── Vue Portefeuille ─────────────────────────── */

function PositionsTable({ rows, currency, colorOf, totalValue }) {
  const [showClosed, setShowClosed] = useState(false);
  const open = rows.filter((r) => r.qty > 0).sort((a, b) => (b.value || 0) - (a.value || 0) || a.name.localeCompare(b.name));
  const closed = rows.filter((r) => r.qty <= 0);
  const list = showClosed ? [...open, ...closed] : open;
  return (
    <section className="rc-card" aria-labelledby="rc-pos-title">
      <div className="rc-card-head">
        <div>
          <h2 className="rc-card-title" id="rc-pos-title">
            Positions
          </h2>
          <p className="rc-card-sub">PRU : prix de revient unitaire moyen pondéré, frais d'achat inclus.</p>
        </div>
        {closed.length > 0 && (
          <button type="button" className="rc-btn sm" onClick={() => setShowClosed((v) => !v)} aria-pressed={showClosed}>
            {showClosed ? "Masquer" : "Afficher"} les positions soldées ({closed.length})
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="rc-inline-empty">Toutes les positions sont soldées. Affichez-les pour consulter les plus-values réalisées.</div>
      ) : (
        <div className="rc-table-wrap rc-scroll">
          <table className="rc-table rc-stack">
            <thead>
              <tr>
                <th scope="col">Actif</th>
                <th scope="col" className="num">
                  Quantité
                </th>
                <th scope="col" className="num">
                  PRU
                </th>
                <th scope="col" className="num">
                  Cours
                </th>
                <th scope="col" className="num">
                  Valeur
                </th>
                <th scope="col" className="num">
                  +/- value latente
                </th>
                <th scope="col" className="num">
                  +/- value réalisée
                </th>
                <th scope="col" className="num">
                  Poids
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.coinId} className={r.qty <= 0 ? "closed" : ""}>
                  <td className="rc-td-main">
                    <div className="rc-asset">
                      {colorOf(r.coinId) && <span className="rc-swatch" style={{ background: colorOf(r.coinId) }} aria-hidden="true" />}
                      <CoinAvatar coin={{ id: r.coinId, symbol: r.symbol, image: r.image }} />
                      <div className="rc-asset-text">
                        <div className="rc-asset-name">{r.name}</div>
                        <div className="rc-asset-sym">
                          {r.symbol}
                          {r.qty <= 0 ? " · soldée" : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num" data-label="Quantité">
                    {fmtQty(r.qty)}
                  </td>
                  <td className="num" data-label="PRU">
                    {r.pru != null ? fmtPrice(r.pru, currency) : "—"}
                  </td>
                  <td className="num" data-label="Cours">
                    {r.price != null ? fmtPrice(r.price, currency) : r.qty > 0 ? <span className="rc-muted">indisponible</span> : "—"}
                  </td>
                  <td className="num" data-label="Valeur">
                    <strong>{r.qty > 0 ? fmtMoney(r.value, currency) : "—"}</strong>
                  </td>
                  <td className="num" data-label="+/- value latente">
                    {r.qty > 0 ? (
                      <div>
                        <MoneyDelta value={r.latent} currency={currency} />
                        <div className="rc-cell-sub">
                          <Delta value={r.latentPct} />
                        </div>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num" data-label="+/- value réalisée">
                    {r.sellCount > 0 ? (
                      <div>
                        <MoneyDelta value={r.realized} currency={currency} />
                        <div className="rc-cell-sub">
                          <Delta value={r.realizedPct} />
                        </div>
                      </div>
                    ) : (
                      <span className="rc-muted">aucune vente</span>
                    )}
                  </td>
                  <td className="num" data-label="Poids">
                    {r.qty > 0 && isNum(r.value) && totalValue > 0 ? fmtPct((r.value / totalValue) * 100, false) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TransactionsTable({ transactions, onEdit, onDelete }) {
  const [asset, setAsset] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(50);
  const assets = useMemo(() => {
    const m = new Map();
    transactions.forEach((t) => m.set(t.coinId, t.name));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [transactions]);
  const list = useMemo(
    () =>
      sortTx(transactions.filter((t) => (!asset || t.coinId === asset) && (!kind || t.type === kind))).reverse(),
    [transactions, asset, kind],
  );
  return (
    <section className="rc-card" aria-labelledby="rc-tx-title">
      <div className="rc-card-head">
        <div>
          <h2 className="rc-card-title" id="rc-tx-title">
            Registre des transactions
          </h2>
          <p className="rc-card-sub">Montants dans la devise de saisie · {transactions.length} opération(s)</p>
        </div>
        <div className="rc-toolbar">
          <label className="rc-sr" htmlFor="rc-f-asset">
            Filtrer par actif
          </label>
          <select id="rc-f-asset" className="rc-input" style={{ width: "auto" }} value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="">Tous les actifs</option>
            {assets.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <label className="rc-sr" htmlFor="rc-f-kind">
            Filtrer par opération
          </label>
          <select id="rc-f-kind" className="rc-input" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Achats et ventes</option>
            <option value="achat">Achats</option>
            <option value="vente">Ventes</option>
          </select>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="rc-inline-empty">Aucune transaction ne correspond à ces filtres.</div>
      ) : (
        <div className="rc-table-wrap rc-scroll">
          <table className="rc-table rc-stack">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Opération</th>
                <th scope="col">Actif</th>
                <th scope="col" className="num">
                  Quantité
                </th>
                <th scope="col" className="num">
                  Prix unitaire
                </th>
                <th scope="col" className="num">
                  Frais
                </th>
                <th scope="col" className="num">
                  Montant
                </th>
                <th scope="col">
                  <span className="rc-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, limit).map((t) => {
                const amount = t.type === "achat" ? t.quantity * t.price + (t.fees || 0) : t.quantity * t.price - (t.fees || 0);
                return (
                  <tr key={t.id}>
                    <td className="rc-td-main rc-mono" data-label="Date">
                      {fmtDate(t.date)} <span className={`rc-type rc-show-sm ${t.type}`}>{t.type === "achat" ? "Achat" : "Vente"}</span>
                    </td>
                    <td data-label="Opération" className="rc-hide-sm">
                      <span className={`rc-type ${t.type}`}>{t.type === "achat" ? "Achat" : "Vente"}</span>
                    </td>
                    <td data-label="Actif">
                      <div>
                        <div>
                          <strong>{t.symbol}</strong> <span className="rc-muted">{t.name}</span>
                        </div>
                        {t.note && <div className="rc-cell-sub">{t.note}</div>}
                      </div>
                    </td>
                    <td className="num rc-mono" data-label="Quantité">
                      {fmtQty(t.quantity)}
                    </td>
                    <td className="num rc-mono" data-label="Prix unitaire">
                      {fmtPrice(t.price, t.currency)}
                    </td>
                    <td className="num rc-mono" data-label="Frais">
                      {fmtMoney(t.fees || 0, t.currency)}
                    </td>
                    <td className="num rc-mono" data-label={t.type === "achat" ? "Décaissé" : "Encaissé"}>
                      <strong>{fmtMoney(amount, t.currency)}</strong>
                    </td>
                    <td className="rc-td-actions">
                      <div className="rc-actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap", gap: 2 }}>
                        <button type="button" className="rc-icon-btn" onClick={() => onEdit(t)} aria-label={`Modifier la transaction du ${fmtDate(t.date)}`}>
                          <Icon name="pencil" size={16} />
                        </button>
                        <button type="button" className="rc-icon-btn" onClick={() => onDelete(t)} aria-label={`Supprimer la transaction du ${fmtDate(t.date)}`}>
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.length > limit && (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="rc-btn sm" onClick={() => setLimit((l) => l + 50)}>
            Afficher 50 transactions de plus ({list.length - limit} restantes)
          </button>
        </div>
      )}
    </section>
  );
}

function Kpi({ label, value, sub, hero = false, loading = false }) {
  return (
    <div className={`rc-kpi${hero ? " rc-kpi-hero" : ""}`}>
      <span className="rc-kpi-label">{label}</span>
      {loading ? (
        <span className="rc-skel" style={{ height: hero ? 40 : 22, width: hero ? "70%" : "60%" }} />
      ) : (
        <span className="rc-kpi-value">{value}</span>
      )}
      {sub && <span className="rc-kpi-sub">{sub}</span>}
    </div>
  );
}

function PortfolioView({
  currency,
  transactions,
  priceMap,
  conv,
  marketStatus,
  pricesReady,
  loadHistory,
  period,
  setPeriod,
  onAdd,
  onEdit,
  onDelete,
  onImport,
  onExport,
  onSample,
  fxNote,
}) {
  const positions = useMemo(() => computePositions(transactions, conv), [transactions, conv]);
  const rows = useMemo(() => enrichPositions(positions, priceMap), [positions, priceMap]);
  const totals = useMemo(() => summarize(rows), [rows]);
  const slices = useMemo(() => buildSlices(rows, totals.value), [rows, totals.value]);
  const colorMap = useMemo(() => {
    const m = new Map();
    slices.forEach((s) => (s.members || [s.key]).forEach((id) => m.set(id, s.color)));
    return m;
  }, [slices]);
  const colorOf = useCallback((id) => colorMap.get(id) || null, [colorMap]);

  const startTs = isoToTs(todayISO()) - period * DAY_MS;
  const idsKey = useMemo(() => coinsActiveInPeriod(transactions, startTs).join(","), [transactions, startTs]);
  const histMode = marketStatus === "loading" ? null : marketStatus === "demo" ? "demo" : "live";
  const [hist, setHist] = useState({ status: "idle", histories: new Map(), failed: [], loaded: 0, total: 0 });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!idsKey) {
      setHist({ status: "idle", histories: new Map(), failed: [], loaded: 0, total: 0 });
      return undefined;
    }
    if (!histMode) {
      setHist({ status: "loading", histories: new Map(), failed: [], loaded: 0, total: idsKey.split(",").length });
      return undefined;
    }
    let cancelled = false;
    const ids = idsKey.split(",");
    setHist({ status: "loading", histories: new Map(), failed: [], loaded: 0, total: ids.length });
    (async () => {
      const histories = new Map();
      const failed = [];
      let lastError = null;
      for (const id of ids) {
        if (cancelled) return;
        try {
          const pts = await loadHistory(id, period, histMode);
          if (pts && pts.length) histories.set(id, pts);
          else failed.push(id);
        } catch (err) {
          failed.push(id);
          lastError = err;
        }
        if (!cancelled) setHist((h) => ({ ...h, loaded: histories.size + failed.length }));
      }
      if (!cancelled) {
        setHist({ status: histories.size ? "ready" : "error", histories, failed, loaded: ids.length, total: ids.length, error: lastError });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey, period, histMode, reload, loadHistory]);

  const series = useMemo(
    () => (hist.status === "ready" ? buildValueSeries({ transactions, histories: hist.histories, days: period, conv, priceMap }) : []),
    [hist, transactions, period, conv, priceMap],
  );
  const nameOf = (id) => (positions.find((p) => p.coinId === id) || { name: id }).name;

  if (!transactions.length) {
    return (
      <div className="rc-empty">
        <h3>Aucune transaction enregistrée</h3>
        <p>
          Saisissez vos achats et ventes pour suivre le prix de revient, la valeur actuelle et les plus ou moins-values de chaque actif. Les données
          restent dans cette session : pensez à exporter une sauvegarde JSON depuis les paramètres.
        </p>
        <div className="rc-actions">
          <button type="button" className="rc-btn primary" onClick={onAdd}>
            <Icon name="plus" size={16} /> Ajouter une transaction
          </button>
          <button type="button" className="rc-btn" onClick={onImport}>
            <Icon name="upload" size={16} /> Importer un CSV
          </button>
          <button type="button" className="rc-btn ghost" onClick={onSample}>
            Charger un portefeuille d'exemple
          </button>
        </div>
      </div>
    );
  }

  const loadingPrices = !pricesReady;
  const heroSub =
    totals.change24 != null ? (
      <>
        <span>24 h</span>
        <MoneyDelta value={totals.change24} currency={currency} />
        <Delta value={totals.change24Pct} chip />
      </>
    ) : (
      <span className="rc-muted">Variation 24 h indisponible</span>
    );

  return (
    <>
      <div className="rc-section-head">
        <p className="rc-footnote">
          {totals.openCount} position(s) ouverte(s) · {transactions.length} transaction(s)
          {totals.missing > 0 && ` · ${totals.missing} actif(s) sans cours, exclu(s) de la valeur`}
        </p>
        <div className="rc-actions">
          <button type="button" className="rc-btn sm" onClick={onImport}>
            <Icon name="upload" size={15} /> Importer CSV
          </button>
          <button type="button" className="rc-btn sm" onClick={onExport}>
            <Icon name="download" size={15} /> Exporter CSV
          </button>
          <button type="button" className="rc-btn primary sm" onClick={onAdd}>
            <Icon name="plus" size={15} /> Transaction
          </button>
        </div>
      </div>

      <div className="rc-kpis">
        <Kpi hero label="Valeur du portefeuille" value={fmtMoney(totals.value, currency)} sub={loadingPrices ? null : heroSub} loading={loadingPrices} />
        <Kpi
          label="Plus-value latente"
          loading={loadingPrices}
          value={<MoneyDelta value={totals.latent} currency={currency} />}
          sub={<Delta value={totals.latentPct} chip />}
        />
        <Kpi
          label="Plus-value réalisée"
          value={<MoneyDelta value={totals.realized} currency={currency} />}
          sub={totals.sells ? <><Delta value={totals.realizedPct} chip /> <span>sur {totals.sells} vente(s)</span></> : <span className="rc-muted">Aucune vente</span>}
        />
        <Kpi
          label="Capital investi"
          value={fmtMoney(totals.cost, currency)}
          sub={<span className="rc-muted">coût de revient des positions ouvertes · frais cumulés {fmtMoney(totals.fees, currency)}</span>}
        />
      </div>

      {fxNote}

      <div className="rc-grid-2">
        <section className="rc-card" aria-labelledby="rc-chart-title">
          <div className="rc-card-head">
            <div>
              <h2 className="rc-card-title" id="rc-chart-title">
                Évolution de la valeur
              </h2>
              <div className="rc-legend-inline" style={{ marginTop: 6 }}>
                <span>
                  <i className="rc-key" />
                  Valeur
                </span>
                <span>
                  <i className="rc-key dash" />
                  Capital investi
                </span>
              </div>
            </div>
            <Segmented label="Période" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.days, label: p.label }))} />
          </div>
          {hist.status === "idle" ? (
            <div className="rc-chart-state">Aucune position détenue sur cette période.</div>
          ) : hist.status === "loading" ? (
            <div className="rc-chart-state" aria-busy="true">
              <span className="rc-skel" style={{ width: "70%", height: 10 }} />
              <span>
                Chargement de l'historique des cours… {hist.loaded}/{hist.total}
              </span>
            </div>
          ) : hist.status === "error" ? (
            <div className="rc-chart-state">
              <span>Historique indisponible : {describeError(hist.error) || "aucune donnée reçue"}.</span>
              <button type="button" className="rc-btn sm" onClick={() => setReload((n) => n + 1)}>
                Réessayer
              </button>
            </div>
          ) : (
            <>
              <ValueChart data={series} currency={currency} days={period} />
              {hist.failed.length > 0 && (
                <p className="rc-footnote" style={{ marginTop: 8 }}>
                  Courbe partielle : historique indisponible pour {hist.failed.map(nameOf).join(", ")}.{" "}
                  <button type="button" className="rc-link" onClick={() => setReload((n) => n + 1)}>
                    Réessayer
                  </button>
                </p>
              )}
            </>
          )}
        </section>
        <section className="rc-card" aria-labelledby="rc-alloc-title">
          <div className="rc-card-head">
            <div>
              <h2 className="rc-card-title" id="rc-alloc-title">
                Répartition par actif
              </h2>
              <p className="rc-card-sub">En valeur actuelle</p>
            </div>
          </div>
          {loadingPrices ? (
            <div className="rc-chart-state" style={{ height: 200 }} aria-busy="true">
              Chargement des cours…
            </div>
          ) : slices.length ? (
            <AllocationChart slices={slices} total={totals.value} currency={currency} />
          ) : (
            <div className="rc-chart-state" style={{ height: 200 }}>
              {totals.openCount ? "Cours indisponibles pour les positions ouvertes." : "Aucune position ouverte."}
            </div>
          )}
        </section>
      </div>

      <PositionsTable rows={rows} currency={currency} colorOf={colorOf} totalValue={totals.value} />
      <TransactionsTable transactions={transactions} onEdit={onEdit} onDelete={onDelete} />
    </>
  );
}

/* ─────────────────────────── Vue Marché ─────────────────────────── */

const SORTS = {
  rank: { label: "Rang", get: (c) => c.rank, dir: 1 },
  name: { label: "Nom", get: (c) => norm(c.name), dir: 1 },
  price: { label: "Cours", get: (c) => c.price, dir: -1 },
  change24h: { label: "24 h", get: (c) => c.change24h, dir: -1 },
  change7d: { label: "7 j", get: (c) => c.change7d, dir: -1 },
  mcap: { label: "Capitalisation", get: (c) => c.mcap, dir: -1 },
};

function sortCoins(list, sort) {
  const { get } = SORTS[sort.key];
  return [...list].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const na = va == null || (typeof va === "number" && !Number.isFinite(va));
    const nb = vb == null || (typeof vb === "number" && !Number.isFinite(vb));
    if (na || nb) return na === nb ? 0 : na ? 1 : -1;
    if (typeof va === "string") return va.localeCompare(vb) * sort.dir;
    return (va - vb) * sort.dir;
  });
}

const MarketRow = memo(function MarketRow({ coin, currency, starred, onToggleStar, onAlert }) {
  const up = isNum(coin.change7d) ? coin.change7d >= 0 : isNum(coin.change24h) ? coin.change24h >= 0 : true;
  return (
    <div className="rc-mkt-row" role="row">
      <div role="cell">
        <button
          type="button"
          className={`rc-star${starred ? " on" : ""}`}
          aria-pressed={starred}
          aria-label={starred ? `Retirer ${coin.name} de la watchlist` : `Ajouter ${coin.name} à la watchlist`}
          onClick={() => onToggleStar(coin)}
        >
          <Icon name="star" size={17} filled={starred} />
        </button>
      </div>
      <div role="cell" className="c-rank rc-num rc-muted">
        {coin.rank || "—"}
      </div>
      <div role="cell" className="c-asset" style={{ minWidth: 0 }}>
        <div className="rc-asset">
          <CoinAvatar coin={coin} />
          <div className="rc-asset-text">
            <div className="rc-asset-name" title={coin.name}>
              {coin.name}
            </div>
            <div className="rc-asset-sym">
              {coin.symbol}
              {coin.rank ? <span className="rc-inline-sm">{` · #${coin.rank}`}</span> : null}
            </div>
          </div>
        </div>
      </div>
      <div role="cell" className="c-price">
        {fmtPrice(coin.price, currency)}
        <div className="rc-only-sm">
          <Delta value={coin.change24h} />
        </div>
      </div>
      <div role="cell" className="c-24h">
        <Delta value={coin.change24h} />
      </div>
      <div role="cell" className="c-7d">
        <Delta value={coin.change7d} />
      </div>
      <div role="cell" className="c-mcap">
        {fmtCompact(coin.mcap, currency)}
      </div>
      <div role="cell" className="c-spark" aria-label={`Tendance 7 jours ${isNum(coin.change7d) ? fmtPct(coin.change7d) : "indisponible"}`}>
        <Sparkline data={coin.spark} positive={up} />
      </div>
      <div role="cell">
        <button type="button" className="rc-icon-btn" onClick={() => onAlert(coin)} aria-label={`Créer une alerte de prix pour ${coin.name}`}>
          <Icon name="bell" size={16} />
        </button>
      </div>
    </div>
  );
});

function MarketView({ market, watchlist, directory, onToggleStar, onAlert, remoteSearch }) {
  const [tab, setTab] = useState("top");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: "rank", dir: 1 });
  const [remote, setRemote] = useState({ status: "idle", items: [], query: "" });
  const cur = market.currency;
  const q = norm(query.trim());
  const wlSet = useMemo(() => new Set(watchlist), [watchlist]);

  const list = useMemo(() => {
    const byId = new Map();
    market.coins.forEach((c) => byId.set(c.id, c));
    market.extras.forEach((c) => {
      if (!byId.has(c.id)) byId.set(c.id, c);
    });
    const base =
      tab === "top"
        ? market.coins
        : watchlist.map((id) => byId.get(id) || { ...(directory.get(id) || { id, symbol: id.toUpperCase(), name: id }), price: null, spark: [] });
    const filtered = q ? base.filter((c) => norm(c.name).includes(q) || c.symbol.toLowerCase().includes(q) || c.id.includes(q)) : base;
    return sortCoins(filtered, sort);
  }, [market.coins, market.extras, watchlist, directory, tab, q, sort]);

  const setSortKey = (key) =>
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: SORTS[key].dir }));
  const header = (key, cls, label) => (
    <div role="columnheader" className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="rc-sort" aria-pressed={sort.key === key} onClick={() => setSortKey(key)}>
        {label || SORTS[key].label}
        {sort.key === key && <Icon name={sort.dir === 1 ? "up" : "down"} size={13} />}
      </button>
    </div>
  );
  const runRemote = async () => {
    const text = query.trim();
    if (text.length < 2) return;
    setRemote({ status: "loading", items: [], query: q });
    try {
      const items = await remoteSearch(text);
      setRemote({ status: "done", items, query: q });
    } catch (err) {
      setRemote({ status: "error", items: [], query: q, error: err });
    }
  };
  const loading = market.status === "loading" && !market.coins.length;

  return (
    <>
      <div className="rc-toolbar">
        <Segmented
          label="Liste affichée"
          value={tab}
          onChange={setTab}
          options={[
            { value: "top", label: "Top 100" },
            { value: "watch", label: `Watchlist (${watchlist.length})` },
          ]}
        />
        <div className="rc-search">
          <Icon name="search" size={16} />
          <label className="rc-sr" htmlFor="rc-mkt-search">
            Rechercher une crypto
          </label>
          <input
            id="rc-mkt-search"
            className="rc-input"
            type="search"
            placeholder="Nom ou symbole"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="rc-sort-select">
          <label className="rc-sr" htmlFor="rc-mkt-sort">
            Trier par
          </label>
          <select
            id="rc-mkt-sort"
            className="rc-input"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(":");
              setSort({ key, dir: Number(dir) });
            }}
          >
            <option value="rank:1">Rang</option>
            <option value="name:1">Nom (A → Z)</option>
            <option value="price:-1">Cours décroissant</option>
            <option value="change24h:-1">Hausse 24 h</option>
            <option value="change24h:1">Baisse 24 h</option>
            <option value="change7d:-1">Hausse 7 j</option>
            <option value="change7d:1">Baisse 7 j</option>
            <option value="mcap:-1">Capitalisation</option>
          </select>
        </div>
      </div>

      <div className="rc-mkt" role="table" aria-label={tab === "top" ? "Top 100 des cryptomonnaies" : "Watchlist"} aria-busy={loading}>
        <div className="rc-mkt-row rc-mkt-head" role="row">
          <div role="columnheader">
            <span className="rc-sr">Watchlist</span>
          </div>
          {header("rank", "c-rank", "#")}
          {header("name", "c-asset")}
          {header("price", "c-price")}
          {header("change24h", "c-24h")}
          {header("change7d", "c-7d")}
          {header("mcap", "c-mcap", "Capitalisation")}
          <div role="columnheader" className="c-spark">
            7 derniers jours
          </div>
          <div role="columnheader">
            <span className="rc-sr">Alerte</span>
          </div>
        </div>
        {loading
          ? Array.from({ length: 8 }, (_, i) => (
              <div className="rc-mkt-row" role="row" key={i} aria-hidden="true">
                <span />
                <span className="rc-skel c-rank" style={{ height: 12, width: 18 }} />
                <span className="rc-skel" style={{ height: 14, width: "60%" }} />
                <span className="rc-skel" style={{ height: 14, width: 70, justifySelf: "end" }} />
                <span className="rc-skel c-24h" style={{ height: 12, width: 50, justifySelf: "end" }} />
                <span className="rc-skel c-7d" style={{ height: 12, width: 50, justifySelf: "end" }} />
                <span className="rc-skel c-mcap" style={{ height: 12, width: 60, justifySelf: "end" }} />
                <span className="rc-skel c-spark" style={{ height: 20, width: 96 }} />
                <span />
              </div>
            ))
          : list.map((c) => (
              <MarketRow key={c.id} coin={c} currency={cur} starred={wlSet.has(c.id)} onToggleStar={onToggleStar} onAlert={onAlert} />
            ))}
        {!loading && !list.length && (
          <div className="rc-inline-empty" role="row">
            <div role="cell">
              {tab === "watch" && !q ? (
                <>
                  <strong>Votre watchlist est vide.</strong>
                  <p>Touchez l'étoile d'une crypto du top 100 pour la suivre ici, avec son cours et sa tendance.</p>
                  <button type="button" className="rc-btn sm" onClick={() => setTab("top")} style={{ marginTop: 8 }}>
                    Voir le top 100
                  </button>
                </>
              ) : (
                <p>
                  Aucune crypto {tab === "top" ? "du top 100" : "de la watchlist"} ne correspond à « {query.trim()} ».
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {q.length >= 2 && (
        <section className="rc-card" aria-labelledby="rc-remote-title">
          <div className="rc-card-head">
            <div>
              <h2 className="rc-card-title" id="rc-remote-title">
                Hors du top 100
              </h2>
              <p className="rc-card-sub">Ajoutez n'importe quelle crypto référencée par CoinGecko à la watchlist.</p>
            </div>
            <button type="button" className="rc-btn sm" onClick={runRemote} disabled={remote.status === "loading"}>
              <Icon name="search" size={15} /> Rechercher « {query.trim()} » sur CoinGecko
            </button>
          </div>
          {remote.query === q && remote.status === "loading" && <p className="rc-help">Recherche en cours…</p>}
          {remote.query === q && remote.status === "error" && <p className="rc-error">Recherche indisponible : {describeError(remote.error)}.</p>}
          {remote.query === q && remote.status === "done" && !remote.items.length && <p className="rc-help">Aucun résultat.</p>}
          {remote.query === q && remote.items.length > 0 && (
            <ul className="rc-legend">
              {remote.items.map((c) => (
                <li key={c.id} style={{ gridTemplateColumns: "auto minmax(0,1fr) auto auto" }}>
                  <CoinAvatar coin={c} size={22} />
                  <span className="rc-legend-name">
                    {c.name} <span className="rc-muted">{c.symbol}</span>
                  </span>
                  <span className="rc-muted rc-num">{c.rank ? `#${c.rank}` : "non classé"}</span>
                  <span className="rc-actions" style={{ flexWrap: "nowrap", gap: 2 }}>
                    <button
                      type="button"
                      className={`rc-star${wlSet.has(c.id) ? " on" : ""}`}
                      aria-pressed={wlSet.has(c.id)}
                      aria-label={wlSet.has(c.id) ? `Retirer ${c.name} de la watchlist` : `Ajouter ${c.name} à la watchlist`}
                      onClick={() => onToggleStar(c)}
                    >
                      <Icon name="star" size={17} filled={wlSet.has(c.id)} />
                    </button>
                    <button type="button" className="rc-icon-btn" onClick={() => onAlert(c)} aria-label={`Créer une alerte de prix pour ${c.name}`}>
                      <Icon name="bell" size={16} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="rc-footnote">
        {market.status === "demo"
          ? "Cours simulés (mode démonstration)."
          : market.updatedAt
            ? `Cours au ${fmtDay(market.updatedAt)} à ${fmtTime(market.updatedAt)} · source CoinGecko · devise ${cur}.`
            : "Source CoinGecko."}
      </p>
    </>
  );
}

/* ─────────────────────────── Vue Alertes ─────────────────────────── */

function AlertsView({ alerts, priceMap, currency, conv, onNew, onEdit, onDelete, onRearm }) {
  const active = alerts.filter((a) => !a.triggeredAt).sort((a, b) => a.name.localeCompare(b.name));
  const fired = alerts.filter((a) => a.triggeredAt).sort((a, b) => b.triggeredAt - a.triggeredAt);
  const cond = (a) => `${a.direction === "above" ? "≥" : "≤"} ${fmtPrice(a.threshold, a.currency)}`;

  if (!alerts.length) {
    return (
      <div className="rc-empty">
        <h3>Aucune alerte de prix</h3>
        <p>
          Une alerte surveille le cours d'une crypto à chaque actualisation (toutes les 60 secondes) et affiche une notification dans l'application
          quand le seuil est franchi, à la hausse ou à la baisse.
        </p>
        <button type="button" className="rc-btn primary" onClick={() => onNew(null)}>
          <Icon name="plus" size={16} /> Créer une alerte
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="rc-section-head">
        <p className="rc-footnote">
          {active.length} alerte(s) active(s) · {fired.length} déclenchée(s) · vérification à chaque actualisation des cours
        </p>
        <button type="button" className="rc-btn primary sm" onClick={() => onNew(null)}>
          <Icon name="plus" size={15} /> Nouvelle alerte
        </button>
      </div>
      <section className="rc-card" aria-labelledby="rc-al-active">
        <div className="rc-card-head">
          <h2 className="rc-card-title" id="rc-al-active">
            Alertes actives
          </h2>
        </div>
        {active.length === 0 ? (
          <div className="rc-inline-empty">Toutes vos alertes ont été déclenchées. Réarmez-les ou créez-en une nouvelle.</div>
        ) : (
          <div className="rc-table-wrap rc-scroll">
            <table className="rc-table rc-stack">
              <thead>
                <tr>
                  <th scope="col">Actif</th>
                  <th scope="col" className="num">
                    Condition
                  </th>
                  <th scope="col" className="num">
                    Cours actuel
                  </th>
                  <th scope="col" className="num">
                    Distance au seuil
                  </th>
                  <th scope="col">
                    <span className="rc-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.map((a) => {
                  const c = priceMap.get(a.coinId);
                  const price = c && isNum(c.price) ? c.price : null;
                  const th = conv(a.threshold, a.currency);
                  const dist = price && isNum(th) ? (th / price - 1) * 100 : null;
                  return (
                    <tr key={a.id}>
                      <td className="rc-td-main">
                        <div className="rc-asset">
                          <CoinAvatar coin={{ id: a.coinId, symbol: a.symbol, image: a.image || (c && c.image) }} />
                          <div className="rc-asset-text">
                            <div className="rc-asset-name">{a.name}</div>
                            <div className="rc-asset-sym">{a.symbol}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num" data-label="Condition">
                        {cond(a)}
                      </td>
                      <td className="num" data-label="Cours actuel">
                        {price != null ? fmtPrice(price, currency) : <span className="rc-muted">indisponible</span>}
                      </td>
                      <td className="num" data-label="Distance au seuil">
                        {dist != null ? fmtPct(dist) : "—"}
                      </td>
                      <td className="rc-td-actions">
                        <div className="rc-actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap", gap: 2 }}>
                          <button type="button" className="rc-icon-btn" onClick={() => onEdit(a)} aria-label={`Modifier l'alerte ${a.symbol}`}>
                            <Icon name="pencil" size={16} />
                          </button>
                          <button type="button" className="rc-icon-btn" onClick={() => onDelete(a)} aria-label={`Supprimer l'alerte ${a.symbol}`}>
                            <Icon name="trash" size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {fired.length > 0 && (
        <section className="rc-card" aria-labelledby="rc-al-fired">
          <div className="rc-card-head">
            <h2 className="rc-card-title" id="rc-al-fired">
              Alertes déclenchées
            </h2>
          </div>
          <div className="rc-table-wrap rc-scroll">
            <table className="rc-table rc-stack">
              <thead>
                <tr>
                  <th scope="col">Actif</th>
                  <th scope="col" className="num">
                    Condition
                  </th>
                  <th scope="col" className="num">
                    Déclenchée le
                  </th>
                  <th scope="col" className="num">
                    Cours au déclenchement
                  </th>
                  <th scope="col">
                    <span className="rc-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fired.map((a) => (
                  <tr key={a.id}>
                    <td className="rc-td-main">
                      <div className="rc-asset">
                        <CoinAvatar coin={{ id: a.coinId, symbol: a.symbol, image: a.image }} />
                        <div className="rc-asset-text">
                          <div className="rc-asset-name">{a.name}</div>
                          <div className="rc-asset-sym">
                            {a.symbol}
                            {a.simulated ? " · cours simulé" : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="num" data-label="Condition">
                      {cond(a)}
                    </td>
                    <td className="num" data-label="Déclenchée le">
                      {fmtDayTime(a.triggeredAt)}
                    </td>
                    <td className="num" data-label="Cours au déclenchement">
                      {fmtPrice(a.triggeredPrice, a.triggeredCurrency || currency)}
                    </td>
                    <td className="rc-td-actions">
                      <div className="rc-actions" style={{ justifyContent: "flex-end", flexWrap: "nowrap", gap: 4 }}>
                        <button type="button" className="rc-btn sm" onClick={() => onRearm(a)}>
                          Réarmer
                        </button>
                        <button type="button" className="rc-icon-btn" onClick={() => onEdit(a)} aria-label={`Modifier l'alerte ${a.symbol}`}>
                          <Icon name="pencil" size={16} />
                        </button>
                        <button type="button" className="rc-icon-btn" onClick={() => onDelete(a)} aria-label={`Supprimer l'alerte ${a.symbol}`}>
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/* ─────────────────────────── Vue Paramètres ─────────────────────────── */

function SettingsView({ settings, onCurrency, onTheme, market, nextAt, onRefresh, onExportJSON, onImportJSON, onReset, dirty, lastBackupAt, counts }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const statusText = {
    live: "En direct",
    stale: "Données en cache (dernière actualisation échouée)",
    demo: "Démonstration : cours simulés",
    loading: "Connexion en cours",
  }[market.status];
  return (
    <div className="rc-settings">
      <section className="rc-card rc-setting" aria-labelledby="rc-set-display">
        <h2 className="rc-card-title" id="rc-set-display">
          Affichage
        </h2>
        <div className="rc-field">
          <span className="rc-label">Devise</span>
          <Segmented label="Devise d'affichage" value={settings.currency} onChange={onCurrency} options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))} />
          <p className="rc-help">
            Les nouvelles transactions et alertes sont saisies dans cette devise. Les montants saisis dans une autre devise sont convertis au taux du
            jour publié par CoinGecko.
          </p>
        </div>
        <div className="rc-field">
          <span className="rc-label">Thème</span>
          <Segmented
            label="Thème"
            value={settings.theme}
            onChange={onTheme}
            options={[
              { value: "light", label: "Clair" },
              { value: "dark", label: "Sombre" },
            ]}
          />
        </div>
      </section>

      <section className="rc-card rc-setting" aria-labelledby="rc-set-backup">
        <h2 className="rc-card-title" id="rc-set-backup">
          Sauvegarde
        </h2>
        <p className="rc-help">
          Aucune donnée n'est enregistrée dans le navigateur : tout est perdu à la fermeture de la page. Exportez une sauvegarde JSON et
          réimportez-la à la prochaine session.
        </p>
        <dl className="rc-dl">
          <dt>Contenu</dt>
          <dd>
            {counts.transactions} transaction(s), {counts.watchlist} favori(s), {counts.alerts} alerte(s)
          </dd>
          <dt>Dernière sauvegarde</dt>
          <dd>{lastBackupAt ? fmtDayTime(lastBackupAt) : "jamais dans cette session"}</dd>
          <dt>État</dt>
          <dd>
            {dirty ? (
              <span style={{ color: "var(--warn)", fontWeight: 600 }}>
                <span className="rc-dirty" style={{ marginRight: 6 }} />
                Modifications non sauvegardées
              </span>
            ) : (
              "À jour"
            )}
          </dd>
        </dl>
        <div className="rc-actions">
          <button type="button" className="rc-btn primary" onClick={onExportJSON}>
            <Icon name="download" size={16} /> Exporter la sauvegarde JSON
          </button>
          <button type="button" className="rc-btn" onClick={onImportJSON}>
            <Icon name="upload" size={16} /> Importer une sauvegarde
          </button>
        </div>
      </section>

      <section className="rc-card rc-setting" aria-labelledby="rc-set-data">
        <h2 className="rc-card-title" id="rc-set-data">
          Données de marché
        </h2>
        <dl className="rc-dl">
          <dt>Source</dt>
          <dd>API publique CoinGecko (sans clé)</dd>
          <dt>Statut</dt>
          <dd>{statusText}</dd>
          <dt>Dernière mise à jour</dt>
          <dd>{market.updatedAt ? `${fmtDay(market.updatedAt)} à ${fmtTime(market.updatedAt)}` : "—"}</dd>
          <dt>Prochaine</dt>
          <dd>{market.refreshing ? "en cours…" : nextAt ? <>dans <Countdown target={nextAt} /></> : "—"}</dd>
          <dt>Fréquence</dt>
          <dd>60 s, requêtes espacées, pause progressive (jusqu'à 5 min) après un refus ou une erreur</dd>
        </dl>
        {market.error && <p className="rc-help">Dernier incident : {describeError(market.error)}.</p>}
        <div className="rc-actions">
          <button type="button" className="rc-btn" onClick={onRefresh} disabled={market.refreshing || client.blockedKind() === "rate_limited"}>
            <Icon name="refresh" size={16} className={market.refreshing ? "rc-spin" : undefined} /> Actualiser maintenant
          </button>
        </div>
      </section>

      <section className="rc-card rc-setting" aria-labelledby="rc-set-reset">
        <h2 className="rc-card-title" id="rc-set-reset">
          Réinitialisation
        </h2>
        <p className="rc-help">Efface les transactions, la watchlist et les alertes de cette session. Les paramètres sont conservés.</p>
        {confirmReset ? (
          <div className="rc-actions" role="group" aria-label="Confirmer l'effacement">
            <span className="rc-error">Effacer définitivement toutes les données ?</span>
            <button
              type="button"
              className="rc-btn danger solid"
              onClick={() => {
                onReset();
                setConfirmReset(false);
              }}
            >
              Oui, tout effacer
            </button>
            <button type="button" className="rc-btn" onClick={() => setConfirmReset(false)}>
              Annuler
            </button>
          </div>
        ) : (
          <div className="rc-actions">
            <button type="button" className="rc-btn danger" onClick={() => setConfirmReset(true)} disabled={!counts.transactions && !counts.watchlist && !counts.alerts}>
              <Icon name="trash" size={16} /> Effacer toutes les données
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/* ─────────────────────────── Application ─────────────────────────── */

export default function RegistreCrypto() {
  const [initial] = useState(() => ({ transactions: [], watchlist: [], alerts: [] }));
  const [settings, setSettings] = useState(() => ({ currency: "EUR", theme: detectTheme() }));
  const [transactions, setTransactions] = useState(initial.transactions);
  const [watchlist, setWatchlist] = useState(initial.watchlist);
  const [alerts, setAlerts] = useState(initial.alerts);
  const [saved, setSaved] = useState(() => ({ ...initial, at: null }));
  const [view, setView] = useState("portefeuille");
  const [period, setPeriod] = useState(30);
  const [market, setMarket] = useState({ status: "loading", currency: "EUR", coins: [], extras: [], updatedAt: null, error: null, refreshing: false });
  const [rates, setRates] = useState(null);
  const [remoteCoins, setRemoteCoins] = useState(() => new Map());
  const [nextAt, setNextAt] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);

  const timerRef = useRef(null);
  const inflightRef = useRef(false);
  const pendingRef = useRef(false);
  const demoRef = useRef(null);
  const refreshRef = useRef(null);
  const toastSeq = useRef(0);

  const currency = settings.currency;
  const trackedIds = useMemo(
    () => [...new Set([...transactions.map((t) => t.coinId), ...watchlist, ...alerts.map((a) => a.coinId)])].sort(),
    [transactions, watchlist, alerts],
  );
  const liveRef = useRef({});
  liveRef.current = { currency, trackedIds, market };

  /* Notifications */
  const dismissToast = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const pushToast = useCallback(
    (t) => {
      toastSeq.current += 1;
      const toast = { id: toastSeq.current, kind: "info", ...t };
      setToasts((ts) => {
        const next = [...ts, toast];
        const transient = next.filter((x) => !x.sticky);
        const drop = new Set(transient.slice(0, Math.max(0, transient.length - 3)).map((x) => x.id));
        return next.filter((x) => !drop.has(x.id));
      });
      if (!t.sticky) setTimeout(() => dismissToast(toast.id), t.duration || 6000);
      return toast.id;
    },
    [dismissToast],
  );

  /* Actualisation des cours */
  const schedule = useCallback(() => {
    clearTimeout(timerRef.current);
    const at = Math.max(Date.now() + REFRESH_MS, client.blockedUntil());
    setNextAt(at);
    timerRef.current = setTimeout(() => {
      if (typeof document !== "undefined" && document.hidden) {
        pendingRef.current = true;
        return;
      }
      if (refreshRef.current) refreshRef.current();
    }, at - Date.now());
  }, []);

  const refresh = useCallback(
    async ({ manual = false, topTtl } = {}) => {
      if (inflightRef.current) return;
      inflightRef.current = true;
      clearTimeout(timerRef.current);
      const cur = liveRef.current.currency;
      const ccy = cur.toLowerCase();
      if (manual && client.blockedKind() !== "rate_limited") client.resetBackoff();
      setMarket((m) => ({ ...m, refreshing: true }));
      let next;
      try {
        const top = await client.request(PATHS.top(ccy), { ttl: topTtl != null ? topTtl : manual ? 10_000 : 20_000 });
        const coins = normalizeList(top.data);
        if (!coins.length) throw new ApiError("parse", "Liste vide");
        const known = new Set(coins.map((c) => c.id));
        const extraIds = liveRef.current.trackedIds.filter((id) => !known.has(id));
        let extras = [];
        if (extraIds.length) {
          try {
            const r = await client.request(PATHS.ids(ccy, extraIds), { ttl: 20_000 });
            extras = normalizeList(r.data);
          } catch (err) {
            const prev = liveRef.current.market;
            extras = prev.currency === cur ? prev.extras.filter((c) => extraIds.includes(c.id)) : [];
          }
        }
        next = { status: top.stale ? "stale" : "live", currency: cur, coins, extras, updatedAt: top.ts, error: top.stale ? top.error : null, refreshing: false };
      } catch (err) {
        const prev = liveRef.current.market;
        if (prev.currency === cur && prev.coins.length && prev.status !== "demo") {
          next = { ...prev, status: "stale", error: err, refreshing: false };
        } else {
          if (!demoRef.current) demoRef.current = createDemoState();
          else advanceDemo(demoRef.current);
          next = { status: "demo", currency: cur, coins: demoMarket(demoRef.current, cur), extras: [], updatedAt: Date.now(), error: err, refreshing: false };
        }
      }
      setMarket(next);
      inflightRef.current = false;
      schedule();
      if (liveRef.current.currency !== cur && refreshRef.current) refreshRef.current({ manual: true });
    },
    [schedule],
  );
  refreshRef.current = refresh;

  useEffect(() => {
    initDownloadsCapability();
    refresh();
    const onVisible = () => {
      if (!document.hidden && pendingRef.current) {
        pendingRef.current = false;
        if (refreshRef.current) refreshRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const firstCurrency = useRef(true);
  useEffect(() => {
    if (firstCurrency.current) {
      firstCurrency.current = false;
      return;
    }
    refresh({ manual: true });
  }, [currency, refresh]);

  // Transitions de statut → notification
  const prevStatus = useRef(null);
  useEffect(() => {
    const p = prevStatus.current;
    const s = market.status;
    prevStatus.current = s;
    if (p === s || p === null) return;
    if (s === "live" && (p === "demo" || p === "stale")) {
      pushToast({ kind: "success", title: "Connexion à CoinGecko rétablie", body: "Les cours affichés sont de nouveau les cours réels." });
    } else if (s === "stale" && p === "live") {
      pushToast({ kind: "warning", title: "Actualisation impossible", body: `Affichage des dernières données reçues (${describeError(market.error)}).` });
    } else if (s === "demo" && p === "loading") {
      pushToast({ kind: "warning", title: "Mode démonstration", body: "CoinGecko est injoignable : les cours affichés sont simulés." });
    }
  }, [market.status, market.error, pushToast]);

  // Prix indexés par identifiant, uniquement s'ils sont dans la devise courante.
  const priceMap = useMemo(() => {
    const m = new Map();
    if (market.currency !== currency) return m;
    market.coins.forEach((c) => m.set(c.id, c));
    market.extras.forEach((c) => {
      if (!m.has(c.id)) m.set(c.id, c);
    });
    return m;
  }, [market, currency]);
  const pricesReady = market.status !== "loading" && market.currency === currency;

  // Nouvel actif suivi hors top 100 : récupère son cours sans attendre le cycle.
  const missingKey = pricesReady ? trackedIds.filter((id) => !priceMap.has(id)).join(",") : "";
  useEffect(() => {
    if (!missingKey || market.status === "demo") return undefined;
    const t = setTimeout(() => refreshRef.current && refreshRef.current({ topTtl: 55_000 }), 400);
    return () => clearTimeout(t);
  }, [missingKey, market.status]);

  // Taux de change (seulement si une devise de saisie diffère de la devise d'affichage)
  const needsFx = transactions.some((t) => t.currency !== currency) || alerts.some((a) => a.currency !== currency);
  const fxMode = market.status === "loading" ? null : market.status === "demo" ? "demo" : "live";
  const fxSlot = Math.floor(Date.now() / 1_800_000);
  useEffect(() => {
    if (!needsFx || !fxMode) return undefined;
    if (fxMode === "demo") {
      setRates((r) => r || { values: DEMO_FX, source: "demo" });
      return undefined;
    }
    let off = false;
    client
      .request(PATHS.rates(), { ttl: 1_800_000 })
      .then((r) => {
        if (off) return;
        const values = {};
        const src = (r.data && r.data.rates) || {};
        for (const code of CURRENCY_CODES) {
          const v = src[code.toLowerCase()] && src[code.toLowerCase()].value;
          if (isNum(v) && v > 0) values[code.toLowerCase()] = v;
        }
        if (Object.keys(values).length >= 2) setRates({ values, source: "live", ts: r.ts });
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [needsFx, fxMode, fxSlot]);

  const conv = useMemo(() => {
    const values = rates && rates.values;
    return (amount, from) => {
      if (!isNum(amount)) return NaN;
      if (!from || from === currency) return amount;
      const a = values && values[from.toLowerCase()];
      const b = values && values[currency.toLowerCase()];
      return isNum(a) && isNum(b) && a > 0 ? (amount * b) / a : NaN;
    };
  }, [rates, currency]);
  const fxMissing = needsFx && !(rates && rates.values[currency.toLowerCase()]);

  // Contrôle des alertes à chaque nouveau jeu de cours
  useEffect(() => {
    if (!priceMap.size) return;
    const hits = [];
    for (const a of alerts) {
      if (a.triggeredAt) continue;
      const c = priceMap.get(a.coinId);
      if (!c || !isNum(c.price)) continue;
      const th = conv(a.threshold, a.currency);
      if (!isNum(th)) continue;
      if (a.direction === "above" ? c.price >= th : c.price <= th) hits.push({ alert: a, price: c.price, th });
    }
    if (!hits.length) return;
    const now = Date.now();
    const simulated = market.status === "demo";
    const byId = new Map(hits.map((h) => [h.alert.id, h]));
    setAlerts((prev) =>
      prev.map((a) =>
        byId.has(a.id) && !a.triggeredAt
          ? { ...a, triggeredAt: now, triggeredPrice: byId.get(a.id).price, triggeredCurrency: currency, simulated, seen: false }
          : a,
      ),
    );
    hits.forEach((h) =>
      pushToast({
        kind: "alert",
        sticky: true,
        title: `${h.alert.symbol} ${h.alert.direction === "above" ? "au-dessus" : "en dessous"} de ${fmtPrice(h.th, currency)}`,
        body: `${h.alert.name} cote ${fmtPrice(h.price, currency)}${simulated ? " (cours simulé)" : ""}. Alerte déclenchée à ${fmtTime(now)}.`,
        action: { label: "Voir les alertes", onClick: () => setView("alertes") },
      }),
    );
  }, [priceMap, alerts, conv, currency, market.status, pushToast]);

  useEffect(() => {
    if (view !== "alertes" || !alerts.some((a) => a.triggeredAt && !a.seen)) return;
    setAlerts((prev) => prev.map((a) => (a.triggeredAt && !a.seen ? { ...a, seen: true } : a)));
  }, [view, alerts]);

  useEffect(() => {
    try {
      document.body.style.backgroundColor = settings.theme === "dark" ? "#0E131A" : "#F3F5F8";
    } catch (e) {
      /* rendu hors navigateur */
    }
  }, [settings.theme]);

  /* Annuaire des actifs connus (sélecteurs, import CSV) */
  const directory = useMemo(() => {
    const m = new Map();
    market.coins.forEach((c) => m.set(c.id, c));
    market.extras.forEach((c) => {
      if (!m.has(c.id)) m.set(c.id, c);
    });
    transactions.forEach((t) => {
      if (!m.has(t.coinId)) m.set(t.coinId, { id: t.coinId, symbol: t.symbol, name: t.name, image: t.image, rank: null });
    });
    alerts.forEach((a) => {
      if (!m.has(a.coinId)) m.set(a.coinId, { id: a.coinId, symbol: a.symbol, name: a.name, image: a.image, rank: null });
    });
    remoteCoins.forEach((c, id) => {
      if (!m.has(id)) m.set(id, c);
    });
    return m;
  }, [market.coins, market.extras, transactions, alerts, remoteCoins]);
  const pickerOptions = useMemo(
    () => [...directory.values()].sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || a.name.localeCompare(b.name)),
    [directory],
  );

  const remoteSearch = useCallback(async (text) => {
    const r = await client.request(PATHS.search(text), { ttl: 600_000 });
    const items = ((r.data && r.data.coins) || []).slice(0, 12).map((c) => ({
      id: c.id,
      symbol: String(c.symbol || "").toUpperCase(),
      name: c.name || c.id,
      image: c.thumb || c.large || null,
      rank: isNum(c.market_cap_rank) ? c.market_cap_rank : null,
    }));
    setRemoteCoins((prev) => {
      const m = new Map(prev);
      items.forEach((i) => {
        if (!m.has(i.id)) m.set(i.id, i);
      });
      return m;
    });
    return items;
  }, []);

  const resolveCoin = useCallback(
    ({ id, symbol, name }) => {
      if (id) {
        const c = directory.get(id);
        if (c) return coinMeta(c);
        if (/^[a-z0-9][a-z0-9-]*$/.test(id)) return { id, symbol: (symbol || id).toUpperCase(), name: name || id, image: null };
        return null;
      }
      if (symbol) {
        const s = symbol.toUpperCase();
        const cands = [...directory.values()].filter((c) => c.symbol === s).sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9));
        if (cands[0]) return coinMeta(cands[0]);
      }
      return null;
    },
    [directory],
  );

  const loadHistory = useCallback(
    async (id, days, mode) => {
      if (mode === "demo") {
        if (!demoRef.current) demoRef.current = createDemoState();
        return demoHistory(demoRef.current, id, days, currency);
      }
      const r = await client.request(PATHS.history(id, currency.toLowerCase(), days), { ttl: days <= 30 ? 900_000 : 3_600_000 });
      const prices = r.data && r.data.prices;
      return Array.isArray(prices) ? prices.filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])) : null;
    },
    [currency],
  );

  /* Actions */
  const saveTransaction = (tx, editing) => {
    setTransactions((prev) => (editing ? prev.map((t) => (t.id === tx.id ? tx : t)) : [...prev, tx]));
    setDialog(null);
    pushToast({
      kind: "success",
      title: editing ? "Transaction modifiée" : "Transaction ajoutée",
      body: `${tx.type === "achat" ? "Achat" : "Vente"} de ${fmtQty(tx.quantity)} ${tx.symbol} le ${fmtDate(tx.date)}.`,
    });
  };
  const deleteTransaction = (tx) => {
    const rest = transactions.filter((t) => t.id !== tx.id);
    const check = validateLedger(rest);
    if (!check.ok) {
      pushToast({ kind: "error", title: "Suppression impossible", body: `${ledgerMessage(check)} Modifiez ou supprimez d'abord cette vente.` });
      return;
    }
    setTransactions(rest);
    pushToast({
      kind: "info",
      title: "Transaction supprimée",
      body: `${tx.type === "achat" ? "Achat" : "Vente"} de ${fmtQty(tx.quantity)} ${tx.symbol} du ${fmtDate(tx.date)}.`,
      action: {
        label: "Annuler",
        onClick: () =>
          setTransactions((prev) => {
            if (prev.some((t) => t.id === tx.id)) return prev;
            const restored = [...prev, tx];
            return validateLedger(restored).ok ? restored : prev;
          }),
      },
    });
  };
  const toggleStar = useCallback((coin) => {
    setWatchlist((prev) => (prev.includes(coin.id) ? prev.filter((id) => id !== coin.id) : [...prev, coin.id]));
    setRemoteCoins((prev) => (prev.has(coin.id) ? prev : new Map(prev).set(coin.id, { ...coinMeta(coin), rank: coin.rank || null })));
  }, []);
  const openAlert = useCallback((coin) => setDialog({ type: "alert", coin: coin ? coinMeta(coin) : null }), []);
  const saveAlert = (alert) => {
    setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev.map((a) => (a.id === alert.id ? alert : a)) : [...prev, alert]));
    setDialog(null);
    pushToast({
      kind: "success",
      title: "Alerte enregistrée",
      body: `${alert.symbol} ${alert.direction === "above" ? "≥" : "≤"} ${fmtPrice(alert.threshold, alert.currency)}`,
    });
  };
  const deleteAlert = (alert) => {
    setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
    pushToast({
      kind: "info",
      title: "Alerte supprimée",
      body: `${alert.symbol} ${alert.direction === "above" ? "≥" : "≤"} ${fmtPrice(alert.threshold, alert.currency)}`,
      action: { label: "Annuler", onClick: () => setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [...prev, alert])) },
    });
  };
  const rearmAlert = (alert) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === alert.id ? { ...a, triggeredAt: null, triggeredPrice: null, triggeredCurrency: null, simulated: false, seen: true } : a)),
    );
    pushToast({ kind: "info", title: "Alerte réarmée", body: "Si la condition est toujours remplie, elle se déclenchera à nouveau immédiatement." });
  };

  const exportCSV = () =>
    setDialog({
      type: "export",
      title: "Exporter les transactions (CSV)",
      filename: `registre-crypto-transactions-${todayISO()}.csv`,
      content: transactionsToCSV(transactions),
      mime: "text/csv;charset=utf-8",
      description: "Séparateur point-virgule, décimales à virgule, dates JJ/MM/AAAA, encodage UTF-8 : le fichier s'ouvre directement dans Excel.",
    });
  const exportJSON = () => {
    const snapshot = { transactions, watchlist, alerts };
    setDialog({
      type: "export",
      title: "Exporter la sauvegarde (JSON)",
      filename: `registre-crypto-sauvegarde-${todayISO()}.json`,
      content: buildBackup({ settings, ...snapshot }),
      mime: "application/json",
      description: "Contient les transactions, la watchlist, les alertes et les paramètres. Réimportez ce fichier à la prochaine session.",
      onDone: () => setSaved({ ...snapshot, at: Date.now() }),
    });
  };
  const analyzeImportCSV = (text) => {
    const { valid, duplicates, errors } = analyzeCSV(text, { resolveCoin, defaultCurrency: currency, existing: transactions });
    const notes = [];
    if (duplicates) notes.push(`${duplicates} ligne(s) identique(s) à des transactions existantes ignorée(s).`);
    if (errors.length) notes.push(`${errors.length} ligne(s) rejetée(s) :`);
    return {
      canImport: valid.length > 0,
      summary: valid.length ? `${valid.length} transaction(s) prête(s) à importer.` : "Aucune transaction importable.",
      notes,
      errors: errors.map((e) => (e.line ? `Ligne ${e.line} : ${e.message}` : e.message)),
      payload: valid,
      confirmLabel: `Importer ${valid.length} transaction(s)`,
    };
  };
  const confirmImportCSV = (valid) => {
    setTransactions((prev) => [...prev, ...valid]);
    setDialog(null);
    pushToast({ kind: "success", title: "Import terminé", body: `${valid.length} transaction(s) ajoutée(s) au registre.` });
  };
  const analyzeImportJSON = (text) => {
    const r = parseBackup(text);
    if (!r.ok) return { canImport: false, summary: r.error, errors: r.details || [] };
    const d = r.data;
    const date = r.exportedAt && !Number.isNaN(Date.parse(r.exportedAt)) ? ` du ${fmtDayTime(Date.parse(r.exportedAt))}` : "";
    return {
      canImport: true,
      summary: `Sauvegarde${date} : ${d.transactions.length} transaction(s), ${d.watchlist.length} favori(s), ${d.alerts.length} alerte(s).`,
      notes: ["L'import remplace toutes les données actuelles de la session."],
      errors: [],
      payload: d,
      confirmLabel: "Remplacer mes données",
    };
  };
  const confirmImportJSON = (d) => {
    setTransactions(d.transactions);
    setWatchlist(d.watchlist);
    setAlerts(d.alerts);
    setSettings((s) => ({ ...s, ...d.settings }));
    setSaved({ transactions: d.transactions, watchlist: d.watchlist, alerts: d.alerts, at: saved.at });
    setDialog(null);
    pushToast({ kind: "success", title: "Sauvegarde restaurée", body: `${d.transactions.length} transaction(s), ${d.alerts.length} alerte(s).` });
  };
  const loadSample = () => {
    setTransactions(buildSamplePortfolio(currency, priceMap));
    pushToast({
      kind: "info",
      title: "Portefeuille d'exemple chargé",
      body: "Six transactions fictives, notées « Exemple ». Effacez-les depuis les paramètres ou supprimez-les une à une.",
    });
  };
  const resetAll = () => {
    setTransactions([]);
    setWatchlist([]);
    setAlerts([]);
    pushToast({ kind: "info", title: "Données effacées", body: "Le registre, la watchlist et les alertes sont vides." });
  };

  const dirty = transactions !== saved.transactions || watchlist !== saved.watchlist || alerts !== saved.alerts;
  const hasData = transactions.length + watchlist.length + alerts.length > 0;
  const unsaved = dirty && hasData;
  const unseenAlerts = alerts.filter((a) => a.triggeredAt && !a.seen).length;
  const rateLimited = client.blockedKind() === "rate_limited";
  const viewDef = VIEWS.find((v) => v.id === view);

  const retryButton = (
    <button type="button" className="rc-btn sm" onClick={() => refresh({ manual: true })} disabled={market.refreshing || rateLimited}>
      {market.refreshing ? "Actualisation…" : "Réessayer"}
    </button>
  );

  const navItems = VIEWS.map((v) => ({
    ...v,
    badge: v.id === "alertes" && unseenAlerts ? unseenAlerts : null,
    dot: v.id === "parametres" && unsaved,
  }));

  return (
    <div className="rc" data-theme={settings.theme}>
      <style>{CSS}</style>
      <div className="rc-shell">
        <aside className="rc-rail" aria-label="Navigation principale">
          <div className="rc-brand">
            <span className="rc-brand-mark">
              <Icon name="ledger" size={16} />
            </span>
            <span>
              Registre
              <small>Suivi crypto personnel</small>
            </span>
          </div>
          <nav className="rc-nav">
            {navItems.map((v) => (
              <button key={v.id} type="button" className="rc-nav-item" aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>
                <Icon name={v.icon} size={18} />
                {v.label}
                {v.badge ? <span className="rc-badge" aria-label={`${v.badge} alerte(s) déclenchée(s)`}>{v.badge}</span> : null}
                {v.dot ? <span className="rc-dirty" title="Modifications non sauvegardées" /> : null}
              </button>
            ))}
          </nav>
          <div className="rc-rail-foot">
            <StatusPill status={market.status} />
            <span>
              {market.refreshing ? (
                "Actualisation…"
              ) : market.updatedAt ? (
                <>
                  MAJ {fmtTime(market.updatedAt)}
                  {nextAt && (
                    <>
                      {" "}
                      · prochaine dans <Countdown target={nextAt} />
                    </>
                  )}
                </>
              ) : (
                "En attente des cours"
              )}
            </span>
            <span>Données CoinGecko · devise {currency}</span>
          </div>
        </aside>

        <div className="rc-main">
          <header className="rc-top">
            <div className="rc-brand">
              <span className="rc-brand-mark">
                <Icon name="ledger" size={16} />
              </span>
            </div>
            <h1 className="rc-top-title">{viewDef.title}</h1>
            <span className="rc-top-meta">
              {market.refreshing ? (
                "Actualisation…"
              ) : market.updatedAt ? (
                <>
                  MAJ {fmtTime(market.updatedAt)} · prochaine dans <Countdown target={nextAt} />
                </>
              ) : null}
            </span>
            <StatusPill status={market.status} />
            {unsaved && (
              <button type="button" className="rc-btn sm" onClick={exportJSON} title="Exporter une sauvegarde JSON" aria-label="Sauvegarder : modifications non exportées">
                <span className="rc-dirty" /> <span className="rc-hide-xs">Sauvegarder</span>
              </button>
            )}
            <button
              type="button"
              className="rc-icon-btn"
              onClick={() => refresh({ manual: true })}
              disabled={market.refreshing || rateLimited}
              aria-label="Actualiser les cours"
              title={rateLimited ? "Limite CoinGecko atteinte : patientez" : "Actualiser les cours"}
            >
              <Icon name="refresh" size={17} className={market.refreshing ? "rc-spin" : undefined} />
            </button>
          </header>

          <main className="rc-content">
            {market.status === "demo" && (
              <Banner tone="demo" title="Mode démonstration : cours simulés" action={retryButton}>
                CoinGecko n'a pas pu être joint ({describeError(market.error)}) et aucune donnée réelle n'a encore été reçue. Les prix, variations et
                graphiques affichés sont fictifs. Nouvel essai automatique dans <Countdown target={nextAt} />.
              </Banner>
            )}
            {market.status === "stale" && (
              <Banner tone="warn" title={`Données en cache du ${market.updatedAt ? fmtTime(market.updatedAt) : "—"}`} action={retryButton}>
                La dernière actualisation a échoué ({describeError(market.error)}). Les cours affichés sont les derniers reçus. Nouvel essai dans{" "}
                <Countdown target={nextAt} />.
              </Banner>
            )}
            {fxMissing && view !== "marche" && (
              <Banner tone="warn" title="Conversion de devise indisponible">
                Des transactions ou alertes sont libellées dans une autre devise que {currency} et le taux du jour n'a pas pu être obtenu : les montants
                concernés s'affichent « — ».
              </Banner>
            )}

            {view === "portefeuille" && (
              <PortfolioView
                currency={currency}
                transactions={transactions}
                priceMap={priceMap}
                conv={conv}
                marketStatus={market.status}
                pricesReady={pricesReady}
                loadHistory={loadHistory}
                period={period}
                setPeriod={setPeriod}
                onAdd={() => setDialog({ type: "tx" })}
                onEdit={(tx) => setDialog({ type: "tx", tx })}
                onDelete={deleteTransaction}
                onImport={() => setDialog({ type: "import", format: "csv" })}
                onExport={exportCSV}
                onSample={loadSample}
                fxNote={
                  needsFx && !fxMissing ? (
                    <p className="rc-footnote">
                      Montants saisis dans une autre devise convertis en {currency} au taux du jour
                      {rates && rates.source === "demo" ? " (taux simulés)" : " (CoinGecko)"}.
                    </p>
                  ) : null
                }
              />
            )}
            {view === "marche" && (
              <MarketView market={market} watchlist={watchlist} directory={directory} onToggleStar={toggleStar} onAlert={openAlert} remoteSearch={remoteSearch} />
            )}
            {view === "alertes" && (
              <AlertsView
                alerts={alerts}
                priceMap={priceMap}
                currency={currency}
                conv={conv}
                onNew={openAlert}
                onEdit={(a) => setDialog({ type: "alert", alert: a })}
                onDelete={deleteAlert}
                onRearm={rearmAlert}
              />
            )}
            {view === "parametres" && (
              <SettingsView
                settings={settings}
                onCurrency={(c) => setSettings((s) => ({ ...s, currency: c }))}
                onTheme={(t) => setSettings((s) => ({ ...s, theme: t }))}
                market={market}
                nextAt={nextAt}
                onRefresh={() => refresh({ manual: true })}
                onExportJSON={exportJSON}
                onImportJSON={() => setDialog({ type: "import", format: "json" })}
                onReset={resetAll}
                dirty={unsaved}
                lastBackupAt={saved.at}
                counts={{ transactions: transactions.length, watchlist: watchlist.length, alerts: alerts.length }}
              />
            )}
          </main>
        </div>
      </div>

      <nav className="rc-tabbar" aria-label="Navigation principale">
        {navItems.map((v) => (
          <button key={v.id} type="button" className="rc-tab" aria-current={view === v.id ? "page" : undefined} onClick={() => setView(v.id)}>
            <Icon name={v.icon} size={20} />
            {v.label}
            {v.badge ? <span className="rc-badge" aria-label={`${v.badge} alerte(s) déclenchée(s)`}>{v.badge}</span> : null}
            {v.dot ? <span className="rc-dirty" aria-label="Modifications non sauvegardées" /> : null}
          </button>
        ))}
      </nav>

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      {dialog && dialog.type === "tx" && (
        <Modal title={dialog.tx ? "Modifier la transaction" : "Nouvelle transaction"} onClose={() => setDialog(null)}>
          <TransactionForm
            initial={dialog.tx || null}
            preset={dialog.preset || null}
            currency={currency}
            options={pickerOptions}
            priceMap={priceMap}
            transactions={transactions}
            onRemoteSearch={remoteSearch}
            onSubmit={saveTransaction}
            onCancel={() => setDialog(null)}
          />
        </Modal>
      )}
      {dialog && dialog.type === "alert" && (
        <Modal title={dialog.alert ? "Modifier l'alerte" : "Nouvelle alerte de prix"} onClose={() => setDialog(null)}>
          <AlertForm
            initial={dialog.alert || null}
            presetCoin={dialog.coin || null}
            options={pickerOptions}
            priceMap={priceMap}
            currency={currency}
            onRemoteSearch={remoteSearch}
            onSubmit={saveAlert}
            onCancel={() => setDialog(null)}
          />
        </Modal>
      )}
      {dialog && dialog.type === "export" && (
        <Modal title={dialog.title} onClose={() => setDialog(null)} wide>
          <ExportPanel
            filename={dialog.filename}
            content={dialog.content}
            mime={dialog.mime}
            description={dialog.description}
            onDone={dialog.onDone}
            onClose={() => setDialog(null)}
          />
        </Modal>
      )}
      {dialog && dialog.type === "import" && (
        <Modal title={dialog.format === "csv" ? "Importer des transactions (CSV)" : "Importer une sauvegarde (JSON)"} onClose={() => setDialog(null)} wide>
          <ImportPanel
            format={dialog.format}
            analyze={dialog.format === "csv" ? analyzeImportCSV : analyzeImportJSON}
            onConfirm={dialog.format === "csv" ? confirmImportCSV : confirmImportJSON}
            onClose={() => setDialog(null)}
          />
        </Modal>
      )}
    </div>
  );
}
