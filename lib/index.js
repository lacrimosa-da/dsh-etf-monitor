/**
 * dsh-etf-monitor —— 宿主半侧
 * ============================================================================
 * 职责：把一轮全市场 ETF 快照，以同源 HTTP 接口暴露给页面。
 *
 *   GET /dsh-etf-monitor/api            走 45 秒缓存
 *   GET /dsh-etf-monitor/api?fresh=1    强制重算
 *   GET /dsh-etf-monitor/health         看最近一轮耗时 / 失败原因
 *   GET /dsh-etf-monitor/debug          逐个接口探活（排查用）
 *
 * 取数全部在 lib/snapshot.js 里用 Node 原生 fetch 完成，**不依赖 Python、
 * 不依赖任何本地路径**，装到谁的机器上都能跑（这是 0.2.0 相对 0.1.0 的
 * 唯一实质改动：0.1.0 用 execFile 调本机 python 跑 F 盘脚本，别人装了必挂）。
 *
 * 为什么保留 45 秒缓存 + inflight 单例：
 *   页面 60 秒自刷新；若同时点「刷新」又撞上定时器，两个请求会各起一轮
 *   二十来个 HTTP 请求。inflight 保证同一时刻只有一轮在跑，后到的直接挂
 *   在同一份 Promise 上；TTL 内的直接吃缓存，命中约 1 毫秒。
 * ============================================================================
 */
import { takeSnapshot, summarize } from './snapshot.js'

/** 插件名（Cordis 用它在诊断信息里标识这一行） */
export const name = 'dsh-etf-monitor'

/** 依赖的宿主服务：只需要一个能挂 HTTP 路由的 webServer */
export const inject = ['webServer']

const ROUTE = '/dsh-etf-monitor'
const TTL_MS = 45 * 1000

/** 最近一轮结果：{ at, snap, error, elapsed } */
let cache = { at: 0, snap: null, error: null, elapsed: null }
/** 正在跑的那一轮（单例） */
let inflight = null

function refresh(force) {
  const now = Date.now()
  if (!force && cache.snap && now - cache.at < TTL_MS) return Promise.resolve(cache)
  if (inflight) return inflight
  const t0 = Date.now()
  inflight = takeSnapshot()
    .then((snap) => {
      const elapsed = Date.now() - t0
      cache = { at: Date.now(), snap, error: null, elapsed }
      inflight = null
      return cache
    })
    .catch((e) => {
      cache = { at: cache.at, snap: cache.snap, error: String(e?.message ?? e), elapsed: null }
      inflight = null
      return cache
    })
  return inflight
}

/** 逐接口探活：每条都返回 ok / status / 错误原文 / 前 120 字 */
async function debugProbe() {
  const UA = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://quote.eastmoney.com/',
  }
  const targets = [
    ['ulist', 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.510300&fields=f2,f3,f6,f12,f14,f62&ut=fa5fd1943c7b386f172d6893dbfba10b'],
    ['breadth', 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000001,0.399001&fields=f12,f14,f104,f105,f106&ut=fa5fd1943c7b386f172d6893dbfba10b'],
    ['clist', 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=3&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f3,f62&ut=fa5fd1943c7b386f172d6893dbfba10b'],
    ['tencent', 'https://qt.gtimg.cn/q=sh510300'],
  ]
  const out = {}
  for (const [k, url] of targets) {
    const t0 = Date.now()
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) })
      const buf = Buffer.from(await res.arrayBuffer())
      const txt = new TextDecoder(k === 'tencent' ? 'gbk' : 'utf-8').decode(buf)
      out[k] = { ok: true, status: res.status, ms: Date.now() - t0, len: buf.length, head: txt.slice(0, 120) }
    } catch (e) {
      out[k] = { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e), cause: String(e?.cause?.message ?? '') }
    }
  }
  out.fetchImpl = typeof fetch
  return out
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(buf.length))
  res.end(buf)
}

/** 宿主半侧启动入口 */
export function apply(ctx) {
  const handler = async (req, res) => {
    let path = '/'
    let query = ''
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      path = url.pathname.slice(ROUTE.length) || '/'
      query = url.search
    } catch (_) {
      /* 解析失败就按根路径处理 */
    }

    if (path === '/health') {
      return sendJson(res, 200, {
        ok: true,
        engine: 'node',
        version: '0.2.0',
        cachedAt: cache.at ? new Date(cache.at).toISOString() : null,
        lastElapsedMs: cache.elapsed,
        summary: cache.snap ? summarize(cache.snap) : null,
        lastError: cache.error,
      })
    }

    if (path === '/debug') {
      return sendJson(res, 200, await debugProbe())
    }

    if (path === '/api' || path === '/api/') {
      const force = /[?&]fresh=1/.test(query) || /[?&]refresh=1/.test(query)
      const box = await refresh(force)
      if (!box.snap) {
        return sendJson(res, 502, { ok: false, error: box.error || '取数失败，且没有上一轮缓存' })
      }
      return sendJson(res, 200, {
        ok: true,
        cachedAt: new Date(box.at).toISOString(),
        elapsedMs: box.elapsed,
        stale: Boolean(box.error),
        error: box.error || null,
        snap: box.snap,
      })
    }

    res.statusCode = 404
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('dsh-etf-monitor: GET /api | GET /api?fresh=1 | GET /health | GET /debug')
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'dsh-etf-monitor: http route',
  )
}
