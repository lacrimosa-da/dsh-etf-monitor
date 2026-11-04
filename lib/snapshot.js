/**
 * dsh-etf-monitor · 数据层（纯 Node，零第三方依赖）
 * ============================================================================
 * 与早期那套 Python 脚本（etf_monitor.py）同一套口径，逐项移植：
 *   - 东财 push2  ulist.np / clist / trends2   → 行情、板块、资金流、分时
 *   - 东财 push2his kline                       → 近 8 日成交额、上一交易日全天额
 *   - 东财 push2ex  ZTPool / DTPool             → 涨停 / 跌停家数（总数在 data.tc）
 *   - 腾讯 qt.gtimg.cn（GBK）                   → ETF IOPV 与溢价率（第 77/78 项）
 *
 * 移植时保留的几个坑（勿"优化"）：
 *   1. 东财 f71 是均价不是 IOPV，溢价率只能取腾讯第 77 项。
 *   2. ZTPool 的总数在 data.tc，不是 data.total；不带 dpt 参数会 rc:102。
 *   3. kline 必须带 end=20500101，否则 rc:102。
 *   4. 涨跌家数只能走 ulist.np，stock/get 对指数返回 "-"。
 *   5. ETF 跟踪指数的 secid 必须与 ETF 的 secid 一起请求，否则超额列全空。
 *   6. 东财批量接口偶尔会"整批返回空"（HTTP 200 但 data.diff 缺失或短于请求数），
 *      尤其并发十几条时。所以 fetchQuotes 采两段式：先小批并发，缺哪些再逐个补齐。
 * ============================================================================
 */

const UT = 'fa5fd1943c7b386f172d6893dbfba10b'
const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://quote.eastmoney.com/',
}

// (secid, 代码, 简称, 跟踪指数 secid 或 null, 分组)
export const ETF_LIST = [
  ['1.510300', '510300', '沪深300ETF', '1.000300', '宽基·沪深300'],
  ['1.510330', '510330', '300ETF华夏', '1.000300', '宽基·沪深300'],
  ['0.159919', '159919', '300ETF嘉实', '1.000300', '宽基·沪深300'],
  ['1.510310', '510310', '300ETF易方达', '1.000300', '宽基·沪深300'],
  ['1.510050', '510050', '上证50ETF', '1.000016', '宽基·上证50'],
  ['1.510500', '510500', '中证500ETF', '1.000905', '宽基·中证500'],
  ['1.512100', '512100', '中证1000ETF', '1.000852', '宽基·中证1000'],
  ['0.159845', '159845', '1000ETF', '1.000852', '宽基·中证1000'],
  ['1.588000', '588000', '科创50ETF', '1.000688', '宽基·科创50'],
  ['1.588080', '588080', '科创板50', '1.000688', '宽基·科创50'],
  ['0.159915', '159915', '创业板ETF', '0.399006', '宽基·创业板'],
  ['1.512880', '512880', '证券ETF', '0.399975', '行业·券商'],
  ['1.512480', '512480', '半导体ETF', '2.931865', '行业·半导体'],
  ['1.588200', '588200', '科创芯片ETF', '1.000685', '行业·半导体'],
  ['1.512010', '512010', '医药ETF', '1.000933', '行业·医药'],
]

export const INDEX_LIST = [
  ['1.000001', '上证指数'],
  ['0.399001', '深证成指'],
  ['0.399006', '创业板指'],
  ['1.000688', '科创50'],
  ['1.000300', '沪深300'],
  ['1.000905', '中证500'],
  ['1.000852', '中证1000'],
  ['1.000016', '上证50'],
]

export const OVERSEAS = [
  ['100.N225', '日经225'],
  ['100.KS11', '韩国KOSPI'],
  ['100.TWII', '台湾加权'],
  ['100.HSI', '恒生指数'],
  ['100.NDX', '纳指100'],
  ['100.SPX', '标普500'],
  ['100.DJIA', '道琼斯'],
]

const Q_FIELDS = 'f2,f3,f4,f5,f6,f12,f14,f15,f16,f17,f18,f62,f162,f184'
const TIMEOUT_MS = 15000
const RETRIES = 3
/** 单批塞多少个 secid。太小浪费轮次，太大容易整批被丢，20 是实测稳的值 */
const BATCH = 20

// ---------------------------------------------------------------- 基础取数

