# dsh-etf-monitor

DSH 面板里的「国家队 ETF 盘中监测」。纯 Node 直取东方财富 push2 与腾讯
qt.gtimg.cn 的公开行情接口，**零 Python 依赖、零第三方 npm 包、不读本地任何文件**，
装完就能用。

## 怎么装

把 tgz（或整个源码目录）交给 DSH，让 agent 调 `plugin_manager`：

| 拿到的东西 | `install_bundle` 的 target 写什么 |
|---|---|
| `dist/dsh-etf-monitor-0.2.0.tgz` | `C:/path/to/dsh-etf-monitor-0.2.0.tgz` |
| 源码目录（开发时） | `link:C:/path/to/plugins/dsh-etf-monitor` |

用 `link:` 装时改源码即时生效；用 tgz 装是快照，升级要重新装一次。
宿主半侧是热装配的，装完通常不用重启；客户端 bundle 要刷新页面才生效。

> 上架插件市场（`dshm_install <id>`）需要先发到 npm 并入精选清单，本包目前只做了
> `npm pack` 可分发验证，尚未发布。

## 它解决什么

盘中想确认「国家队/汇金是不是在买宽基 ETF」，光看指数没用——指数会被权重股掩盖。
真正要看的是：**宽基 ETF 的成交额有没有异常放大、是不是脉冲式护盘、有没有一级
申购资金顶着溢价买**。这三件事都在 ETF 自己的成交数据里，不在指数里。

这个插件把这几条读数做成一个常驻面板，交易时段内每 60 秒自动重算。

## 装了之后长什么样

左侧图标栏（`sidebar.panellist`，order 30，在「灵枢/上下文」与「梦境」之间），
图标名 **国家队ETF**。点开是 `main` 槽位的整页看板：

- **四项判读**：510300 量比推定 / 护盘脉冲次数 / 溢价率（腾讯 IOPV）/ 涨跌家数
- **重点 ETF 篮子 15 只**：现价、涨跌幅、成交额、量比推定、主力净额、超额、溢价率
- **510300 分时结构**：半小时一桶，成交额柱 + 价位点，一眼看出是不是脉冲式护盘
- **510300 近 8 日成交额**：判断今天是「正常量」还是「异常量」
- **护盘脉冲明细**：单分钟成交额 ≥ 当日已过均量 4 倍的那些分钟
- **主要指数 / 海外市场 / 行业与概念涨跌前列 / 全市场 ETF 主力净流入流出 TOP**

## 怎么读（给第一次用的人）

| 读数 | 看什么 | 怎么判断 |
|---|---|---|
| 量比推定 | 当前成交额 ÷ 按时间线性外推的全天成交额 | > 1.5× 才算真放量；< 0.7× 是缩量 |
| 护盘脉冲 | 单分钟成交额达到当日已过均量的 4 倍 | 连续出现 = 主动买；只出现一两次且价格被吞 = 试盘 |
| 溢价率 | ETF 市价相对 IOPV | 持续正溢价 = 有一级申购资金在顶；负溢价 = 折价没人接 |
| 超额 | ETF 涨跌幅 − 跟踪指数涨跌幅 | 看同一只的时间序列，不要跨标的比 |

**最有用的一条组合判据**：成交额放大 **且** 溢价率转正 **且** 分时桶价格重心上移
——这三条同时成立才是真护盘；只有第一条放大往往是「换手不是承接」。

## 结构

```
package.json          dsh.bundle.patch + dsh.client 两处声明
cordis.patch.yml      往配置树插入 id=dsh-etf-monitor 一行
lib/index.js          宿主半侧：注册 /dsh-etf-monitor 前缀路由 + 45 秒缓存 + 串行化
lib/snapshot.js       纯 Node 数据层：直取东财/腾讯，产出与前端约定的 snap 对象
client.js             浏览器半侧：main + sidebar.panellist 两个槽位
test/test_client.cjs  不开浏览器也能把 React 树跑一遍的冒烟测试
```

## 接口

| 路径 | 说明 |
|---|---|
| `GET /dsh-etf-monitor/api` | 取快照，45 秒进程内缓存 |
| `GET /dsh-etf-monitor/api?fresh=1` | 强制重算 |
| `GET /dsh-etf-monitor/health` | 引擎、版本、最近一轮耗时、最近一次失败原因 |
| `GET /dsh-etf-monitor/debug` | 逐接口探活（排障用） |

也可以单独 import 数据层，不需要 DSH 运行时：

```js
import { takeSnapshot, summarize } from 'dsh-etf-monitor/snapshot'

const snap = await takeSnapshot()
console.log(summarize(snap))   // 状态=交易中 已过分钟=190 510300=4.18 (+2.2%) 成交额=113.0亿
```

## 为什么不复用那套 Python 脚本

早期版本是 `execFile` 调一个本地 `etf_monitor.py`。能跑，但那个脚本里写死了解释器
绝对路径与数据目录，别人装上必挂。0.2.0 把整套取数逻辑用 Node 的 `fetch` 重写了一遍，
只依赖 Node ≥ 18.17 自带的 API（`fetch`、`TextDecoder`、`AbortSignal.timeout`）。

腾讯接口返回 GBK，用 `new TextDecoder('gbk')` 直接解，不需要 iconv 之类的包。

## 口径局限（页脚也写了）

1. **量比是推定值**：用「已过交易分钟线性外推」估全天，开盘初期波动大，只看方向
   不看绝对值。
2. **超额含昨日溢价残留**：`ETF 涨跌幅 − 跟踪指数涨跌幅` 是个代理，不可跨标的横比，
   只看同一只的时间序列。
3. **溢价率取腾讯 IOPV 字段**（`qt.gtimg.cn` 第 78 项）。东财的 `f71` 是**均价**
   不是 IOPV，早期版本在这里算错过。

## 数据源踩过的坑（改代码前先看）

1. 东财 `ulist.np` **并发十几条会整批返回空**（HTTP 200 但 `data.diff` 缺失）。
   现在按 20 个一批切块，缺失的再逐个单发补齐，最多补两轮。
2. 涨停池的总数在 `data.tc`，不是 `data.total`；不带 `dpt=wz.ztzt` 会返回 `rc:102`。
3. 日线接口必须带 `end=20500101`，否则 `rc:102`。
4. 涨跌家数只能走 `ulist.np` 的 `f104/f105/f106`；`stock/get` 对指数返回 `"-"`。
5. ETF 跟踪指数的 secid 必须和 ETF 自己的 secid 一起请求，否则超额列全空。

## 改完怎么生效

- 改 `client.js`：**刷新一次页面**（客户端 bundle 是页面加载时取的，光切面板不重读）。
- 改 `lib/index.js` / `lib/snapshot.js`：宿主半侧热装配；若不生效，把插件 disable 再
  enable 一次即可。

## 测试

```bash
# 仓库里自带一份真实快照当 fixture，直接跑就行
node test/test_client.cjs test/fixture.json

# 想用最新数据：从正在跑的插件里取一份
curl -s http://127.0.0.1:<port>/dsh-etf-monitor/api -o fixture.json
node test/test_client.cjs fixture.json
```

测试做的事：用假的 `window.__ModuleLoader__` 接住自注册描述符，再用假的 React
把 `main` 与 `sidebar.panellist` 两个槽位的 React 树整棵展开执行一遍（约 1440 个
节点），断言关键读数真的落到了文案里。不开浏览器也能抓到 `undefined.toFixed`
这类运行时错误。

## 许可

MIT。仅供个人盘中观测，不构成投资建议。
