// ==UserScript==
// @name         吴健雄学院导师交流预约助手 · 第一阶段（只读）
// @namespace    tutor-communicatiom
// @version      0.3.0
// @description  定位目标场次、校准服务器时间、判定报名状态；第二阶段支持预填写与到点自动提交，但默认处于「未武装」状态，不点武装就不会发送任何写入请求。
// @match        https://jxsy.seu.edu.cn/wjx/zxyy/xs*
// @match        https://jxsy.seu.edu.cn/wjx/wx/zxyy/zx*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * =============================================================================
 * 东南大学吴健雄学院 · 导师交流预约助手 —— 第一阶段（只读 / 干跑）
 * =============================================================================
 *
 * 这个阶段只做四件事：
 *   1. 调用只读的列表接口，定位目标批次 / 主讲人 / 场次
 *   2. 用响应头 Date 估算「服务器时间 - 本地时间」的偏差
 *   3. 判定报名状态（已预约 / 已满 / 未开始 / 已结束 / 可预约 / 已预填写）
 *   4. 打印「如果现在提交，会发出什么请求」
 *
 * 它不会调用任何 apply 接口。这条红线在代码里写成了一个显式函数
 * wouldSubmit()：它只返回请求体，不发送。
 *
 * ---------------------------------------------------------------------------
 * 重要：这个模块有两套完全独立的前端，接口和状态码都不一样
 * ---------------------------------------------------------------------------
 *   桌面版（layui，后台外壳里用的就是这个）
 *     页面   /wjx/zxyy/xs
 *     列表   POST /wjx/zxyy/xs/ajaxList       参数 pc.id、ds.name
 *     提交   POST /wjx/zxyy/xs/apply          参数 zxxx、sjhm、sfzc
 *     状态   yyzt：0已预约 1已满 2未开始 3已结束 4可预约 5已预填写
 *     形态   一行一个场次，行里带 ds（主讲人）和 pc（批次）
 *
 *   移动 / 微信版（Vant）
 *     页面   /wjx/wx/zxyy/zx
 *     列表   POST /wjx/wx/zxyy/zx/ajaxList    参数 page、limit、name、pcId
 *     提交   POST /wjx/wx/zxyy/zx/apply       参数 zxxx、sjhm、sfzc
 *     状态   前端自己算：1已预约 2已满 3未开始 4已结束 5可预约
 *     形态   一位导师一个对象，场次放在 zxList 里
 *
 * 两套前端共用同一批场次 pid，但状态码语义不同，所以脚本按「前端适配器」
 * 分开建模，再把结果归一化成同一个场次视图给面板和报告使用。
 *
 * ---------------------------------------------------------------------------
 * 关于鉴权上下文
 * ---------------------------------------------------------------------------
 * 两套前端都对 $.ajax 做了包装（common.js / vant-common.js 里的 __setup），
 * 会自动补上 __basePath 前缀和 `.me` 模块参数。所以这里沿用页面自己的
 * $.ajax（相对路径 + data 对象），鉴权上下文天然正确，不需要手写 URL
 * 或模块 ID。
 *
 * @grant none 让脚本运行在页面上下文，因此也能直接粘贴到 DevTools 控制台
 * 运行，方便在装 Tampermonkey 之前先验证逻辑。
 * =============================================================================
 */

