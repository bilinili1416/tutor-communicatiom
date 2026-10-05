/*
 * 离线测试。
 *
 * 在最小的 DOM / 宿主模拟里跑真实的 userscript 源码，覆盖两套前端：
 *   桌面版 /wjx/zxyy/xs       （layui，扁平场次行，状态由服务端 yyzt 给出）
 *   移动版 /wjx/wx/zxyy/zx    （Vant，导师 + zxList，状态前端推算）
 *
 * 第二阶段有时序逻辑，所以这里带一个虚拟时钟：可以确定性地推进时间，
 * 验证「到点才开始尝试」「两个候选边界都被覆盖」「成功后立刻停手」。
 *
 * 用法：node tests/dryrun.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'src', 'seu-wjx-tutor-dryrun.user.js');
const source = readFileSync(scriptPath, 'utf8');

const RealDate = Date;
const HOUR = 3600 * 1000;

// ------------------------------------------------------------------ 断言
let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  ok   ' + label);
  } else {
    const text = label + (detail ? '  → ' + detail : '');
    failures.push(text);
    console.log('  FAIL ' + text);
  }
}

// ------------------------------------------------------------------ 虚拟时钟
function createClock(startMs) {
  let now = startMs;
  let seq = 0;
  const timers = new Map();

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }

  function addTimer(fn, ms, interval) {
    seq += 1;
    timers.set(seq, { at: now + Math.max(0, ms || 0), fn, interval });
    return seq;
  }

  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t };
      }
      if (!pick) break;
      now = Math.max(now, pick.t.at);
      if (pick.t.interval) pick.t.at += pick.t.interval;
      else timers.delete(pick.id);
      try { pick.t.fn(); } catch (e) { /* 计时器里的异常不影响推进 */ }
      // 让 async 函数里的 await 有机会继续
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
    }
    now = target;
  }

  return {
    Date: FakeDate,
    setTimeout: (fn, ms) => addTimer(fn, ms, null),
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => addTimer(fn, ms, Math.max(1, ms || 1)),
    clearInterval: (id) => { timers.delete(id); },
    advance,
    now: () => now
  };
}

// ------------------------------------------------------------------ 最小 DOM
function makeElement() {
  return {
    style: { cssText: '' },
    className: '',
    id: '',
    textContent: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    _listeners: {},
    innerHTML: '',
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    classList: { toggle() {}, add() {}, remove() {} },
    querySelector() { return null; },
    attachShadow() { return this._shadow || (this._shadow = makeShadowRoot()); }
  };
}

function makeShadowRoot() {
  const byId = {};
  return {
    appendChild() {},
    getElementById(id) { return (byId[id] = byId[id] || makeElement()); }
  };
}

// 页面的 <title> 上带着 basePath 和模块 id，脚本靠它拼 apply 地址
function makeTitleElement() {
  return {
    getAttribute(name) {
      if (name === 'data-p') return '/wjx/';
      if (name === 'data-m') return 'TEST_MODULE_ID';
      return null;
    }
  };
}

