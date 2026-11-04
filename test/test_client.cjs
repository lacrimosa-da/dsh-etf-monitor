/**
 * client.js 冒烟测试：不打开浏览器，也把整棵 React 树跑一遍。
 *
 * 做法：用一个假的 `window.__ModuleLoader__` 接住自注册描述符，再用一个
 * 假的 React（createElement 只造普通对象、useState 按调用顺序吐预设值）
 * 去跑注册出来的两个 slot cell。树里的 map / 格式化 / 条件分支都会被真正
 * 执行，能抓到 props 拼错、字段缺失、undefined.toFixed 这类运行时错误。
 *
 * 用法：node test_client.cjs <snapshot.json>
 */
const fs = require('node:fs')
const path = require('node:path')

const CLIENT = path.resolve(__dirname, '..', 'client.js')
const FIXTURE = process.argv[2]

const api = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const snap = api.snap || api

// ── 假 React ────────────────────────────────────────────────────────────────
let call = 0
const preset = [snap, { loading: false, error: null, cachedAt: new Date().toISOString(), stale: false }, true, 0]
const fakeReact = {
  createElement(type, props, ...children) {
    const p = Object.assign({}, props || {})
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { __el: true, type, props: p }
  },
  Fragment: 'Fragment',
  useState(init) {
    return [call < preset.length ? preset[call++] : init, () => {}]
  },
  useEffect() {},
  useCallback(fn) { return fn },
}

const requireStub = (id) => {
  if (id === 'react') return fakeReact
  if (id === 'react-dom') return {}
  throw new Error('unexpected require: ' + id)
}

// ── 接住自注册 ──────────────────────────────────────────────────────────────
let desc = null
const window = { __ModuleLoader__: { load: (d) => { desc = d } } }
// eslint-disable-next-line no-new-func
new Function('window', 'require', fs.readFileSync(CLIENT, 'utf8'))(window, requireStub)

if (!desc) throw new Error('client.js 没有调用 __ModuleLoader__.load()')
if (desc.id !== 'dsh-etf-monitor') throw new Error('id 不对：' + desc.id)
console.log('✓ 自注册 id =', desc.id)

const plugin = desc.factory(requireStub)

// ── 假 ctx ──────────────────────────────────────────────────────────────────
const registered = []
const fakeCtx = {
  get: (k) => (k === 'slots' ? slots : undefined),
  slots: null,
}
const slots = {
  inject(name, fn) { fn() },
  register(arg, cell) {
    registered.push({ arg, cell })
    return () => {}
  },
}
fakeCtx.slots = slots

plugin.apply(fakeCtx)

const names = registered.map((r) => r.arg.name)
console.log('✓ 注册槽位：', names.join(', '))
if (!names.includes('main')) throw new Error('缺 main')
if (!names.includes('sidebar.panellist')) throw new Error('缺 sidebar.panellist')

const main = registered.find((r) => r.arg.name === 'main')
const side = registered.find((r) => r.arg.name === 'sidebar.panellist')
if (main.arg.key !== side.arg.id) throw new Error('main.key 与 panellist.id 不一致，侧栏点不开')
console.log('✓ main.key === panellist.id =', main.arg.key, '| order =', side.arg.order, '| label =', side.arg.label())

// ── 跑图标 cell ─────────────────────────────────────────────────────────────
const iconEl = side.cell({ size: 18, active: true })
if (!iconEl || typeof iconEl.type !== 'function') throw new Error('图标 cell 没返回组件元素')
const icon = iconEl.type(iconEl.props)
if (!icon || icon.type !== 'img') throw new Error('图标没渲染出 img')
const src = icon.props.src || ''
if (!src.startsWith('data:image/png;base64,')) throw new Error('图标不是内联 base64 PNG')
if (src.length < 5000) throw new Error('图标 base64 太短，可能没嵌进去')
if (icon.props.style.width !== '18px') throw new Error('图标尺寸没跟随 size')
console.log('✓ 图标 img 内联 PNG，b64 长度 =', src.length)

// 未选中态必须压暗，选中态必须加描边
const iconIdle = side.cell({ size: 18, active: false }).type({ size: 18, active: false })
if (iconIdle.props.style.opacity !== 0.72) throw new Error('未选中态没有压暗')
if (iconIdle.props.style.boxShadow !== 'none') throw new Error('未选中态不该有描边')
console.log('✓ 选中/未选中两态样式正确')

// ── 跑主面板 cell（整棵树都会真的执行） ────────────────────────────────────
call = 0
const tree = main.cell({})
if (!tree) throw new Error('主面板返回空')

let nodes = 0
const texts = []
const walk = (n) => {
  if (n == null || typeof n === 'boolean') return
  if (typeof n === 'string' || typeof n === 'number') { nodes++; texts.push(String(n)); return }
  if (Array.isArray(n)) { n.forEach(walk); return }
  if (!n.__el) return
  nodes++
  // 函数组件就地展开：只有 Panel 用到 hook，而它在最外层，调用顺序稳定
  if (typeof n.type === 'function') { walk(n.type(n.props)); return }
  walk(n.props.children)
}
walk(tree)

const joined = texts.join(' ')
const must = ['国家队 ETF 盘中监测', '510300 量比推定', '重点 ETF 篮子', '护盘脉冲明细', '海外市场']
const missing = must.filter((m) => !joined.includes(m))
console.log('✓ 主面板节点数 =', nodes, '文本片段 =', texts.length)
if (missing.length) throw new Error('缺少关键文案：' + missing.join(' / '))

// 关键数值是否真的落到了文案里
const checks = [
  ['量比', String(snap.etf[0].est_ratio.toFixed(2)) + '×'],
  ['溢价', (snap.etf[0].premium > 0 ? '+' : '') + snap.etf[0].premium.toFixed(2) + '%'],
]
for (const [label, want] of checks) {
  if (!joined.includes(want)) throw new Error(label + ' 期望出现 ' + want)
  console.log('✓', label, '→', want)
}
console.log('✓ 篮子行数 =', (snap.etf || []).length, '| 指数 =', (snap.idx || []).length, '| 海外 =', (snap.ovs || []).length)
console.log('\nALL PASS')