(function () {
  'use strict';

  // 防止在同一个页面里重复注入
  if (window.__JXZX_DRYRUN__) return;
  window.__JXZX_DRYRUN__ = true;

  // ---------------------------------------------------------------- 常量
  var CFG_KEY = 'jxzx.dryrun.config.v1';
  var MAX_PAGES = 10;         // 分页上限，避免误伤服务器
  var MIN_INTERVAL_MS = 2000; // 轮询间隔下限，硬性保护

  // ---------------------------------------------------------------- 配置
  var config = Object.assign({
    batch: '',        // 批次名称，空 = 全部批次
    keyword: '',      // 主讲人 / 导师姓名关键词
    date: '',         // 目标预约日期 YYYY-MM-DD，空 = 第一条
    phone: '',        // 手机号，仅用于预演请求体（本阶段不会发送）
    intervalSec: 5
  }, readConfig());

  var timer = null;
  var busy = false;
  var lastSignature = null;
  var batches = [];   // [{ id, name }]，异步加载

  // 时钟校准
  var clockOffsetMs = 0;  // 服务器时间 - 本地时间
  var clockSamples = 0;

  function readConfig() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveConfig() {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(config));
    } catch (e) {
      /* 隐私模式下 localStorage 可能不可用 */
    }
  }

  // ---------------------------------------------------------------- 基础工具
  function serverNow() {
    return Date.now() + clockOffsetMs;
  }

  /*
   * 两套前端的时间格式不一样：
   *   桌面版  bmkssj = "2026-09-29T04:30:00.000+00:00"   （带时区，可直接解析）
   *   移动版  bmkssj = "2026-10-10 12:00:00"             （裸本地时间，交给 moment）
   * 先看有没有时区标记，再决定用哪种解析方式。
   */
  function ts(value) {
    if (value === null || value === undefined || value === '') return NaN;
    var s = String(value);
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      var direct = Date.parse(s);
      if (isFinite(direct)) return direct;
    }
    if (window.moment) {
      var m = window.moment(s);
      if (m.isValid()) return m.valueOf();
    }
    var fallback = Date.parse(s.replace(' ', 'T'));
    return isFinite(fallback) ? fallback : NaN;
  }

  function fmt(t) {
    if (!isFinite(t)) return '—';
    if (window.moment) return window.moment(t).format('YYYY/MM/DD HH:mm:ss');
    return new Date(t).toLocaleString();
  }

  function fmtDay(t) {
    if (!isFinite(t)) return '—';
    if (window.moment) return window.moment(t).format('YYYY/MM/DD dddd');
    return new Date(t).toLocaleDateString();
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // 毫秒级时间戳，用于观察「状态翻转发生在哪一刻」这类边界实验
  function fmtMs(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
      + '.' + (d.getMilliseconds() < 100 ? ('0' + (d.getMilliseconds() < 10 ? '0' : '')) : '')
      + d.getMilliseconds();
  }

  // 同一条记录里同时给出本机时间和换算后的服务器时间，
  // 这样两条不同的时间轴可以逐一对照，方便事后核对偏差。
  function stamp() {
    return '本机 ' + fmtMs(Date.now()) + ' | 服务器 ' + fmtMs(serverNow());
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function parseHttpDate(header) {
    var t = Date.parse(header);
    return isFinite(t) ? t : NaN;
  }

  /*
   * 用「请求发出前 / 收到响应后」的中点与 Date 头比较，抵消一部分网络延迟。
   * 注意 Date 头只有秒级精度，偏差仍可能有 ±0.5s。第一阶段够用；
   * 真要卡秒抢名额时需要更精细的校准（第二阶段处理）。
   */
  function calibrate(t0, t1, jqXHR) {
    var header;
    try {
      header = jqXHR && jqXHR.getResponseHeader && jqXHR.getResponseHeader('Date');
    } catch (e) {
      return;
    }
    if (!header) return;
    var server = parseHttpDate(header);
    if (!isFinite(server)) return;
    var mid = t0 + (t1 - t0) / 2;
    var sample = server - mid;
    clockOffsetMs = clockSamples === 0 ? sample : clockOffsetMs * 0.6 + sample * 0.4;
    clockSamples += 1;
  }

  // 共用的 POST 助手：只负责发请求 + 校时，不做任何业务判断
  function post(url, data) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      window.$.ajax({
        url: url,
        type: 'post',
        dataType: 'json',
        data: data,
        success: function (res, textStatus, jqXHR) {
          calibrate(t0, Date.now(), jqXHR);
          resolve(res);
        },
        error: function (jqXHR, textStatus) {
          calibrate(t0, Date.now(), jqXHR);
          // 服务端偶尔会返回残缺 JSON（已实测到），这里如实报告
          reject(new Error('HTTP ' + (jqXHR && jqXHR.status) + ' / ' + textStatus));
        }
      });
    });
  }

  function metaOf(ds) {
    if (!ds) return '';
    var parts = [];
    if (ds.lx && ds.lx.label) parts.push(ds.lx.label);
    if (ds.dw && ds.dw !== '无') parts.push(ds.dw);
    if (ds.zwzc && ds.zwzc !== '无') parts.push(ds.zwzc);
    return parts.join('，');
  }

  function dateOnly(value) {
    return String(value || '').slice(0, 10);
  }

  // ---------------------------------------------------------------- 前端适配器

  // 桌面版（layui）
  var DESKTOP = {
    key: 'desktop',
    label: '桌面版',
    listUrl: 'zxyy/xs/ajaxList',
    applyUrl: 'zxyy/xs/apply',
    status: {
      0: '已预约', 1: '预约已满', 2: '报名未开始',
      3: '报名已结束', 4: '可预约', 5: '已预填写'
    },
    notStarted: 2,

    matches: function () {
      return location.pathname.indexOf('/wjx/zxyy/xs') === 0;
    },

    // 批次下拉来自通用选择器接口
    loadBatches: function () {
      return post('common/selector', { a: 'b', clazz: 'ZxyyPc' }).then(function (res) {
        if (!res || res.code !== 0) return [];
        return (res.data || []).map(function (it) {
          return { id: it.value, name: it.label };
        });
      });
    },

    // 状态由服务端给出（yyzt）。万一缺失就按时间兜底推算。
    statusOf: function (row) {
      if (row.yyzt !== null && row.yyzt !== undefined && row.yyzt !== '') {
        return num(row.yyzt);
      }
      if (row.sfyy) return 0;
      if (num(row.yyrs) >= num(row.yyzdrs)) return 1;
      var open = ts(row.bmkssj);
      var close = open + num(row.bmyxsj) * 3600 * 1000;
      var now = serverNow();
      if (isFinite(open) && now < open) return 2;
      if (isFinite(close) && now > close) return 3;
      return 4;
    },

    normalize: function (row, params) {
      var code = DESKTOP.statusOf(row);
      return {
        pid: row.pid,
        batchId: (row.pc && row.pc.id) || params.batchId,
        batchName: (row.pc && row.pc.mc) || params.batchName || '',
        who: (row.ds && row.ds.name) || '',
        meta: metaOf(row.ds),
        dateRaw: dateOnly(row.yyrq),
        dateText: fmtDay(ts(row.yyrq)),
        timeText: (row.kssj || '?') + '-' + (row.jssj || '?'),
        openAt: ts(row.bmkssj),
        windowHours: num(row.bmyxsj),
        taken: num(row.yyrs),
        quota: num(row.yyzdrs),
        mine: !!row.sfyy,
        drafted: !!row.sfzc,
        statusCode: code,
        statusText: DESKTOP.status[code] || '未知状态',
        raw: row
      };
    },

    fetchPage: function (params) {
      var data = {
        page: params.page,
        limit: params.limit,
        'pc.id': params.batchId || '',
        'ds.name': params.keyword || ''
      };
      if (params.keyword) data['ds.name.op'] = 'ILIKE';

      return post(this.listUrl, data).then(function (res) {
        if (!res || res.code !== 0) {
          throw new Error('接口返回 code=' + (res && res.code) + '，msg=' + (res && res.msg));
        }
        return {
          rows: (res.data || []).map(function (row) { return DESKTOP.normalize(row, params); }),
          totalPages: res.totalPages || 1,
          count: res.count
        };
      });
    }
  };

  // 移动 / 微信版（Vant）
  var MOBILE = {
    key: 'mobile',
    label: '移动版',
    listUrl: 'wx/zxyy/zx/ajaxList',
    applyUrl: 'wx/zxyy/zx/apply',
    status: {
      1: '已预约', 2: '预约已满', 3: '报名未开始', 4: '报名已结束', 5: '可预约'
    },
    notStarted: 3,

    matches: function () {
      return location.pathname.indexOf('/wjx/wx/zxyy/zx') === 0;
    },

    // 批次是页面自己注入的全局变量 pcs
    loadBatches: function () {
      return Promise.resolve((window.pcs || []).map(function (it) {
        return { id: it.id, name: it.text };
      }));
    },

    // 与页面 wxZx.js 的 getStatus() 保持一致
    statusOf: function (slot) {
      if (slot.sfyy) return 1;
      if (num(slot.yyrs) >= num(slot.yyzdrs)) return 2;
      var open = ts(slot.bmkssj);
      var close = open + num(slot.bmyxsj) * 3600 * 1000;
      var now = serverNow();
      if (isFinite(open) && now < open) return 3;
      if (isFinite(close) && now > close) return 4;
      return 5;
    },

    normalize: function (teacher, slot, params) {
      var code = MOBILE.statusOf(slot);
      return {
        pid: slot.pid,
        batchId: params.batchId,
        batchName: params.batchName || '',
        who: teacher.name || '',
        meta: metaOf(teacher),
        dateRaw: dateOnly(slot.yyrq),
        dateText: fmtDay(ts(slot.yyrq)),
        timeText: (slot.kssj || '?') + '-' + (slot.jssj || '?'),
        openAt: ts(slot.bmkssj),
        windowHours: num(slot.bmyxsj),
        taken: num(slot.yyrs),
        quota: num(slot.yyzdrs),
        mine: !!slot.sfyy,
        drafted: !!slot.sfzc,
        statusCode: code,
        statusText: MOBILE.status[code] || '未知状态',
        raw: slot
      };
    },

    fetchPage: function (params) {
      return post(this.listUrl, {
        page: params.page,
        limit: params.limit,
        name: params.keyword || '',
        pcId: params.batchId || ''
      }).then(function (res) {
        if (!res || res.code !== 0) {
          throw new Error('接口返回 code=' + (res && res.code) + '，msg=' + (res && res.msg));
        }
        var rows = [];
        (res.data || []).forEach(function (teacher) {
          var slots = Array.isArray(teacher.zxList) ? teacher.zxList : [];
          slots.forEach(function (slot) {
            rows.push(MOBILE.normalize(teacher, slot, params));
          });
        });
        return { rows: rows, totalPages: res.totalPages || 1, count: res.count };
      });
    }
  };

  function currentFrontend() {
    var path = location.pathname;
    if (DESKTOP.matches(path)) return DESKTOP;
    if (MOBILE.matches(path)) return MOBILE;
    return null;
  }

  // ---------------------------------------------------------------- 业务
  function resolveBatchId(name) {
    if (!name) return '';
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].name === name) return batches[i].id;
    }
    return '';
  }

  // 分页取场次，直到翻完页数或到达上限
  async function collectRows(frontend, pageCount) {
    var params = {
      page: 1,
      limit: 50,
      batchId: resolveBatchId(config.batch),
      batchName: config.batch || '',
      keyword: config.keyword
    };
    var all = [];
    var totalPages = 1;

    while (params.page <= totalPages && params.page <= Math.min(pageCount, MAX_PAGES)) {
      var result = await frontend.fetchPage(params);
      all = all.concat(result.rows);
      totalPages = result.totalPages || 1;
      params.page += 1;
    }
    return all;
  }

  function matchesFilter(row) {
    if (config.keyword && String(row.who).indexOf(config.keyword) < 0) return false;
    if (config.date && row.dateRaw !== config.date) return false;
    return true;
  }

  /*
   * 第一阶段的红线。
   * 这里只组装请求体，供人核对；真正的发送属于第二阶段，
   * 并且届时也应当由使用者显式开启。
   */
  function wouldSubmit(frontend, row) {
    return {
      zxxx: row.pid,               // 场次 ID（不是导师 ID）
      sjhm: config.phone || '',    // 手机号
      sfzc: 0                      // false = 正式提交；true = 暂存（预填写）
      // `.me` 由页面的 $.ajax 包装自动附加，不在请求体里手写
    };
  }

  function maskPhone(v) {
    var s = String(v || '');
    if (s.length < 7) return s || '<未填写>';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  function countdown(target) {
    if (!isFinite(target)) return '—（无法解析报名时间）';
    var diff = target - serverNow();
    if (diff <= 0) return '已开始或已结束';
    var s = Math.floor(diff / 1000);
    return '+' + Math.floor(s / 3600) + ' 小时 '
      + Math.floor((s % 3600) / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  // ---------------------------------------------------------------- 报告
  function buildReport(frontend, row, batchName) {
    var close = row.openAt + row.windowHours * 3600 * 1000;
    var lines = [];

    lines.push('前端：' + frontend.label);
    lines.push('批次：' + (row.batchName || batchName || '（未筛选）'));
    lines.push('主讲人：' + row.who + (row.meta ? '（' + row.meta + '）' : ''));
    lines.push('场次 pid：' + row.pid);
    lines.push('预约时间：' + row.dateText + ' ' + row.timeText);
    lines.push('报名窗口：' + fmt(row.openAt) + ' → ' + fmt(close) + '（' + row.windowHours + ' 小时）');
    lines.push('名额：' + row.taken + '/' + row.quota);
    lines.push('我的状态：' + (row.mine ? '已预约' : '未预约') + ' / ' + (row.drafted ? '已暂存' : '未暂存'));
    lines.push('判定：' + row.statusText + '（状态码 ' + row.statusCode + '）');
    if (!row.quota) lines.push('注意：名额上限是 0，站点会把它判成「已满」。');
    lines.push('距报名开始：' + countdown(row.openAt));

    if (row.statusCode === frontend.notStarted && !row.drafted) {
      lines.push('提示：站点在此状态提供「预填写」（sfzc=true）。');
      lines.push('      正式开放时只需再发一次 sfzc=false，可以省掉现场填手机号的时间。');
    }

    lines.push('');
    lines.push('⚠ 若此刻提交，会发出：');
    lines.push('   POST /wjx/' + frontend.applyUrl);
    lines.push('   ' + JSON.stringify(wouldSubmit(frontend, row)));
    lines.push('   （手机号显示为 ' + maskPhone(config.phone) + '；本脚本不会发送这个请求）');

    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 第二阶段
  /*
   * 写入能力集中在这一段。默认「未武装」：不点武装按钮，就不会发出任何写请求，
   * 第一阶段那条红线在默认状态下依然成立。
   *
   * 关于触发时机：目前还没测出服务器用哪块表判定「报名开始」——
   *   - 若它用自己那块表（比标准时间快约 230 秒），真边界在 tOpen
   *   - 若它用标准时间，真边界在 tOpen + offset（也就是墙上时间印的那个点）
   * 所以两个候选边界都覆盖：从 tOpen 起试探，一直重试到后一个候选边界之后
   * STOP_MARGIN_MS 为止。中间用稀疏节奏，靠近任一候选边界时加密。
   * 代价是最坏情况下多打几十个请求，好处是不需要事先知道答案。
   */
  var STOP_MARGIN_MS = 30 * 1000;
  var lastPicked = null;

  var arm = {
    armed: false,
    done: false,
    inFlight: false,
    pid: null,
    row: null,
    label: '',
    tOpen: 0,
    tLate: 0,
    stopAt: 0,
    attempts: 0,
    errors: 0,
    timer: null
  };

  function siteBasePath() {
    var t = document.querySelector('title');
    return (t && t.getAttribute('data-p')) || '/wjx/';
  }

  // 服务端用它做模块级权限校验，值由页面渲染在 <title data-m="..."> 上
  function siteModuleId() {
    var t = document.querySelector('title');
    return (t && t.getAttribute('data-m')) || '';
  }

  // 与 jQuery 的 data 序列化保持一致
  function formEncode(obj) {
    return Object.keys(obj).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
    }).join('&');
  }

  /*
   * 唯一会写数据的地方。
   *
   * 刻意不用页面自己的 $.ajax：那套包装会在 code != 0 时弹 layer.alert，
   * 重试几十次就会糊满弹窗；它还有一层「相同请求去重」，我们也不需要。
   * 用 fetch 直接发，编码方式与 jQuery 序列化一致，同源自动带 cookie。
   */
  async function submitApply(pid, isDraft) {
    var frontend = currentFrontend();
    if (!frontend) throw new Error('当前页面不是已知的预约页面');

    var url = siteBasePath() + frontend.applyUrl;
    var body = formEncode({
      zxxx: pid,
      sjhm: config.phone || '',
      sfzc: isDraft ? 'true' : 'false',
      '.me': siteModuleId()
    });

    var t0 = Date.now();
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: body
    });
    calibrate(t0, Date.now(), { getResponseHeader: function (h) { return res.headers.get(h); } });

    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('响应不是 JSON（HTTP ' + res.status + '）：'
        + text.replace(/\s+/g, ' ').slice(0, 120));
    }
  }

  function nextBoundary(now) {
    var cands = [arm.tOpen, arm.tLate].sort(function (a, b) { return a - b; });
    for (var i = 0; i < cands.length; i++) {
      if (now < cands[i]) return cands[i];
    }
    return cands[cands.length - 1];
  }

  function setTarget(row) {
    if (!row) return;
    arm.pid = row.pid;
    arm.row = row;
    arm.label = row.who + ' · ' + row.dateText + ' ' + row.timeText;
    arm.tOpen = row.openAt;
    arm.tLate = row.openAt + Math.max(0, clockOffsetMs);
    arm.stopAt = arm.tLate + STOP_MARGIN_MS;
    arm.done = false;
    updateArmState();
  }

  function updateArmState() {
    if (!ui.armState) return;
    if (!arm.pid) {
      ui.armState.textContent = '未设定目标。先扫描，再点「设为目标」。';
      return;
    }
    var lines = ['目标：' + arm.label];
    lines.push('场次 pid：' + arm.pid);
    if (arm.armed) {
      var now = serverNow();
      lines.push('状态：已武装（已尝试 ' + arm.attempts + ' 次，失败 ' + arm.errors + ' 次）');
      lines.push('下一个候选边界：' + fmt(nextBoundary(now)) + '（' + countdown(nextBoundary(now)) + '）');
      lines.push('⚠ 请保持此标签页在前台：后台标签会被浏览器降频，可能错过边界。');
    } else if (arm.done) {
      lines.push('状态：已完成（共尝试 ' + arm.attempts + ' 次）');
    } else {
      lines.push('状态：未武装 —— 此状态下不会发出任何写请求。');
      lines.push('若服务器用它自己的表：边界 ' + fmt(arm.tOpen));
      lines.push('若服务器用标准时间：边界 ' + fmt(arm.tLate));
    }
    ui.armState.textContent = lines.join('\n');
  }

  /*
   * 这里是本阶段最需要克制的地方：唤醒频率。
   *
   * 关键点是「醒来的频率」和「要不要写」是两件事：
   *   - 离第一个候选边界还远时，醒来只做只读探活（顺便重新校时），
   *     一个 apply 都不发。所以提前几小时武装也不会打出一堆无效报名。
   *   - 只有进入 tOpen 前 ATTEMPT_LEAD_MS 之内，才切换成真正提交。
   *
   * 唤醒间隔按距离分档，最长 10 分钟一次；临近边界时逐级加密到 200 毫秒。
   * 两个候选边界都过去之后逐步退避，直到 stopAt。
   */
  var ATTEMPT_LEAD_MS = 2000;

  function nextDelay(now) {
    var nextB = nextBoundary(now);
    if (now < nextB) {
      var remain = nextB - now;
      if (remain > 3600000) return 600000;  // > 1 小时  → 10 分钟
      if (remain > 600000) return 120000;   // > 10 分钟 → 2 分钟
      if (remain > 120000) return 20000;    // > 2 分钟  → 20 秒
      if (remain > 30000) return 5000;
      if (remain > 3000) return 1500;
      return 200;
    }
    var past = now - nextB;
    return Math.min(5000, 800 + Math.floor(past / 5000) * 800);
  }

  function scheduleNext() {
    if (!arm.armed || arm.done) return;
    var now = serverNow();
    if (now > arm.stopAt) {
      disarm('已超过截止时间');
      return;
    }
    if (arm.timer) clearTimeout(arm.timer);
    arm.timer = setTimeout(armTick, nextDelay(now));
  }

  /*
   * 单个节拍：还早就只读探活，进入临门范围才提交。
   * inFlight 由这里统一持有，避免只读探活和提交叠在一起。
   */
  async function armTick() {
    if (!arm.armed || arm.done || arm.inFlight) return;
    arm.inFlight = true;
    try {
      if (serverNow() > arm.stopAt) {
        disarm('已超过截止时间');
        return;
      }
      if (serverNow() < arm.tOpen - ATTEMPT_LEAD_MS) {
        await probeTarget();
      } else {
        await attemptSubmit();
      }
    } finally {
      arm.inFlight = false;
      updateArmState();
    }
    scheduleNext();
  }

  // 只读探活：重新校时，并留意目标场次的状态有没有变化
  async function probeTarget() {
    try {
      var frontend = currentFrontend();
      var result = await frontend.fetchPage({
        page: 1,
        limit: 50,
        batchId: arm.row.batchId,
        batchName: arm.row.batchName,
        keyword: arm.row.who
      });
      var hit = null;
      result.rows.forEach(function (r) { if (r.pid === arm.pid) hit = r; });
      if (!hit) return;
      if (hit.taken !== arm.row.taken || hit.statusCode !== arm.row.statusCode) {
        arm.row = hit;
        arm.tOpen = hit.openAt;
        arm.tLate = hit.openAt + Math.max(0, clockOffsetMs);
        arm.stopAt = arm.tLate + STOP_MARGIN_MS;
        appendLog('目标状态变化：' + hit.statusText + '，名额 ' + hit.taken + '/' + hit.quota);
        updateArmState();
      }
    } catch (e) {
      appendLog('只读探活失败：' + (e && e.message ? e.message : e));
    }
  }

  async function attemptSubmit() {
    arm.attempts += 1;
    var succeeded = false;
    var aborted = false;

    try {
      var res = await submitApply(arm.pid, false);
      if (res && res.code === 0) {
        succeeded = true;
        arm.done = true;
        appendLog('✅ 提交成功（第 ' + arm.attempts + ' 次）：' + (res.msg || 'ok'));
        await verifyBooked();
      } else if (res && (res.code === -100 || res.code === -99)) {
        // 会话失效：继续重试没有意义，而且只会刷失败记录
        arm.errors += 1;
        appendLog('⚠ 会话已失效（code=' + res.code + '）：' + (res.msg || ''));
        appendLog('   停止尝试。请重新登录后再武装。');
        aborted = true;
      } else {
        arm.errors += 1;
        appendLog('第 ' + arm.attempts + ' 次未成功：'
          + ((res && res.msg) || ('code=' + (res && res.code))));
      }
    } catch (e) {
      arm.errors += 1;
      appendLog('第 ' + arm.attempts + ' 次请求异常：' + (e && e.message ? e.message : e));
    }

    if (succeeded) {
      disarm('已完成');
    } else if (aborted) {
      disarm('会话失效');
    }
  }

  // 命中之后回读一次，确认服务端真的记上了
  async function verifyBooked() {
    try {
      var frontend = currentFrontend();
      var result = await frontend.fetchPage({
        page: 1,
        limit: 50,
        batchId: arm.row.batchId,
        batchName: arm.row.batchName,
        keyword: arm.row.who
      });
      var hit = null;
      result.rows.forEach(function (r) { if (r.pid === arm.pid) hit = r; });
      if (!hit) {
        appendLog('回读确认：列表里没查到该场次，请手动核对。');
        return;
      }
      appendLog(hit.mine
        ? '回读确认：服务端已显示「已预约」。'
        : '回读确认：服务端还没显示「已预约」，请手动核对。');
    } catch (e) {
      appendLog('回读确认失败：' + (e && e.message ? e.message : e));
    }
  }

  function armTarget() {
    if (!arm.pid) {
      appendLog('请先「设为目标」。');
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(config.phone || '')) {
      appendLog('手机号没填或格式不对，先补上再武装。');
      return;
    }
    var frontend = currentFrontend();
    var preview = JSON.stringify(wouldSubmit(frontend, arm.row));
    var ok = window.confirm(
      '将在报名开始的瞬间自动提交下面的请求，可能会重复尝试几十次：\n\n'
      + '目标：' + arm.label + '\n'
      + 'POST ' + siteBasePath() + frontend.applyUrl + '\n'
      + preview + '\n\n'
      + '到点前请保持此标签页在前台。\n\n确定武装吗？'
    );
    if (!ok) return;

    arm.armed = true;
    arm.done = false;
    arm.attempts = 0;
    arm.errors = 0;
    arm.stopAt = arm.tLate + STOP_MARGIN_MS;
    appendLog('已武装：' + arm.label + '\n候选边界 '
      + fmt(arm.tOpen) + ' 与 ' + fmt(arm.tLate) + '（服务器口径）');
    updateArmState();
    armTick();   // 立刻做一次探活，之后按节奏走
  }

  function disarm(reason) {
    arm.armed = false;
    if (arm.timer) {
      clearTimeout(arm.timer);
      arm.timer = null;
    }
    if (reason) appendLog('已停止：' + reason);
    updateArmState();
  }

  async function prefillTarget() {
    if (!arm.pid) {
      appendLog('请先「设为目标」。');
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(config.phone || '')) {
      appendLog('手机号没填或格式不对。');
      return;
    }
    var ok = window.confirm(
      '将提交「预填写」（sfzc=true），把手机号暂存到：\n\n'
      + arm.label + '\n\n'
      + '这不是正式预约，开放时仍需再提交一次。\n\n确定吗？'
    );
    if (!ok) return;
    try {
      var res = await submitApply(arm.pid, true);
      appendLog(res && res.code === 0
        ? '预填写成功：' + (res.msg || 'ok')
        : '预填写失败：' + ((res && res.msg) || ('code=' + (res && res.code))));
    } catch (e) {
      appendLog('预填写异常：' + (e && e.message ? e.message : e));
    }
  }

  /*
   * 手动提交一次：不等时间窗口，立刻打一发 apply。
   *
   * 存在的意义是让「写请求到底通不通」这件事可以被验证 —— 找一个已经
   * 满员或已结束的场次当目标，提交会被服务端拒绝，但拒绝本身就证明了
   * 地址、`.me`、会话三者都是对的。否则在真批次到来之前，这条路径
   * 一次都没法试。
   */
  async function submitOnce() {
    if (!arm.pid) {
      appendLog('请先「设为目标」。');
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(config.phone || '')) {
      appendLog('手机号没填或格式不对。');
      return;
    }
    var frontend = currentFrontend();
    var ok = window.confirm(
      '立即提交一次，不等时间窗口：\n\n'
      + '目标：' + arm.label + '\n'
      + 'POST ' + siteBasePath() + frontend.applyUrl + '\n'
      + JSON.stringify(wouldSubmit(frontend, arm.row)) + '\n\n'
      + '这会发出一笔真实的报名请求。如果目标是已满或已结束的场次，\n'
      + '服务端会拒绝它 —— 拒绝恰好可以用来验证链路是通的。\n\n确定吗？'
    );
    if (!ok) return;
    try {
      var res = await submitApply(arm.pid, false);
      appendLog('手动提交返回：' + JSON.stringify(res));
      if (res && res.code === 0) await verifyBooked();
    } catch (e) {
      appendLog('手动提交异常：' + (e && e.message ? e.message : e));
    }
  }

  // ---------------------------------------------------------------- 面板
  var ui = {};

  function buildPanel(frontend) {
    var host = document.createElement('div');
    host.id = 'jxzx-dryrun-panel';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
    document.body.appendChild(host);

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      '.wrap{font:12px/1.6 -apple-system,"Segoe UI",sans-serif;color:#1f2329;',
      '  background:#fff;border:1px solid #d9dde3;border-radius:10px;width:390px;',
      '  box-shadow:0 8px 28px rgba(0,0,0,.18);overflow:hidden}',
      '.hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#0c4eb0;color:#fff}',
      '.hd .grow{flex:1}',
      '.tag{background:rgba(255,255,255,.22);border-radius:4px;padding:1px 6px;font-size:11px}',
      '.hd button{background:transparent;border:0;color:#fff;cursor:pointer;font-size:14px}',
      '.bd{padding:10px;max-height:70vh;overflow:auto}',
      '.bd.collapsed{display:none}',
      'label{display:block;margin-bottom:6px}',
      'label span{display:block;color:#5b6472;font-size:11px;margin-bottom:2px}',
      'input,select{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid #d0d5dd;',
      '  border-radius:5px;font-size:12px;background:#fff;color:#1f2329}',
      '.row{display:flex;gap:6px;margin:8px 0}',
      '.row button{flex:1;padding:6px 0;border-radius:6px;border:1px solid #0c4eb0;',
      '  background:#0c4eb0;color:#fff;cursor:pointer;font-size:12px}',
      '.row button.ghost{background:#fff;color:#0c4eb0}',
      '.row button:disabled{opacity:.45;cursor:not-allowed}',
      '.clock{background:#f4f6f9;border-radius:6px;padding:5px 7px;color:#5b6472;margin-bottom:6px}',
      'pre{margin:0;background:#1f2329;color:#d7dae0;border-radius:6px;padding:8px;',
      '  max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px}',
      'hr{border:0;border-top:1px solid #e6e8eb;margin:8px 0}',
      '.armState{margin:0 0 6px;background:#fff7e6;border:1px solid #ffd591;border-radius:6px;',
      '  padding:6px;white-space:pre-wrap;font-size:11px;color:#7a4b00;line-height:1.5}',
      '.armState.armed{background:#fff1f0;border-color:#ffa39e;color:#a8071a}',
      '.row button.danger{background:#d93026;border-color:#d93026}',
      '.note{margin-top:6px;color:#98a2b3;font-size:11px}'
    ].join('');
    root.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = [
      '<div class="hd">',
      '  <span>导师交流预约助手</span>',
      '  <span class="tag">只读 · 干跑</span>',
      '  <span class="grow"></span>',
      '  <button id="toggle" title="折叠/展开">—</button>',
      '</div>',
      '<div class="bd" id="body">',
      '  <label><span>批次</span><select id="batch"></select></label>',
      '  <label><span>主讲人（支持部分匹配，留空=第一条）</span><input id="keyword"></label>',
      '  <label><span>目标预约日期（YYYY-MM-DD，留空=第一条）</span><input id="date"></label>',
      '  <label><span>手机号（仅用于预演请求体）</span><input id="phone"></label>',
      '  <label><span>轮询间隔（秒，下限 2）</span><input id="interval" type="number" min="2"></label>',
      '  <div class="row">',
      '    <button id="scan">单次扫描</button>',
      '    <button id="watch">开始监视</button>',
      '    <button id="clear" class="ghost">清除配置</button>',
      '  </div>',
      '  <hr>',
      '  <div class="row">',
      '    <button id="setTarget" class="ghost">设为目标</button>',
      '    <button id="prefill" class="ghost">预填写</button>',
      '  </div>',
      '  <div class="row">',
      '    <button id="armBtn" class="danger">武装：到点自动提交</button>',
      '    <button id="disarmBtn" class="ghost">停止</button>',
      '  </div>',
      '  <div class="row">',
      '    <button id="submitOnceBtn" class="ghost">立即提交一次（用于验证链路）</button>',
      '  </div>',
      '  <div class="armState" id="armState">未设定目标</div>',
      '  <div class="clock" id="clock">时钟：未校准</div>',
      '  <pre id="log"></pre>',
      '  <div class="note">未武装时只调用列表接口（查询）。武装后才会调用 apply。</div>',
      '</div>'
    ].join('');
    root.appendChild(wrap);

    ui.$ = function (id) { return root.getElementById ? root.getElementById(id) : null; };
    ui.batch = ui.$('batch');
    ui.keyword = ui.$('keyword');
    ui.date = ui.$('date');
    ui.phone = ui.$('phone');
    ui.interval = ui.$('interval');
    ui.scan = ui.$('scan');
    ui.watch = ui.$('watch');
    ui.clear = ui.$('clear');
    ui.setTarget = ui.$('setTarget');
    ui.prefill = ui.$('prefill');
    ui.armBtn = ui.$('armBtn');
    ui.disarmBtn = ui.$('disarmBtn');
    ui.submitOnceBtn = ui.$('submitOnceBtn');
    ui.armState = ui.$('armState');
    ui.body = ui.$('body');
    ui.clock = ui.$('clock');
    ui.log = ui.$('log');

    ui.keyword.value = config.keyword;
    ui.date.value = config.date;
    ui.phone.value = config.phone;
    ui.interval.value = config.intervalSec;

    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '（全部批次）';
    ui.batch.appendChild(empty);

    function collect() {
      config.batch = ui.batch.value;
      config.keyword = ui.keyword.value.trim();
      config.date = ui.date.value.trim();
      config.phone = ui.phone.value.trim();
      config.intervalSec = Math.max(MIN_INTERVAL_MS / 1000, Number(ui.interval.value) || 5);
      ui.interval.value = config.intervalSec;
      saveConfig();
    }

    ui.scan.addEventListener('click', function () { collect(); runScan(true); });
    ui.watch.addEventListener('click', function () {
      collect();
      if (timer) stopWatch(); else startWatch();
    });
    ui.clear.addEventListener('click', function () {
      stopWatch();
      try { localStorage.removeItem(CFG_KEY); } catch (e) { /* 忽略 */ }
      config = { batch: '', keyword: '', date: '', phone: '', intervalSec: 5 };
      ui.batch.value = '';
      ui.keyword.value = '';
      ui.date.value = '';
      ui.phone.value = '';
      ui.interval.value = 5;
      setLog('配置已清除。');
    });
    ui.$('toggle').addEventListener('click', function () {
      ui.body.classList.toggle('collapsed');
    });

    // 设为目标：用一次新扫描的结果，避免拿着过期的行去武装
    ui.setTarget.addEventListener('click', async function () {
      collect();
      var row = await runScan(true);
      if (!row) return;
      setTarget(row);
      appendLog('目标已设定：' + arm.label + '\n候选边界 '
        + fmt(arm.tOpen) + ' 与 ' + fmt(arm.tLate) + '（服务器口径）');
    });

    ui.prefill.addEventListener('click', function () { collect(); prefillTarget(); });
    ui.armBtn.addEventListener('click', function () { collect(); armTarget(); });
    ui.disarmBtn.addEventListener('click', function () { disarm('手动停止'); });
    ui.submitOnceBtn.addEventListener('click', function () { collect(); submitOnce(); });

    setInterval(updateClock, 1000);
    updateClock();
    loadBatchOptions(frontend);
  }

  function loadBatchOptions(frontend) {
    frontend.loadBatches().then(function (list) {
      batches = list || [];
      batches.forEach(function (b) {
        var opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = b.name;
        ui.batch.appendChild(opt);
      });
      if (config.batch) ui.batch.value = config.batch;
    }).catch(function (e) {
      appendLog('批次列表加载失败：' + (e && e.message ? e.message : e));
    });
  }

  function setLog(text) {
    if (ui.log) ui.log.textContent = text;
  }

  function appendLog(text) {
    if (!ui.log) return;
    ui.log.textContent = (ui.log.textContent ? ui.log.textContent + '\n\n' : '') + text;
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function updateClock() {
    if (ui.clock) {
      ui.clock.textContent = clockSamples
        ? '服务器时间：' + fmt(serverNow())
          + '｜偏差 ' + (clockOffsetMs >= 0 ? '+' : '') + (clockOffsetMs / 1000).toFixed(2) + 's'
          + '（正数 = 服务器快）｜样本 ' + clockSamples
        : '时钟：未校准（扫描一次后生效）';
    }
    if (ui.armState) ui.armState.className = arm.armed ? 'armState armed' : 'armState';
    updateArmState();
  }

  // ---------------------------------------------------------------- 扫描
  async function runScan(manual) {
    if (busy) return null;
    var frontend = currentFrontend();
    if (!frontend) return null;

    busy = true;
    if (ui.scan) ui.scan.disabled = true;
    try {
      var rows = await collectRows(frontend, 1);
      var picked = rows.filter(matchesFilter);

      if (!rows.length) {
        setLog('这个批次下没有查到任何场次。\n\n'
          + '前端：' + frontend.label + '\n批次：' + (config.batch || '（全部）')
          + '\n\n要么场次还没发布，要么该批次已经结束。'
          + '持续监视会在场次出现时自动报告。');
        return null;
      }
      if (!picked.length) {
        setLog('查到 ' + rows.length + ' 条场次，但没有匹配当前筛选条件的。\n\n'
          + '主讲人关键词：' + (config.keyword || '（无）')
          + '\n目标日期：' + (config.date || '（无）'));
        return null;
      }

      lastPicked = picked[0];
      var signature = picked.map(function (r) {
        return r.pid + ':' + r.taken + '/' + r.quota + ':'
          + (r.mine ? 1 : 0) + ':' + (r.drafted ? 1 : 0) + ':' + r.statusCode;
      }).join('|');

      if (manual || signature !== lastSignature) {
        lastSignature = signature;
        appendLog('[' + stamp() + ']\n' + buildReport(frontend, picked[0], config.batch));
      }
      return picked[0];
    } catch (e) {
      appendLog('扫描失败：' + (e && e.message ? e.message : e));
      return null;
    } finally {
      busy = false;
      if (ui.scan) ui.scan.disabled = false;
      updateClock();
    }
  }

  function startWatch() {
    var intervalMs = Math.max(MIN_INTERVAL_MS, config.intervalSec * 1000);
    timer = setInterval(function () { runScan(false); }, intervalMs);
    if (ui.watch) ui.watch.textContent = '停止监视';
    appendLog('开始监视，每 ' + (intervalMs / 1000) + ' 秒扫描一次（仅查询）。');
    runScan(false);
  }

  function stopWatch() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (ui.watch) ui.watch.textContent = '开始监视';
  }

  // ---------------------------------------------------------------- 启动
  function waitFor(predicate, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function loop() {
        if (predicate()) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('等待页面依赖超时'));
        setTimeout(loop, 200);
      })();
    });
  }

  // ---------------------------------------------------------------- 调试出口
  // 便于在 DevTools 控制台或离线测试里单独调用内部逻辑。全部是只读能力，
  // 不提供任何可以真正提交预约的入口。
  window.__JXZX_DRYRUN_API__ = {
    frontend: currentFrontend,
    serverNow: serverNow,
    wouldSubmit: wouldSubmit,
    buildReport: buildReport,
    runScan: runScan,
    // 第二阶段：唯一的写入入口。不调用它就不会有任何写请求。
    submitApply: submitApply,
    setTarget: setTarget,
    armTarget: armTarget,
    disarm: disarm,
    submitOnce: submitOnce,
    getArm: function () { return arm; },
    getBatches: function () { return batches; },
    getLog: function () { return ui.log ? ui.log.textContent : ''; }
  };

  waitFor(function () {
    return !!(window.$ && window.moment);
  }, 15000).then(function () {
    var frontend = currentFrontend();
    if (!frontend) {
      console.warn('[jxzx] 当前 URL 不是已知的预约页面。');
      return;
    }
    buildPanel(frontend);
  }).catch(function () {
    // 走到这里通常是：没有登录、被跳转到「没有权限访问」页，或者页面结构变了
    console.warn('[jxzx] 未能在当前页面初始化：缺少 $ / moment。'
      + '请确认已登录且处在「在线预约」页面上。');
  });
})();