async function getText(url, enc = 'utf-8', timeout = TIMEOUT_MS) {
  let last
  for (let i = 0; i < RETRIES; i += 1) {
    try {
      const res = await fetch(url, {
        headers: UA,
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
      const buf = Buffer.from(await res.arrayBuffer())
      return new TextDecoder(enc).decode(buf)
    } catch (e) {
      last = e
      if (i < RETRIES - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
  }
  throw last
}

async function getJson(url, opts) {
  return JSON.parse(await getText(url, 'utf-8', opts?.timeout))
}

/** 单批行情请求，返回 {code: row}；失败或无数据都返回空对象 */
async function quoteBatch(secids) {
  const out = {}
  if (!secids.length) return out
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=' +
    encodeURIComponent(secids.join(',')) +
    '&fields=' + Q_FIELDS + '&ut=' + UT
  try {
    const d = await getJson(url)
    for (const row of d?.data?.diff ?? []) {
      if (row && row.f12 != null) out[String(row.f12)] = row
    }
  } catch (_) {
    /* 交给上层的补齐逻辑 */
  }
  return out
}

/**
 * 批量取行情。两段式：
 *   ① 按 BATCH 切块并发；
 *   ② 把没拿到的代码逐个单发补齐（最多补两轮，避免极端情况下无限重试）。
 * 这样即使东财偶尔整批丢数据，页面也不会出现「价格 null 但溢价率有值」的撕裂状态。
 */
async function fetchQuotes(secids) {
  const uniq = [...new Set(secids)]
  const got = {}
  const chunks = []
  for (let i = 0; i < uniq.length; i += BATCH) chunks.push(uniq.slice(i, i + BATCH))

  const results = await Promise.all(chunks.map((c) => quoteBatch(c)))
  for (const r of results) Object.assign(got, r)

  const codeOf = (secid) => secid.split('.')[1]
  for (let round = 0; round < 2; round += 1) {
    const missing = uniq.filter((s) => !got[codeOf(s)])
    if (!missing.length) break
    const retry = await Promise.all(missing.map((s) => quoteBatch([s])))
    for (const r of retry) Object.assign(got, r)
  }
  return got
}

/** 腾讯 ETF 行情：GBK，第 77 项是溢价率、第 78 项是 IOPV */
async function tencentEtf(code) {
  const mkt = code.startsWith('5') ? 'sh' : 'sz'
  try {
    const txt = await getText(`https://qt.gtimg.cn/q=${mkt}${code}`, 'gbk', 10000)
    const p = txt.split('~')
    if (p.length < 82) return null
    const f = (i, d = 0) => {
      const v = p[i]
      return v === '' || v === '-' || v === undefined ? d : Number(v)
    }
    return {
      price: f(3),
      prevclose: f(4),
      chg_pct: f(32),
      amount_wan: f(37),
      iopv: f(78),
      premium: f(77),
      nav_y: f(81),
    }
  } catch (_) {
    return null
  }
}

/** 分时：行 = 时间,开,收,高,低,量,额 */
async function fetchTrends(secid, ndays = 1) {
  const url =
    'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=' + ndays + '&iscr=0&ut=' + UT
  const d = await getJson(url)
  const rows = []
  for (const line of d?.data?.trends ?? []) {
    const a = String(line).split(',')
    if (a.length < 7) continue
    rows.push({
      t: a[0].slice(-5),
      price: Number(a[2]),
      vol: Number(a[5] || 0),
      amt: Number(a[6] || 0),
    })
  }
  return { preClose: d?.data?.preClose, rows }
}

/** 涨跌家数：只能走 ulist.np，stock/get 对指数返回 "-" */
async function fetchBreadth() {
  const res = { 沪: [0, 0, 0], 深: [0, 0, 0] }
  const int = (v) => {
    const n = Number.parseFloat(v)
    return Number.isFinite(n) ? Math.trunc(n) : 0
  }
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2' +
    '&secids=1.000001,0.399001&fields=f12,f14,f104,f105,f106&ut=' + UT
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const d = await getJson(url)
      const diff = d?.data?.diff ?? []
      if (diff.length) {
        for (const row of diff) {
          const key = String(row.f12) === '000001' ? '沪' : '深'
          res[key] = [int(row.f104), int(row.f105), int(row.f106)]
        }
        return res
      }
    } catch (_) {
      /* 下一轮再试 */
    }
  }
  return res
}

/** 涨停 / 跌停家数：总数在 data.tc，不带 dpt 会 rc:102 */
async function fetchZt() {
  const now = new Date()
  const today =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0')
  const out = { zt: null, dt: null }
  const jobs = [
    ['zt', 'getTopicZTPool'],
    ['dt', 'getTopicDTPool'],
  ]
  const vals = await Promise.all(
    jobs.map(async ([key, api]) => {
      const url =
        `https://push2ex.eastmoney.com/${api}?ut=7eea3edcaed734bea9cbfc24409ed989` +
        `&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=${today}`
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const d = await getJson(url)
          const tc = d?.data?.tc
          if (tc != null) return [key, tc]
        } catch (_) {
          /* 下一轮再试 */
        }
      }
      return [key, null]
    }),
  )
  for (const [k, v] of vals) out[k] = v
  return out
}