// ------------------------------------------------------------------ moment 桩
function makeMoment() {
  return function moment(value) {
    const date = value instanceof RealDate
      ? value
      : new RealDate(typeof value === 'string' ? value.replace(' ', 'T') : value);
    const valid = !Number.isNaN(date.getTime());
    return {
      isValid: () => valid,
      valueOf: () => date.getTime(),
      format: (pattern) => (pattern === 'YYYY/MM/DD dddd' ? fmt(date) + ' 星期几' : fmt(date))
    };
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmt(date) {
  return date.getFullYear() + '/' + pad(date.getMonth() + 1) + '/' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function fmtLocal(ms) {
  const d = new RealDate(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ------------------------------------------------------------------ 运行器
async function runScenario({ pathname, pcs, clock, handler, fetchHandler, confirmResult, seedConfig }) {
  const ajaxCalls = [];
  const fetchCalls = [];
  const storage = {};
  if (seedConfig) storage['jxzx.dryrun.config.v1'] = JSON.stringify(seedConfig);
  const location = { pathname };
  const SERVER_OFFSET = 230 * 1000; // 模拟那台快了约 230 秒的服务器

  function httpDate() {
    return new RealDate(clock.now() + SERVER_OFFSET).toUTCString();
  }

  const fakeJqXHR = {
    status: 200,
    getResponseHeader: (name) => (name.toLowerCase() === 'date' ? httpDate() : null)
  };

  const hostWindow = {
    location,
    pcs,
    moment: makeMoment(),
    confirm: () => confirmResult !== false,
    $: {
      ajax(options) {
        ajaxCalls.push({ url: options.url, data: options.data });
        let res;
        try {
          res = handler(options.url, options.data);
        } catch (e) {
          options.error({ status: 500 }, 'error', e);
          return;
        }
        options.success(res, 'success', fakeJqXHR);
      }
    }
  };

  async function fakeFetch(url, options) {
    fetchCalls.push({ url, method: options && options.method, body: options && options.body, at: clock.now() });
    const res = fetchHandler ? fetchHandler(url, options) : { code: 0 };
    return {
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'date' ? httpDate() : null) },
      text: async () => JSON.stringify(res)
    };
  }

  const context = {
    window: hostWindow,
    location,
    document: {
      body: makeElement(),
      createElement: () => makeElement(),
      querySelector: (sel) => (sel === 'title' ? makeTitleElement() : null)
    },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; }
    },
    fetch: fakeFetch,
    encodeURIComponent,
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: clock.Date,
    JSON,
    Math,
    Number,
    Object,
    Array,
    Promise,
    String,
    isFinite,
    NaN
  };

  vm.runInNewContext(source, context, { filename: scriptPath });
  await new Promise((resolve) => setTimeout(resolve, 30));

  return { api: hostWindow.__JXZX_DRYRUN_API__, ajaxCalls, fetchCalls };
}

function tail(api, before) {
  return api.getLog().slice(before);
}

// ================================================================ 场景一：桌面版
console.log('场景一：桌面版 /wjx/zxyy/xs');

const clock = createClock(RealDate.now());
const t0 = clock.now();
// 目标场次：按「服务器时间」算还有 60 秒开放
const targetOpenAt = t0 + 230 * 1000 + 60 * 1000;

let desktopRows = [{
  pid: 1900,
  ds: { name: '尤肖虎', lx: { label: '校内导师' }, dw: '信息科学与工程学院', zwzc: '教授' },
  pc: { id: 117, mc: '2026级学术导师交流' },
  yyrq: '2026-10-20', kssj: '10:00', jssj: '11:30',
  bmkssj: new RealDate(targetOpenAt).toISOString(),
  bmyxsj: 1, yyrs: 0, yyzdrs: 100, sfyy: false, sfzc: false, yyzt: 2
}];

let booked = false;
let applyOutcomes = [];   // 每次 apply 的返回由它决定

const desktop = await runScenario({
  pathname: '/wjx/zxyy/xs',
  pcs: undefined,
  clock,
  confirmResult: true,
  seedConfig: { phone: '13800000000', intervalSec: 5 },
  handler(url) {
    if (url === 'common/selector') {
      return { code: 0, msg: 'success', data: [{ label: '2026级学术导师交流', value: 117 }] };
    }
    if (url === 'zxyy/xs/ajaxList') {
      return {
        code: 0, totalPages: 1, count: desktopRows.length,
        data: desktopRows.map((r) => Object.assign({}, r, { sfyy: booked }))
      };
    }
    throw new Error('unexpected url ' + url);
  },
  fetchHandler() {
    const next = applyOutcomes.shift();
    return next || { code: -1, msg: '报名未开始' };
  }
});

const api = desktop.api;
check('调试接口可用', !!api);
check('识别为桌面版前端', api.frontend() && api.frontend().key === 'desktop');
check('批次来自 common/selector', api.getBatches().length === 1);

console.log('\n第一阶段：只读扫描');
let before = api.getLog().length;
const row = await api.runScan(true);
let report = tail(api, before);
check('扫描返回了目标行', !!row && row.pid === 1900);
check('报告标注前端为桌面版', report.includes('前端：桌面版'));
check('服务端 yyzt=2 判为报名未开始', report.includes('判定：报名未开始（状态码 2）'), report);
check('提交地址是桌面版 apply', report.includes('POST /wjx/zxyy/xs/apply'));
check('请求体含场次 ID 且 sfzc=0', report.includes('"zxxx":1900') && report.includes('"sfzc":0'));
check('未武装时一次写请求都没发', desktop.fetchCalls.length === 0,
  JSON.stringify(desktop.fetchCalls));

console.log('\n第二阶段：设为目标 → 武装 → 到点提交');
api.setTarget(row);
check('时钟已校准到约 +230 秒',
  Math.abs(api.getArm().tLate - api.getArm().tOpen - 230000) < 1500,
  'offset=' + (api.getArm().tLate - api.getArm().tOpen));
check('两个候选边界不重合', api.getArm().tLate - api.getArm().tOpen > 200000);

api.armTarget();
check('武装后进入 armed 状态', api.getArm().armed === true);
check('武装瞬间还没有发出写请求', desktop.fetchCalls.length === 0);

// 第一个候选边界在「真实时间」上的位置：服务器时间走到 tOpen 的那一刻
const boundary1 = targetOpenAt - 230 * 1000;

// 推进到第一个候选边界之后一点
await clock.advance(65 * 1000);
const applyCalls = desktop.fetchCalls.slice();
// 允许提前 ATTEMPT_LEAD_MS 左右预打一次（让请求在边界时已经在途），但不允许更早
check('边界 3 秒之前一个 apply 都没发（远处只做只读探活）',
  applyCalls.filter((c) => c.at < boundary1 - 3000).length === 0,
  JSON.stringify(applyCalls.map((c) => ((c.at - boundary1) / 1000).toFixed(1))));
check('边界之前确实在探活（有只读列表请求）',
  desktop.ajaxCalls.filter((c) => c.url === 'zxyy/xs/ajaxList').length > 1,
  'ajax=' + desktop.ajaxCalls.length);
check('第一个候选边界后开始真正提交', applyCalls.length > 0, 'count=' + applyCalls.length);
check('第一次 apply 落在第一个候选边界附近（±3 秒）',
  applyCalls.length > 0 && Math.abs(applyCalls[0].at - boundary1) <= 3000,
  applyCalls.length ? ('delta=' + ((applyCalls[0].at - boundary1) / 1000).toFixed(1) + 's') : '');

// 推进到第二个候选边界（真实时间口径）之后
await clock.advance(240 * 1000);
const all = desktop.fetchCalls.slice();
check('尝试覆盖了第二个候选边界（服务器用标准时间的情况）',
  all.some((c) => c.at >= targetOpenAt), 'max=' + ((Math.max(...all.map((c) => c.at)) - targetOpenAt) / 1000) + 's');
console.log('       （本次武装共发出 apply 请求 ' + all.length + ' 次）');
check('总请求数被控制在两位数到三位数之间（不是狂轰）',
  all.length > 5 && all.length < 200, 'count=' + all.length);
check('仍未成功时保持 armed', api.getArm().armed === true);
check('失败原因被记录', api.getLog().includes('报名未开始'));

// 让下一次尝试成功
applyOutcomes.push({ code: 0, msg: '预约成功' });
const attemptsBefore = desktop.fetchCalls.length;
await clock.advance(20 * 1000);
booked = true;
check('成功后发出了请求', desktop.fetchCalls.length > attemptsBefore);
check('成功后自动解除武装', api.getArm().armed === false);
check('标记为已完成', api.getArm().done === true);
check('日志记录提交成功', api.getLog().includes('提交成功'));
check('做了回读确认', api.getLog().includes('回读确认'));

const settledCount = desktop.fetchCalls.length;
await clock.advance(60 * 1000);
check('成功之后彻底停手', desktop.fetchCalls.length === settledCount,
  settledCount + ' → ' + desktop.fetchCalls.length);

console.log('\n写入请求的形态');
const applyCall = desktop.fetchCalls[0];
check('打到桌面版 apply 地址',
  applyCall && applyCall.url === '/wjx/zxyy/xs/apply', applyCall && applyCall.url);
check('用 POST', applyCall && applyCall.method === 'POST');
check('请求体含 zxxx / sjhm / sfzc / .me',
  applyCall && ['zxxx=1900', 'sjhm=', 'sfzc=false', '.me=TEST_MODULE_ID']
    .every((frag) => applyCall.body.includes(frag)), applyCall && applyCall.body);

console.log('\n未武装时的红线');
const beforeIdle = desktop.fetchCalls.length;
await clock.advance(30 * 1000);
check('空闲状态下不产生任何写请求', desktop.fetchCalls.length === beforeIdle);

console.log('\n手动提交一次（用来验证链路是否通）');
const beforeOnce = desktop.fetchCalls.length;
await api.submitOnce();
check('确认后正好发出一次请求', desktop.fetchCalls.length === beforeOnce + 1);
check('返回值被记录到日志', api.getLog().includes('手动提交返回'));

// ================================================================ 场景二：移动版
console.log('\n场景二：移动版 /wjx/wx/zxyy/zx');

const mobileClock = createClock(RealDate.now());
const mobileOpenAt = mobileClock.now() + 230 * 1000 + 30 * 1000;

const mobileTeacher = {
  pid: 1073,
  lx: { label: '校外导师', value: 1 },
  name: '孔伟宁',
  dw: '无',
  zwzc: '无',
  zxList: [{
    pid: 1888,
    yyrq: '2026-10-20',
    kssj: '14:00',
    jssj: '15:30',
    bmkssj: fmtLocal(mobileOpenAt),
    bmyxsj: 1,
    yyrs: 1,
    yyzdrs: 5,
    sfyy: false,
    sfzc: false
  }]
};

const mobile = await runScenario({
  pathname: '/wjx/wx/zxyy/zx',
  pcs: [{ text: '测试批次', id: 120 }],
  clock: mobileClock,
  confirmResult: false,   // 移动版这一轮故意「取消确认」
  seedConfig: { phone: '13800000000', intervalSec: 5 },
  handler(url) {
    if (url === 'wx/zxyy/zx/ajaxList') {
      return { code: 0, totalPages: 1, count: 1, data: [mobileTeacher] };
    }
    throw new Error('unexpected url ' + url);
  },
  fetchHandler: () => ({ code: 0, msg: 'ok' })
});

check('识别为移动版前端', mobile.api.frontend() && mobile.api.frontend().key === 'mobile');
check('批次来自页面全局 pcs', mobile.api.getBatches().length === 1);

before = mobile.api.getLog().length;
await mobile.api.runScan(true);
report = tail(mobile.api, before);
check('报名未开始 → 状态码 3', report.includes('报名未开始（状态码 3）'), report);
check('提交地址是移动版 apply', report.includes('POST /wjx/wx/zxyy/zx/apply'));
check('报名未开始时会提示预填写', report.includes('预填写'));

// 确认框被取消 → 绝不能变成已武装
const mobileRow = await mobile.api.runScan(true);
mobile.api.setTarget(mobileRow);
mobile.api.armTarget();
check('用户在确认框点取消时不会武装', mobile.api.getArm().armed === false);
await mobileClock.advance(120 * 1000);
check('取消之后依然没有写请求', mobile.fetchCalls.length === 0,
  JSON.stringify(mobile.fetchCalls));
await mobile.api.submitOnce();
check('取消确认时手动提交同样不发请求', mobile.fetchCalls.length === 0);

// ================================================================
console.log('\n' + passed + ' 项通过，' + failures.length + ' 项失败');
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
