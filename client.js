/**
 * dsh-etf-monitor —— 浏览器半端（DSH 面板内的「国家队 ETF 盘中监测」）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本（约定与 dsh-close-clock / dsh-pet 一致）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                      // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject: ['slots'], apply(ctx) { ... } }),
 *     })
 *
 * ⭐ 挂载点两个，id 必须一致（侧栏按钮靠 list id 找主面板）：
 *     main                key  = 'etf-monitor'   ← 主区域整页
 *     sidebar.panellist   id   = 'etf-monitor'   ← 左侧导航图标
 *
 * ⭐ 数据只走同源接口 /dsh-etf-monitor/api（宿主半侧用 Node 原生 fetch 直取
 *    东财/腾讯，页面自己不发任何跨域请求，也就不存在 CORS 与 GBK 解码问题）。
 *
 * ⭐ 涨红跌绿（A 股习惯）：涨 #d4380d / 跌 #0e8a4f。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-etf-monitor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'etf-monitor'
    const API = '/dsh-etf-monitor/api'

    // ── 配色（明暗两套，文字/底色全部写死高对比色，不再赌主题 token） ──────
    // 教训：旧版 SURF/SOFT 用了两个**不存在**的 token
    //   --dsw-alias-surface-overlay / --dsw-alias-surface-sunken
    // 取不到值就落到 fallback 的 #ffffff / #f7f8fa；而文字用的是真实存在的
    // --dsw-alias-label-primary，深色主题下它是浅色的 —— 结果「白底 + 浅字」，
    // 什么都看不清。现在按 theme.getTheme().active.colorScheme 二选一，
    // 底色、正文、次要字、分隔线全部显式给值，不依赖任何 token 是否存在。
    const PALETTE = {
      light: {
        up: '#cf1322', dn: '#0b7a43',
        c1: '#16181d', c2: '#3f444d', c3: '#585f6a',
        border: '#d2d7df', surf: '#ffffff', soft: '#f1f3f6', page: '#f1f3f6',
        warn: 'rgba(207,19,34,0.09)', warnBorder: 'rgba(207,19,34,0.32)', warnText: '#8f0f1b',
      },
      dark: {
        up: '#ff6b5e', dn: '#33d17a',
        c1: '#f3f5f8', c2: '#c6ccd6', c3: '#9ba4b3',
        border: '#3b4250', surf: '#1d2026', soft: '#24272e', page: '#16181d',
        warn: 'rgba(255,107,94,0.13)', warnBorder: 'rgba(255,107,94,0.40)', warnText: '#ffb7b0',
      },
    }

    let UP = PALETTE.light.up
    let DN = PALETTE.light.dn
    let C1 = PALETTE.light.c1
    let C2 = PALETTE.light.c2
    let C3 = PALETTE.light.c3
    let BORDER = PALETTE.light.border
    let SURF = PALETTE.light.surf
    let SOFT = PALETTE.light.soft
    let PAGE = PALETTE.light.page
    let WARN = PALETTE.light.warn
    let WARN_BORDER = PALETTE.light.warnBorder
    let WARN_TEXT = PALETTE.light.warnText

    function applyScheme(scheme) {
      const p = PALETTE[scheme === 'dark' ? 'dark' : 'light']
      UP = p.up; DN = p.dn; C1 = p.c1; C2 = p.c2; C3 = p.c3
      BORDER = p.border; SURF = p.surf; SOFT = p.soft; PAGE = p.page
      WARN = p.warn; WARN_BORDER = p.warnBorder; WARN_TEXT = p.warnText
      buildStyles()
    }

    const SLOTS = ['09:30', '10:00', '10:30', '11:00', '13:00', '13:30', '14:00', '14:30']

    // ── 格式化 ───────────────────────────────────────────────────────────
    const fx = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—')
    const pct = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(d) + '%' : '—')
    const yi = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? (v / 1e8).toFixed(d) + '亿' : '—')
    const yiSign = (v, d = 2) => {
      if (typeof v !== 'number' || !isFinite(v)) return '—'
      return (v > 0 ? '+' : '') + (v / 1e8).toFixed(d) + '亿'
    }
    const tone = (v) => (typeof v !== 'number' || !isFinite(v) || v === 0 ? C2 : v > 0 ? UP : DN)

    // ── 通用小件 ─────────────────────────────────────────────────────────
    const card = (extra) => ({
      background: SURF,
      border: '1px solid ' + BORDER,
      borderRadius: '10px',
      padding: '14px 16px',
      ...extra,
    })

    // 表格样式随主题重建（字体比旧版整体放大一档，数字显式给 C1 深色）
    let thStyle = null
    let thLeft = null
    let tdStyle = null
    let tdLeft = null

    function buildStyles() {
      thStyle = {
        textAlign: 'right',
        fontWeight: 600,
        fontSize: '12px',
        color: C2,
        padding: '0 9px 8px',
        whiteSpace: 'nowrap',
        borderBottom: '1.5px solid ' + BORDER,
      }
      thLeft = { ...thStyle, textAlign: 'left' }
      tdStyle = {
        textAlign: 'right',
        padding: '7px 9px',
        borderBottom: '1px solid ' + BORDER,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        color: C1,
      }
      tdLeft = { ...tdStyle, textAlign: 'left' }
    }
    buildStyles()

    function Section(props) {
      return h(
        'section',
        { style: { marginBottom: '16px' } },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '10px',
              margin: '0 0 8px 2px',
            },
          },
          h('div', { style: { fontSize: '14.5px', fontWeight: 700, color: C1, letterSpacing: '0.2px' } }, props.title),
          props.hint
            ? h('div', { style: { fontSize: '12px', color: C2 } }, props.hint)
            : null,
        ),
        props.children,
      )
    }

    function StatCard(props) {
      return h(
        'div',
        { style: card({ padding: '12px 14px', minWidth: 0 }) },
        h('div', { style: { fontSize: '12px', color: C2, marginBottom: '5px', whiteSpace: 'nowrap' } }, props.label),
        h(
          'div',
          {
            style: {
              fontSize: props.small ? '20px' : '26px',
              fontWeight: 700,
              lineHeight: 1.15,
              color: props.tone || C1,
              fontVariantNumeric: 'tabular-nums',
            },
          },
          props.value,
        ),
        props.sub
          ? h('div', { style: { fontSize: '12px', color: C2, marginTop: '5px', lineHeight: 1.5 } }, props.sub)
          : null,
      )
    }

    // ── 分时桶图（成交额柱 + 均价折线） ──────────────────────────────────
    function SvgBuckets(props) {
      const buckets = props.buckets || []
      const W = 760
      const H = 214
      const PADL = 6
      const PADR = 6
      const PADT = 20
      const PADB = 36
      if (!buckets.length) {
        return h('div', { style: { fontSize: '13px', color: C2, padding: '24px 0' } }, '暂无分时数据')
      }
      const byLabel = {}
      buckets.forEach((b) => { byLabel[b.label] = b })
      const maxAmt = Math.max.apply(null, buckets.map((b) => b.amt || 0).concat([1]))
      const prices = buckets.map((b) => b.price).filter((v) => typeof v === 'number')
      const pmin = prices.length ? Math.min.apply(null, prices) : 0
      const pmax = prices.length ? Math.max.apply(null, prices) : 0
      const span = pmax - pmin || 0.01
      const plotH = H - PADT - PADB
      const slotW = (W - PADL - PADR) / SLOTS.length
      const barW = slotW * 0.5
      const kids = []

      // 50% 参考线
      kids.push(
        h('line', {
          key: 'grid',
          x1: PADL, x2: W - PADR,
          y1: PADT + plotH * 0.5, y2: PADT + plotH * 0.5,
          stroke: BORDER, strokeDasharray: '3 4',
        }),
      )

      SLOTS.forEach((label, i) => {
        const b = byLabel[label]
        const x0 = PADL + slotW * i
        const cx = x0 + slotW / 2
        if (!b) {
          kids.push(
            h('text', {
              key: 'e' + i, x: cx, y: PADT + plotH - 6,
              textAnchor: 'middle', fontSize: '11.5px', fill: C3,
            }, '—'),
          )
        } else {
          const amt = b.amt || 0
          const bh = Math.max(2, plotH * (amt / maxAmt))
          const isBig = amt >= maxAmt * 0.9
          kids.push(
            h('rect', {
              key: 'b' + i,
              x: cx - barW / 2, y: PADT + plotH - bh,
              width: barW, height: bh, rx: 2,
              fill: isBig ? 'rgba(212,56,13,0.55)' : 'rgba(140,150,165,0.35)',
            }),
          )
          kids.push(
            h('text', {
              key: 'v' + i, x: cx, y: PADT + plotH - bh - 4,
              textAnchor: 'middle', fontSize: '11.5px', fill: C2,
              fontVariantNumeric: 'tabular-nums',
            }, (amt / 1e8).toFixed(1)),
          )
          if (typeof b.price === 'number') {
            const py = PADT + plotH * (1 - (b.price - pmin) / span)
            kids.push(
              h('circle', { key: 'p' + i, cx: cx, cy: py, r: 2.6, fill: UP }),
            )
            kids.push(
              h('text', {
                key: 'pt' + i, x: cx, y: py - 7,
                textAnchor: 'middle', fontSize: '10.5px', fill: UP,
                fontVariantNumeric: 'tabular-nums',
              }, b.price.toFixed(3)),
            )
          }
        }
        kids.push(
          h('text', {
            key: 'l' + i, x: cx, y: H - PADB + 15,
            textAnchor: 'middle', fontSize: '11.5px', fill: C3,
          }, label),
        )
        kids.push(
          h('line', {
            key: 's' + i, x1: cx, x2: cx, y1: H - PADB + 20, y2: H - PADB + 24,
            stroke: BORDER,
          }),
        )
      })

      // 上午/下午分隔
      const sepX = PADL + slotW * 4
      kids.push(h('line', { key: 'noon', x1: sepX, x2: sepX, y1: PADT, y2: H - PADB, stroke: BORDER }))

      return h(
        'div',
        { style: card({ padding: '10px 12px 4px' }) },
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 'auto', display: 'block' } }, kids),
        h(
          'div',
          { style: { fontSize: '11.5px', color: C2, padding: '2px 4px 6px' } },
          '柱＝该半小时成交额（亿元，数字在柱顶）· 点＝该桶收在的价位 · 竖线＝午间休市',
        ),
      )
    }

    // ── 近 8 日成交额 ────────────────────────────────────────────────────
    function SvgHist(props) {
      const rows = props.rows || []
      const W = 760
      const H = 172
      const PADL = 6
      const PADR = 6
      const PADT = 18
      const PADB = 26
      if (!rows.length) return h('div', { style: { fontSize: '13px', color: C2, padding: '20px 0' } }, '暂无历史数据')
      const maxAmt = Math.max.apply(null, rows.map((r) => r.amt || 0).concat([1]))
      const plotH = H - PADT - PADB
      const slotW = (W - PADL - PADR) / rows.length
      const barW = slotW * 0.54
      const kids = []
      rows.forEach((r, i) => {
        const amt = r.amt || 0
        const bh = Math.max(2, plotH * (amt / maxAmt))
        const cx = PADL + slotW * (i + 0.5)
        const top = amt >= maxAmt * 0.995
        kids.push(
          h('rect', {
            key: 'b' + i,
            x: cx - barW / 2, y: PADT + plotH - bh,
            width: barW, height: bh, rx: 2,
            fill: top ? 'rgba(212,56,13,0.6)' : 'rgba(140,150,165,0.35)',
          }),
        )
        kids.push(
          h('text', {
            key: 'v' + i, x: cx, y: PADT + plotH - bh - 4,
            textAnchor: 'middle', fontSize: '11.5px', fill: C2,
          }, (amt / 1e8).toFixed(0)),
        )
        kids.push(
          h('text', {
            key: 'l' + i, x: cx, y: H - PADB + 15,
            textAnchor: 'middle', fontSize: '11.5px', fill: C3,
          }, r.date),
        )
      })
      return h(
        'div',
        { style: card({ padding: '10px 12px 4px' }) },
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { width: '100%', height: 'auto', display: 'block' } }, kids),
        h('div', { style: { fontSize: '10.5px', color: C3, padding: '2px 4px 6px' } }, '510300 近 8 个交易日成交额（亿元）'),
      )
    }

    // ── 表格 ─────────────────────────────────────────────────────────────
    function BasketTable(props) {
      const rows = props.rows || []
      return h(
        'div',
        { style: card({ padding: '10px 6px 4px', overflowX: 'auto' }) },
        h(
          'table',
          { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13.5px', minWidth: '860px' } },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: thLeft }, '代码'),
              h('th', { style: thLeft }, '名称'),
              h('th', { style: thLeft }, '组别'),
              h('th', { style: thStyle }, '现价'),
              h('th', { style: thStyle }, '涨跌幅'),
              h('th', { style: thStyle }, '成交额'),
              h('th', { style: thStyle }, '量比推定'),
              h('th', { style: thStyle }, '主力净额'),
              h('th', { style: thStyle }, '超额'),
              h('th', { style: thStyle }, '溢价率'),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                { key: r.code },
                h('td', { style: { ...tdLeft, color: C2, fontVariantNumeric: 'tabular-nums' } }, r.code),
                h('td', { style: { ...tdLeft, color: C1 } }, r.name),
                h('td', { style: { ...tdLeft, color: C2, fontSize: '12px' } }, r.group || '—'),
                h('td', { style: tdStyle }, fx(r.price, 3)),
                h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                h('td', { style: tdStyle }, yi(r.amt_day, 1)),
                h(
                  'td',
                  {
                    style: {
                      ...tdStyle,
                      color: typeof r.est_ratio === 'number' && r.est_ratio >= 1 ? UP : C1,
                      fontWeight: typeof r.est_ratio === 'number' && r.est_ratio >= 1 ? 600 : 400,
                    },
                  },
                  typeof r.est_ratio === 'number' ? r.est_ratio.toFixed(2) + '×' : '—',
                ),
                h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)),
                h('td', { style: { ...tdStyle, color: tone(r.excess) } }, pct(r.excess)),
                h(
                  'td',
                  {
                    style: {
                      ...tdStyle,
                      color: typeof r.premium === 'number' && Math.abs(r.premium) >= 0.05 ? UP : C2,
                    },
                  },
                  typeof r.premium === 'number' ? pct(r.premium) : '—',
                ),
              ),
            ),
          ),
        ),
      )
    }

    function IndexRow(props) {
      return h(
        'tr',
        null,
        h('td', { style: { ...tdLeft, color: C1 } }, props.name),
        h('td', { style: tdStyle }, fx(props.price, props.digits || 2)),
        h('td', { style: { ...tdStyle, color: tone(props.chg), fontWeight: 600 } }, pct(props.chg)),
        props.amt != null ? h('td', { style: { ...tdStyle, color: C2 } }, yi(props.amt, 0)) : null,
      )
    }

    function MiniTable(props) {
      return h(
        'div',
        { style: card({ padding: '10px 6px 4px', overflowX: 'auto' }) },
        h(
          'table',
          { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13.5px' } },
          h('thead', null, h('tr', null, props.head.map((hh, i) => h('th', { key: i, style: i === 0 ? thLeft : thStyle }, hh)))),
          h('tbody', null, props.children),
        ),
      )
    }

    // ── 四大判读 ─────────────────────────────────────────────────────────
    function Readout(props) {
      const snap = props.snap || {}
      const etf0 = (snap.etf || [])[0] || {}
      const br = snap.breadth || {}
      const sh = br['沪'] || [0, 0, 0]
      const sz = br['深'] || [0, 0, 0]
      const upN = (sh[0] || 0) + (sz[0] || 0)
      const dnN = (sh[1] || 0) + (sz[1] || 0)
      const ratio = upN + dnN > 0 ? upN / (upN + dnN) : null
      const zt = snap.zt || {}
      const ratioV = etf0.est_ratio
      const ratioTag =
        typeof ratioV !== 'number' ? '—' : ratioV >= 1 ? '放量' : ratioV >= 0.7 ? '温和' : '缩量'
      const prem = etf0.premium
      const premTag =
        typeof prem !== 'number' ? '—' : prem >= 0.05 ? '溢价·有申购顶价' : prem <= -0.05 ? '折价' : '基本平'

      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: '10px' } },
        h(StatCard, {
          label: '510300 量比推定',
          value: typeof ratioV === 'number' ? ratioV.toFixed(2) + '×' : '—',
          tone: typeof ratioV === 'number' && ratioV >= 1 ? UP : C1,
          sub: ratioTag + ' · 今日 ' + yi(etf0.amt_day, 1) + ' · 主力 ' + yiSign(etf0.mf),
        }),
        h(StatCard, {
          label: '护盘脉冲（≥4× 均量）',
          value: (snap.pulses || []).length + ' 次',
          tone: (snap.pulses || []).length >= 4 ? UP : C1,
          sub: (snap.pulses || []).length
            ? '最近 ' + snap.pulses[0].t + ' ' + yi(snap.pulses[0].amt, 2)
            : '本轮无单分钟异常放量',
        }),
        h(StatCard, {
          label: '510300 溢价率',
          value: typeof prem === 'number' ? pct(prem) : '—',
          tone: typeof prem === 'number' && prem >= 0.05 ? UP : C1,
          sub:
            'IOPV ' + fx(etf0.iopv, 4) + ' · 现价 ' + fx(etf0.price, 3) + ' · ' + premTag,
        }),
        h(StatCard, {
          label: '涨跌家数',
          value: upN + ' / ' + dnN,
          small: true,
          tone: ratio != null && ratio >= 0.5 ? UP : DN,
          sub:
            (ratio != null ? '上涨占比 ' + (ratio * 100).toFixed(0) + '%' : '—') +
            ' · 涨停 ' + (zt.zt != null ? zt.zt : '—') +
            ' · 跌停 ' + (zt.dt != null ? zt.dt : '—'),
        }),
      )
    }

    // ── 主面板 ───────────────────────────────────────────────────────────
    function Panel() {
      const [snap, setSnap] = useState(null)
      const [meta, setMeta] = useState({ loading: true, error: null, cachedAt: null, stale: false })
      const [auto, setAuto] = useState(true)
      const [seq, setSeq] = useState(0)

      const load = useCallback(async (force) => {
        setMeta((m) => ({ ...m, loading: true }))
        try {
          const r = await fetch(API + (force ? '?fresh=1' : ''), { cache: 'no-store' })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || 'HTTP ' + r.status)
          setSnap(j.snap)
          setMeta({ loading: false, error: j.stale ? j.error : null, cachedAt: j.cachedAt, stale: !!j.stale })
        } catch (e) {
          setMeta((m) => ({ ...m, loading: false, error: String((e && e.message) || e) }))
        }
      }, [])

      useEffect(() => { load(false) }, [load])

      useEffect(() => {
        if (!auto) return undefined
        const t = setInterval(() => setSeq((x) => x + 1), 60000)
        return () => clearInterval(t)
      }, [auto])

      useEffect(() => { if (seq > 0) load(true) }, [seq, load])

      const state = snap ? snap.state : '读取中'
      const stateTone = state === '交易中' ? UP : state === '已收盘' ? C2 : C2

      const head = h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
            padding: '0 0 14px',
          },
        },
        h('div', { style: { fontSize: '20px', fontWeight: 700, color: C1, letterSpacing: '0.3px' } }, '国家队 ETF 盘中监测'),
        h(
          'span',
          {
            style: {
              fontSize: '12px', fontWeight: 600, padding: '2px 9px', borderRadius: '999px',
              border: '1px solid ' + BORDER, color: stateTone, background: SOFT,
            },
          },
          state,
        ),
        snap
          ? h('span', { style: { fontSize: '12.5px', color: C2 } },
              snap.ts + ' · 已过 ' + snap.minutes + '/240 分钟')
          : null,
        h('div', { style: { flex: 1 } }),
        h(
          'button',
          {
            onClick: () => setAuto((v) => !v),
            style: {
              fontSize: '13px', fontWeight: 600, padding: '6px 12px', borderRadius: '7px', cursor: 'pointer',
              border: '1px solid ' + BORDER, background: auto ? SOFT : SURF, color: C2,
            },
            title: '交易时段内每 60 秒重新取数',
          },
          auto ? '自动刷新：开' : '自动刷新：关',
        ),
        h(
          'button',
          {
            onClick: () => load(true),
            disabled: meta.loading,
            style: {
              fontSize: '13px', fontWeight: 600, padding: '6px 14px', borderRadius: '7px',
              cursor: meta.loading ? 'default' : 'pointer',
              border: '1px solid ' + BORDER, background: SURF, color: C1,
              opacity: meta.loading ? 0.55 : 1,
            },
          },
          meta.loading ? '取数中…' : '刷新',
        ),
      )

      const banner = meta.error
        ? h(
            'div',
            {
              style: {
                margin: '0 0 14px', padding: '9px 12px', borderRadius: '8px',
                background: WARN, border: '1px solid ' + WARN_BORDER,
                color: WARN_TEXT, fontSize: '13px', lineHeight: 1.55, wordBreak: 'break-word',
              },
            },
            (meta.stale ? '这一轮取数失败，下面是上一轮缓存。' : '取数失败：') + meta.error,
          )
        : null

      if (!snap) {
        return h(
          'div',
          { style: { padding: '22px 26px' } },
          head,
          banner,
          h('div', { style: { fontSize: '14px', color: C2, padding: '40px 0' } },
            meta.loading ? '首次取数中，约 5–15 秒（东财 + 腾讯共二十来个请求）…' : '暂无数据'),
        )
      }

      const pulseRows = (snap.pulses || []).map((p) =>
        h(
          'tr',
          { key: p.t },
          h('td', { style: { ...tdLeft, fontVariantNumeric: 'tabular-nums', color: C1 } }, p.t),
          h('td', { style: tdStyle }, yi(p.amt, 2)),
          h('td', { style: tdStyle }, fx(p.price, 3)),
          h('td', { style: { ...tdStyle, color: C2 } }, '第 ' + (typeof p.x === 'number' ? p.x + 1 : '—') + ' 分钟'),
        ),
      )

      return h(
        'div',
        {
          style: {
            height: '100%', overflowY: 'auto', overflowX: 'hidden', color: C1,
            padding: '18px 22px 40px', boxSizing: 'border-box', background: PAGE,
            fontSize: '14px',
          },
        },
        head,
        banner,

        h(Section, { title: '四项判读', hint: '量比 / 脉冲 / 溢价 / 宽度' }, h(Readout, { snap })),

        h(
          Section,
          { title: '重点 ETF 篮子', hint: '量比＝当前额 ÷（上一交易日全天额 × 已过占比）' },
          h(BasketTable, { rows: snap.etf }),
        ),

        h(
          'div',
          {
            style: {
              display: 'grid', gap: '16px', marginBottom: '16px',
              gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)',
            },
          },
          h(Section, { title: '510300 分时结构', hint: '半小时一桶' }, h(SvgBuckets, { buckets: snap.buckets })),
          h(Section, { title: '510300 近 8 日成交额', hint: '看资金是否续上' }, h(SvgHist, { rows: snap.hist510300 })),
        ),

        h(
          Section,
          { title: '护盘脉冲明细', hint: '单分钟成交额 ≥ 当日已过均量的 4 倍' },
          pulseRows.length
            ? h(MiniTable, { head: ['时间', '单分钟成交额', '所在价位', '位置'] }, pulseRows)
            : h('div', { style: card({ padding: '14px 16px', fontSize: '13px', color: C2 }) },
                '本轮没有触发脉冲阈值 —— 说明没有大单在某一分钟集中扫货，节奏是连续的而非突击的。'),
        ),

        h(
          'div',
          {
            style: {
              display: 'grid', gap: '16px', marginBottom: '16px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            },
          },
          h(
            Section,
            { title: '主要指数', hint: '成交额为两市口径' },
            h(
              MiniTable,
              { head: ['指数', '点位', '涨跌幅', '成交额'] },
              (snap.idx || []).map((r) => h(IndexRow, { key: r.name, ...r })),
            ),
          ),
          h(
            Section,
            { title: '海外市场', hint: '外部环境' },
            h(
              MiniTable,
              { head: ['市场', '点位', '涨跌幅'] },
              (snap.ovs || []).map((r) => h(IndexRow, { key: r.name, ...r })),
            ),
          ),
        ),

        h(
          'div',
          {
            style: {
              display: 'grid', gap: '16px', marginBottom: '16px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            },
          },
          h(
            Section,
            { title: '行业领涨', hint: '主力净额＋涨幅' },
            h(
              MiniTable,
              { head: ['行业', '涨幅', '主力净额'] },
              (snap.ind_up || []).map((r) =>
                h('tr', { key: 'iu' + r.name },
                  h('td', { style: { ...tdLeft, color: C1 } }, r.name),
                  h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                  h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)))),
            ),
          ),
          h(
            Section,
            { title: '行业领跌', hint: '主力净额＋涨幅' },
            h(
              MiniTable,
              { head: ['行业', '涨幅', '主力净额'] },
              (snap.ind_dn || []).map((r) =>
                h('tr', { key: 'id' + r.name },
                  h('td', { style: { ...tdLeft, color: C1 } }, r.name),
                  h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                  h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)))),
            ),
          ),
          h(
            Section,
            { title: '概念领涨', hint: '主力净额＋涨幅' },
            h(
              MiniTable,
              { head: ['概念', '涨幅', '主力净额'] },
              (snap.con_up || []).map((r) =>
                h('tr', { key: 'cu' + r.name },
                  h('td', { style: { ...tdLeft, color: C1 } }, r.name),
                  h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                  h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)))),
            ),
          ),
          h(
            Section,
            { title: '概念领跌', hint: '主力净额＋涨幅' },
            h(
              MiniTable,
              { head: ['概念', '涨幅', '主力净额'] },
              (snap.con_dn || []).map((r) =>
                h('tr', { key: 'cd' + r.name },
                  h('td', { style: { ...tdLeft, color: C1 } }, r.name),
                  h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                  h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)))),
            ),
          ),
        ),

        h(
          'div',
          {
            style: {
              display: 'grid', gap: '16px', marginBottom: '16px',
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
            },
          },
          h(
            Section,
            { title: '全市场 ETF 主力净流入 TOP', hint: '注意：净流入方向未必是护盘方向' },
            h(
              MiniTable,
              { head: ['代码', '名称', '涨跌幅', '成交额', '主力净额'] },
              (snap.flow_up || []).map((r) =>
                h('tr', { key: 'fu' + r.code },
                  h('td', { style: { ...tdLeft, color: C2 } }, r.code),
                  h('td', { style: { ...tdLeft, color: C1, fontSize: '12.5px' } }, r.name),
                  h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                  h('td', { style: { ...tdStyle, color: C2 } }, yi(r.amt, 1)),
                  h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)))),
            ),
          ),
          h(
            Section,
            { title: '全市场 ETF 主力净流出 TOP', hint: '谁在被抽血' },
            h(
              MiniTable,
              { head: ['代码', '名称', '涨跌幅', '成交额', '主力净额'] },
              (snap.flow_dn || []).map((r) =>
                h('tr', { key: 'fd' + r.code },
                  h('td', { style: { ...tdLeft, color: C2 } }, r.code),
                  h('td', { style: { ...tdLeft, color: C1, fontSize: '12.5px' } }, r.name),
                  h('td', { style: { ...tdStyle, color: tone(r.chg), fontWeight: 600 } }, pct(r.chg)),
                  h('td', { style: { ...tdStyle, color: C2 } }, yi(r.amt, 1)),
                  h('td', { style: { ...tdStyle, color: tone(r.mf) } }, yiSign(r.mf)))),
            ),
          ),
        ),

        h(
          'div',
          {
            style: {
              marginTop: '4px', padding: '12px 14px', borderRadius: '8px',
              border: '1px solid ' + BORDER, background: SURF,
              fontSize: '12px', color: C2, lineHeight: 1.75,
            },
          },
          h('div', { style: { fontWeight: 600, color: C2, marginBottom: '4px' } }, '口径局限（读数前先看这三条）'),
          h('div', null, '① 量比是「已过交易分钟线性外推」的推定值，开盘初期波动大，只看方向不看绝对值。'),
          h('div', null, '② 超额＝该 ETF 涨跌幅 − 跟踪指数涨跌幅，含昨日溢价残留，不可跨标的横比，只看同一只的时间序列。'),
          h('div', null, '③ 溢价率取腾讯 IOPV 字段（qt.gtimg.cn 第 78 项）；东财 f71 是均价，不是 IOPV。'),
          h('div', { style: { marginTop: '6px' } },
            '数据：东方财富 push2 / 腾讯 qt.gtimg.cn 公开接口，插件内纯 Node 直接计算（无 Python 依赖）。'
            + '仅供个人盘中观测，不构成投资建议。'
            + (meta.cachedAt ? ' 本轮缓存于 ' + new Date(meta.cachedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '')),
        ),
      )
    }

    // ── 侧栏图标 ─────────────────────────────────────────────────────────
    // 用户 2026-11-04 指定的头像，内联 base64（64x64 PNG, 9.0KB / 11.9KB b64），
    // 不请求任何外部资源，断网也在。未选中时压暗到 0.72，选中加一圈主题色描边。
    const ICON_SRC = 'data:image/png;base64,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'

    function Icon(props) {
      const size = (props && props.size) || 18
      const active = !!(props && props.active)
      return h('img', {
        src: ICON_SRC,
        alt: '国家队ETF',
        'aria-hidden': 'true',
        draggable: false,
        style: {
          width: size + 'px',
          height: size + 'px',
          borderRadius: '50%',
          objectFit: 'cover',
          display: 'block',
          opacity: active ? 1 : 0.72,
          boxShadow: active ? '0 0 0 2px ' + UP : 'none',
          transition: 'opacity .15s ease, box-shadow .15s ease',
        },
      })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const slots = (typeof ctx.get === 'function' && ctx.get('slots')) || ctx.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            console.warn('[dsh-etf-monitor] slots 服务不可用')
            return
          }

          // 主题：明/暗两套配色之一。读不到就按浅色渲染（浅色底也是可读的那一套）。
          try {
            const themeSvc = typeof ctx.get === 'function' ? ctx.get('theme') : null
            const pick = (s) => (s && s.active && s.active.colorScheme === 'dark' ? 'dark' : 'light')
            if (themeSvc && typeof themeSvc.getTheme === 'function') {
              applyScheme(pick(themeSvc.getTheme()))
              if (typeof ctx.on === 'function') {
                ctx.on('theme/change', () => {
                  try { applyScheme(pick(themeSvc.getTheme())) } catch (e) { /* 切主题失败不影响看板 */ }
                })
              }
            }
          } catch (e) {
            console.warn('[dsh-etf-monitor] 主题探测失败，按浅色渲染', e)
          }

          slots.inject('main', () => {
            try {
              slots.register({ name: 'main', key: PANEL_ID }, () => h(Panel, {}))
            } catch (e) {
              console.warn('[dsh-etf-monitor] main 注册失败', e)
            }
          })

          slots.inject('sidebar.panellist', () => {
            try {
              slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 30,
                  label: () => '国家队ETF',
                },
                (props) => h(Icon, props || {}),
              )
            } catch (e) {
              console.warn('[dsh-etf-monitor] 侧栏按钮注册失败', e)
            }
          })

          console.info('[dsh-etf-monitor] 已挂载 main + sidebar.panellist')
        } catch (e) {
          console.warn('[dsh-etf-monitor] 挂载失败', e)
        }
      },
    }
  },
})