/** 日线：kline 必须带 end=20500101，否则 rc:102 */
async function fetchKline(secid, n = 8) {
  try {
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
      `&klt=101&fqt=0&lmt=${n}&end=20500101` +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&ut=' + UT
    const d = await getJson(url)
    const out = []
    for (const line of d?.data?.klines ?? []) {
      const a = String(line).split(',')
      out.push([a[0], Number(a[2]), Number(a[6])])
    }
    return out
  } catch (_) {
    return []
  }
}

/** 上一交易日全天成交额（元），用于当日量比推定 */
async function fetchPrevAmt(secid) {
  const kl = await fetchKline(secid, 3)
  if (kl.length < 2) return null
  const today = dateKey(new Date())
  if (kl[kl.length - 1][0] === today) return kl[kl.length - 2][2]
  return kl[kl.length - 1][2]
}

/** 行业 / 概念板块涨跌前列 */
async function fetchBoards(kind = 'industry', n = 10) {
  const fs = kind === 'industry' ? 'm:90+t:2' : 'm:90+t:3'
  const base =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + n +
    '&np=1&fltt=2&invt=2&fid=f3&fs=' + fs +
    '&fields=f12,f14,f3,f62,f104,f105&ut=' + UT
  const pick = (d) =>
    (d?.data?.diff ?? []).map((r) => ({ name: r.f14, chg: r.f3, mf: r.f62 }))
  const [up, dn] = await Promise.all([
    getJson(base + '&po=1').then(pick).catch(() => []),
    getJson(base + '&po=0').then(pick).catch(() => []),
  ])
  return [up, dn]
}

/** 全市场 ETF 主力净额排行 */
async function fetchEtfFlowRank(n = 12) {
  const base =
    'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=' + n +
    '&np=1&fltt=2&invt=2&fid=f62&fs=b:MK0021' +
    '&fields=f12,f14,f3,f6,f62&ut=' + UT
  const pick = (d) =>
    (d?.data?.diff ?? []).map((r) => ({
      code: r.f12,
      name: r.f14,
      chg: r.f3,
      amt: r.f6,
      mf: r.f62,
    }))
  const [up, dn] = await Promise.all([
    getJson(base + '&po=1').then(pick).catch(() => []),
    getJson(base + '&po=0').then(pick).catch(() => []),
  ])
  return [up, dn]
}

// ---------------------------------------------------------------- 计算

function dateKey(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

function tsKey(d) {
  return (
    dateKey(d) +
    ' ' +
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0')
  )
}

/** 已交易分钟：上午 9:30-11:30 = 120，下午 13:00-15:00 = 120 */
export function tradedMinutes(now = new Date()) {
  const t = now.getHours() * 60 + now.getMinutes()
  let m = 0
  if (t >= 570) m += Math.min(120, t - 570 + 1)
  if (t >= 780) m = 120 + Math.min(120, t - 780 + 1)
  if (t >= 900) m = 240
  return Math.max(0, Math.min(240, m))
}

function marketState(now, mins) {
  const t = now.getHours() * 60 + now.getMinutes()
  if (mins === 0) return '盘前'
  if (t >= 690 && t < 780) return '午间休市'
  if (mins >= 240) return '已收盘'
  return '交易中'
}

/** 30 分钟一桶，9:30 起锚；11:30 收盘集合竞价那笔并入 11:00 桶 */
function buildBuckets(rows) {
  const bucketOf = (mi) => {
    if (mi < 780) return Math.min(3, Math.max(0, Math.floor((mi - 570) / 30)))
    return 4 + Math.min(3, Math.max(0, Math.floor((mi - 780) / 30)))
  }
  const agg = new Map()
  for (const row of rows) {
    const [hh, mm] = row.t.split(':')
    const b = bucketOf(Number(hh) * 60 + Number(mm))
    const cur = agg.get(b) ?? { amt: 0, price: null, vol: 0 }
    cur.amt += row.amt
    cur.price = row.price
    cur.vol += row.vol
    agg.set(b, cur)
  }
  const out = []
  for (const b of [...agg.keys()].sort((x, y) => x - y)) {
    const key = b < 4 ? 570 + b * 30 : 780 + (b - 4) * 30
    const v = agg.get(b)
    out.push({
      key,
      amt: v.amt,
      price: v.price,
      vol: v.vol,
      label: String(Math.floor(key / 60)).padStart(2, '0') + ':' + String(key % 60).padStart(2, '0'),
    })
  }
  return out
}

/** 护盘脉冲：单分钟成交额 ≥ 当日已过分钟均量的 4 倍 */
function buildPulses(rows) {
  const positive = rows.filter((r) => r.amt > 0).map((r) => r.amt)
  if (!positive.length) return []
  const mean = positive.reduce((a, b) => a + b, 0) / positive.length
  const thr = mean * 4
  if (!(thr > 0)) return []
  return rows
    .filter((r) => r.amt >= thr)
    .map((r) => ({ t: r.t, amt: r.amt, price: r.price, x: Number((r.amt / mean).toFixed(1)) }))
    .slice(-8)
}

// ---------------------------------------------------------------- 主流程

/**
 * 取一轮全量快照。
 * @param {{onNote?: (s: string) => void}} [opts]
 */
export async function takeSnapshot(opts = {}) {
  const note = opts.onNote ?? (() => {})
  const now = new Date()
  const mins = tradedMinutes(now)
  const state = marketState(now, mins)

  const allSecids = [
    ...ETF_LIST.map((e) => e[0]),
    ...ETF_LIST.map((e) => e[3]).filter(Boolean),
    ...INDEX_LIST.map((i) => i[0]),
    ...OVERSEAS.map((o) => o[0]),
  ]
  note(`拉取 ${new Set(allSecids).size} 个标的行情`)

  // 行情、分时、宽度、涨跌停、板块、资金流、日线全部并行
  const [q, trendRes, br, zt, indPair, conPair, flowPair, hist510] = await Promise.all([
    fetchQuotes(allSecids),
    fetchTrends('1.510300').catch(() => ({ preClose: null, rows: [] })),
    fetchBreadth(),
    fetchZt(),
    fetchBoards('industry', 10),
    fetchBoards('concept', 10),
    fetchEtfFlowRank(12),
    fetchKline('1.510300', 8),
  ])

  // 量比基线全并行
  const prevAmts = await Promise.all(
    ETF_LIST.map((e) => fetchPrevAmt(e[0]).catch(() => null)),
  )

  // 腾讯 IOPV 全并行
  const tqs = await Promise.all(ETF_LIST.map((e) => tencentEtf(e[1])))

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  /** ulist.np 的键是 6 位代码；跟踪指数如 000300 与上证指数 000001 会撞，故用 secid 精确取 */
  const bySecid = (secid) => q[secid.split('.')[1]] ?? {}

  const etf = ETF_LIST.map(([secid, code, short, idxSecid, group], i) => {
    const r = q[code] ?? {}
    const tq = tqs[i] ?? {}
    const price = num(r.f2)
    const chg = num(r.f3)
    const amt = num(r.f6) ?? 0
    let idxChg = null
    if (idxSecid) idxChg = num(bySecid(idxSecid).f3)
    const excess = chg != null && idxChg != null ? Number((chg - idxChg).toFixed(3)) : null
    let estRatio = null
    const prevFull = prevAmts[i]
    if (mins > 0 && prevFull) {
      estRatio = Number((amt / ((prevFull * mins) / 240)).toFixed(2))
    }
    return {
      code,
      name: short || r.f14 || '',
      group,
      price,
      chg,
      amt_day: amt,
      mf: num(r.f62) ?? 0,
      idx_chg: idxChg,
      excess,
      est_ratio: estRatio,
      iopv: tq.iopv ?? null,
      premium: tq.premium ?? null,
      nav_y: tq.nav_y ?? null,
    }
  })

  const idx = INDEX_LIST.map(([secid, name]) => {
    const r = bySecid(secid)
    return { name, price: num(r.f2), chg: num(r.f3), amt: num(r.f6) ?? 0 }
  })

  const ovs = OVERSEAS.map(([secid, name]) => {
    const r = bySecid(secid)
    return { name, price: num(r.f2), chg: num(r.f3) }
  })

  const buckets = buildBuckets(trendRes.rows)
  const pulses = buildPulses(trendRes.rows)

  const snap = {
    ts: tsKey(now),
    date: dateKey(now),
    minutes: mins,
    state,
    etf,
    idx,
    ovs,
    buckets,
    pulses,
    breadth: br,
    zt,
    ind_up: indPair[0],
    ind_dn: indPair[1],
    con_up: conPair[0],
    con_dn: conPair[1],
    flow_up: flowPair[0],
    flow_dn: flowPair[1],
    preclose_510300: trendRes.preClose ?? null,
    hist510300: hist510.map((k) => ({ date: k[0].slice(5), amt: k[2] })),
    etf_full: Object.fromEntries(etf.map((e) => [e.code, { amt_day: e.amt_day, chg: e.chg }])),
  }
  return snap
}

/** 单行摘要，写日志用 */
export function summarize(snap) {
  const first = snap.etf?.[0] ?? {}
  const yi = (v) => ((v ?? 0) / 1e8).toFixed(1)
  const sign = (first.chg ?? 0) >= 0 ? '+' : ''
  return (
    `状态=${snap.state} 已过分钟=${snap.minutes} ` +
    `510300=${(first.price ?? 0).toFixed(3)} (${sign}${(first.chg ?? 0).toFixed(2)}%) ` +
    `成交额=${yi(first.amt_day)}亿`
  )
}
