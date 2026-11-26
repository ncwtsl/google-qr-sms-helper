"use strict";

// ---------------------------------------------------------------- UA 常量
const IPAD_MINI_UA =
  "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const STRIP_CH_UA = [
  "Sec-CH-UA",
  "Sec-CH-UA-Mobile",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness",
].map((h) => ({ header: h, operation: "remove" }));

const UA_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "other"];

// 规则1：验证链路 → iPad Mini（选择页/验证码页也保持 iPad）
// 规则2：/devicephoneverification/* → iPhone（后台模拟手机扫码，优先级更高）
// 注意：绝不能把 UA 规则铺到 accounts.google.com 全站——登录/账号选择页用 iPad UA 会被 Google 判
// 「此浏览器或应用可能不安全」( /v3/signin/rejected )，正常登录直接进不去。
// 只对 IDV 验证链路（challenge/uplevelingstep/devicephoneverification）伪装。
const IPAD_PATHS = [
  "||accounts.google.com/v3/signin/challenge/",
  "||accounts.google.com/uplevelingstep",
];

function setupRules() {
  const rules = [];
  let id = 1;
  for (const urlFilter of IPAD_PATHS) {
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "User-Agent", operation: "set", value: IPAD_MINI_UA },
          ...STRIP_CH_UA,
        ],
      },
      condition: { urlFilter, resourceTypes: UA_TYPES },
    });
  }
  rules.push({
    id: id++,
    priority: 10,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "User-Agent", operation: "set", value: IPHONE_UA },
        ...STRIP_CH_UA,
      ],
    },
    condition: {
      urlFilter: "||accounts.google.com/devicephoneverification/",
      resourceTypes: UA_TYPES,
    },
  });

  chrome.declarativeNetRequest
    .updateDynamicRules({
      removeRuleIds: [1, 2, 3, 4, 5],
      addRules: rules,
    })
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);
setupRules();

// ---------------------------------------------------------------- 自动补注入
// Google 的登录/验证链路是「重定向链 + SPA 路由」，document_idle 的 content script 经常只在中间页
// 触发一次，落到 /challenge/iap/qrcode 这个最终页时面板就没了（用户看到的就是"插件没反应"）。
// 这里在导航/路由完成后主动补注入一次；content.js 自己有 __qrsmsPanelMounted 去重。
const INJECT_URLS = [/\/challenge\/iap\/(qrcode|uplevelingstep)/, /\/uplevelingstep/, /\/challenge\/iap(\?|$)/];
function maybeInject(details) {
  if (details.frameId !== 0) return;
  const url = details.url || "";
  if (!/^https:\/\/accounts\.google\.com\//.test(url)) return;
  if (!INJECT_URLS.some((re) => re.test(url.replace(/^https:\/\/accounts\.google\.com/, "")))) return;
  chrome.scripting
    .executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      files: ["content.js"],
    })
    .catch(() => {});
}
if (chrome.webNavigation) {
  chrome.webNavigation.onCompleted.addListener(maybeInject);
  chrome.webNavigation.onHistoryStateUpdated.addListener(maybeInject);
}

// ---------------------------------------------------------------- 工具
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

// 本地调试接收端（可选）：不监听就一直静默失败，不影响功能。
const DEBUG_SINK = "http://127.0.0.1:8799/";
function dump(name, data) {
  try {
    fetch(DEBUG_SINK, { method: "POST", body: JSON.stringify({ name, data }) }).catch(() => {});
  } catch (e) {}
}

async function fetchText(url) {
  const r = await fetch(url, {
    credentials: "include",
    redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  return { url: r.url || url, status: r.status, text: await r.text() };
}

const unesc = (s) => s.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");

function pickBeginPath(html) {
  const m = html.match(/devicephoneverification\/begin\?[^"'\s<>\\]+/);
  return m ? unesc(m[0]).replace(/&quot;.*$/, "") : "";
}

function pickTokens(html, srcUrl) {
  const at = (html.match(/"SNlM0e"\s*:\s*"([^"]+)"/) || [])[1] || "";
  const dsh =
    (html.match(/"Qzxixc"\s*:\s*"([^"]+)"/) || [])[1] ||
    (srcUrl && (srcUrl.match(/[?&]dsh=([^&"'\s]+)/) || [])[1]) ||
    "";
  // 会话失效判定：begin/initiate 页会给 AF_initDataCallback({key:'ds:0', data:[9], errorHasStatus: true})
  // 这时页面里只剩 plt（request:["AKgns..."]），拿去当 tl 打 MypxBd 只会得到 payload [3]（无 consent 无 UUID）
  const expired = /errorHasStatus\s*:\s*true/.test(html) || /key:\s*['"]ds:0['"]\s*,\s*(?:hash:\s*'[^']*'\s*,\s*)?data:\s*\[\s*9\s*\]/.test(html);
  let tl = "";
  const ds0 = html.match(/key:\s*['"]ds:0['"][^}]{0,200}?data:\["([^"]+)"/);
  if (ds0) tl = ds0[1];
  else if (!expired) {
    // AF_dataServiceRequests 形态：{'ds:0' : {id:'O6uebe',request:["AKgns..."]}} —— 这是 plt，只有会话正常时才可当 tl 兜底
    const req = html.match(/['"]ds:0['"][^}]{0,200}?request:\["([^"]+)"/);
    if (req) tl = req[1];
  }
  if (!tl) {
    const adg = html.match(/ADG-[A-Za-z0-9_\-]{20,}/);
    if (adg) tl = adg[0];
  }
  // 实在没有就用 URL 上的 plt（begin 页的 plt 就是 RPC 的 tl）
  if (!tl && srcUrl) {
    const mp = srcUrl.match(/[?&]plt=([^&]+)/);
    if (mp) tl = decodeURIComponent(mp[1]);
  }
  if (!tl && srcUrl) {
    const m = srcUrl.match(/[?&]TL=([^&]+)/) || srcUrl.match(/[?&]tl=([^&]+)/);
    if (m) tl = decodeURIComponent(m[1]);
  }
  const plt = (srcUrl && ((srcUrl.match(/[?&]plt=([^&"'\s]+)/) || [])[1] || "")) || "";
  return { at, dsh, tl, plt, expired };
}

function uuidFromHtml(html) {
  const out = [];
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const all = html.match(re) || [];
  for (const v of all) if (!out.includes(v)) out.push(v);
  return out;
}

// 页面的 ds:0 服务请求（consent 页用 yIUmVe、initiate 页用 O6uebe），拿它再打一次才能真正拿到内容
function pickDataService(html) {
  const m = html.match(/AF_dataServiceRequests\s*=\s*\{\s*'ds:0'\s*:\s*\{id:'([^']+)',request:(\[[\s\S]*?\])\s*\}/);
  if (!m) return null;
  try {
    return { id: m[1], request: JSON.parse(m[2]) };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- RPC
const DEV_BASE =
  "https://accounts.google.com/devicephoneverification/_/DevicePhoneVerificationUi/data/batchexecute";

async function callRpc(rpcid, payload, sourcePath, tokens) {
  const url =
    `${DEV_BASE}?rpcids=${rpcid}&source-path=${sourcePath}` +
    `&hl=en&tl=${encodeURIComponent(tokens.tl || "")}&rt=c`;
  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]),
  });
  if (tokens.at) body.set("at", tokens.at);
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "X-Same-Domain": "1",
    },
    body: body.toString(),
  });
  return { status: r.status, text: await r.text() };
}

const MAGIC = /\[\s*3\s*,\s*null\s*,\s*4\s*\]/;

async function rpcAttempt(tokens, tag, log) {
  const note = (s) => log.push(s);
  note(`[${tag}] tl=${tokens.tl ? tokens.tl.slice(0, 12) + "…" : "缺"} dsh=${tokens.dsh || "缺"} at=${tokens.at ? "有" : "缺"}`);

  const mp = await callRpc(
    "MypxBd",
    [tokens.tl, tokens.dsh, false, null, null, false, null, null, "browser"],
    "%2Fdevicephoneverification%2Finitiate",
    tokens
  );
  note(`[${tag}] MypxBd ${mp.status} ${oneLine(mp.text).slice(0, 100)}`);
  dump(`${tag}-MypxBd`, JSON.stringify({ tokens: { ...tokens, at: tokens.at ? "yes" : "" }, status: mp.status, body: mp.text }, null, 2));

  const consentUrl =
    `https://accounts.google.com/devicephoneverification/consent?flow=browser` +
    `&plt=${encodeURIComponent(tokens.plt || tokens.tl)}` +
    `&dsh=${encodeURIComponent(tokens.dsh)}&hl=en&tl=${encodeURIComponent(tokens.tl)}`;
  const consent = await fetchText(consentUrl);
  note(`[${tag}] consent ${consent.status} ${consent.text.length}B → ${consent.url.slice(0, 70)}`);
  dump(`${tag}-consent`, consent.text);

  const uuids = uuidFromHtml(consent.text);
  if (!uuids.length && consent.url) uuids.push(...uuidFromHtml(consent.url));
  if (!uuids.length) uuids.push(...uuidFromHtml(mp.text));

  if (!uuids.length) {
    const svc = pickDataService(consent.text);
    note(`[${tag}] consent ds:0 service=${svc ? svc.id : "无"}`);
    if (svc) {
      const sr = await callRpc(svc.id, svc.request, "%2Fdevicephoneverification%2Fconsent", tokens);
      note(`[${tag}] ${svc.id} ${sr.status} ${oneLine(sr.text).slice(0, 120)}`);
      dump(`${tag}-${svc.id}`, sr.text);
      uuids.push(...uuidFromHtml(sr.text));
    }
  }
  note(`[${tag}] uuid=${uuids.length ? uuids[0] : "无"}`);
  if (!uuids.length) {
    return { hit: false, status: consent.status, uuid: "", ydText: "", reason: "consent 页没有 UUID" };
  }

  const uuid = uuids[0];
  const yd = await callRpc(
    "YDtwf",
    [null, uuid, tokens.dsh, 7, null, tokens.tl, false],
    "%2Fdevicephoneverification%2Fmodacintro",
    tokens
  );
  note(`[${tag}] YDtwf ${yd.status} ${oneLine(yd.text).slice(0, 100)}`);
  return { hit: MAGIC.test(yd.text), status: yd.status, uuid, ydText: yd.text, reason: "" };
}

async function tokensFromBegin(qrUrl, log, forceFresh) {
  const note = (s) => log.push(s);
  let qr = String(qrUrl || "").trim();
  if (!qr) return null;
  // begin 页每次抓取都可能让 plt 轮换/消耗，短期缓存避免重复抓
  const cacheKey = "beginTokens";
  try {
    if (forceFresh) await chrome.storage.session.remove(cacheKey);
    else {
      const c = (await chrome.storage.session.get(cacheKey))[cacheKey];
      if (c && c.url === qr && Date.now() - c.ts < 120000) {
        note("复用 2 分钟内的 begin 令牌");
        return c.tokens;
      }
    }
  } catch (e) {}
  if (/g\.co\/verify\//.test(qr)) {
    const shortUrl = qr.startsWith("http") ? qr : "https://" + qr;
    const s = await fetchText(shortUrl);
    note(`短链 ${s.status} → ${s.url.slice(0, 70)}`);
    dump("short-link", JSON.stringify({ status: s.status, finalUrl: s.url, html: s.text }, null, 2));
    if (/devicephoneverification\/begin\?/.test(s.url)) qr = s.url;
    else {
      const p = pickBeginPath(s.text);
      if (p) qr = "https://accounts.google.com/" + p;
    }
  }
  if (!/devicephoneverification\/begin\?/.test(qr)) {
    const m = unesc(qr).match(/devicephoneverification\/begin\?[^"'\s<>]+/);
    if (!m) {
      note("二维码内容里没有 begin 链接");
      return null;
    }
    qr = "https://accounts.google.com/" + m[0];
  }
  const begin = await fetchText(qr);
  note(`begin ${begin.status} ${begin.text.length}B`);
  dump("begin", JSON.stringify({ status: begin.status, finalUrl: begin.url, html: begin.text }, null, 2));
  const t = pickTokens(begin.text, begin.url);
  note(`begin 令牌 tl=${t.tl ? t.tl.slice(0, 10) + "…" : "缺"} dsh=${t.dsh ? "有" : "缺"} at=${t.at ? "有" : "缺"} expired=${t.expired ? "是" : "否"}`);
  if (t.expired) return { expired: true, tl: t.tl, dsh: t.dsh, at: t.at, plt: t.plt };
  if (t.tl && t.dsh) {
    try {
      await chrome.storage.session.set({ [cacheKey]: { url: qrUrl, tokens: t, ts: Date.now() } });
    } catch (e) {}
  }
  return t.tl && t.dsh ? t : null;
}

// ---------------------------------------------------------------- 主流程
async function handleDowngrade(payload) {
  const log = [];
  const note = (s) => log.push(s);
  const t0 = Date.now();
  const result = { ok: false, hit: false, log, uuid: "", ydStatus: 0, ydResp: "" };

  try {
    const page = payload || {};
    let tokens = {
      at: page.at || "",
      dsh: page.dsh || "",
      tl: page.tl || "",
    };
    note(`页面参数 at=${tokens.at ? "有" : "缺"} dsh=${tokens.dsh || "缺"} tl=${(tokens.tl || "").slice(0, 12)}`);

    // 二维码解出的是 devicephoneverification/begin?...（带 plt+dsh）时，先拿 begin 页令牌
    const directBegin = /devicephoneverification\/begin\?/.test(String(page.qrUrl || ""));
    if (directBegin) {
      const t = await tokensFromBegin(page.qrUrl, log);
      if (t && t.expired) {
        // 二维码会话已被消耗/超时：begin 页只剩 plt，硬打只会得到 payload [3]
        const err = new Error(
          "二维码会话已失效（begin 页返回 errorHasStatus/data:[9]）。请按 F5 刷新这个二维码页，拿到新二维码后再点「一键降级」——不要连续重复点，每点一次都会消耗当前二维码。"
        );
        err.expired = true;
        throw err;
      }
      // begin 页自己的 at/dsh/tl 才与这次设备验证流程绑定，优先用它
      if (t) tokens = { at: t.at || tokens.at, dsh: t.dsh, tl: t.tl };
    } else if (!tokens.tl || !tokens.dsh) {
      const t = await tokensFromBegin(page.qrUrl, log);
      if (t && !t.expired) tokens = { at: tokens.at || t.at, dsh: t.dsh, tl: t.tl };
    }
    if (!tokens.tl || !tokens.dsh) throw new Error("没拿到 tl / dsh（页面参数和 begin 页都没有）");

    let r = await rpcAttempt(tokens, directBegin ? "begin令牌" : "页面令牌", log);
    // 一轮不成就再取一次 begin 令牌重打（最多再来一轮；反复抓 begin 会把 plt 消耗掉，反而让会话失效）
    if (!r.hit && page.qrUrl && !directBegin) {
      const t2 = await tokensFromBegin(page.qrUrl, log);
      if (t2 && !t2.expired && (t2.tl !== tokens.tl || t2.dsh !== tokens.dsh)) {
        r = await rpcAttempt(t2, "begin 令牌", log);
      }
    }

    Object.assign(result, {
      ok: true,
      hit: r.hit,
      uuid: r.uuid,
      ydStatus: r.status,
      ydResp: oneLine(r.ydText).slice(0, 400),
      reason: r.reason,
      elapsed: Date.now() - t0,
    });
    note(result.hit ? "✅ 命中 [3,null,4]" : "❌ 未命中 [3,null,4]");
  } catch (e) {
    result.error = String((e && e.message) || e);
    result.expired = Boolean(e && e.expired);
    note("异常: " + result.error);
  }
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "downgradeQr") {
    handleDowngrade(msg).then(sendResponse);
    return true;
  }
  if (msg && msg.action === "dump") {
    dump(msg.name || "probe", msg.data);
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.action === "ping") {
    sendResponse({ ok: true, ua: IPAD_MINI_UA });
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- 自动流水线（默认关闭）
// 目标：不碰系统鼠标键盘，全部在浏览器内部用 DOM/脚本推进整条链路。
// 默认 false —— 见 README「手动模式」一节。
const cfg = {
  account: "",        // 填你的 Google 账号前缀（@ 之前那一段）
  pwd: "",            // 填你的 Google 密码
  dial: "",           // 国际区号，例如 57 / 55 / 1
  national: "",       // 本地号码（不含区号）
  autoFill: false,     // true = 短信页自动填号并提交
};
const flow = { enabled: false, allowCreate: false, busy: false, last: "", log: [] };
function flowNote(s) {
  flow.log.push(new Date().toISOString().slice(11, 19) + " " + s);
  if (flow.log.length > 150) flow.log.shift();
  dump("flow-log", flow.log.join("\n"));
}

function pageStep(c) {
  const url = location.href;
  const path = location.pathname;
  const out = { url, action: "none" };
  const byText = (re) =>
    Array.from(document.querySelectorAll("button, div[role='button'], a")).find((b) =>
      re.test((b.textContent || "").trim())
    );

  if (/recaptcha/.test(url)) {
    out.action = "need-recaptcha";
    return out;
  }

  if (/accountchooser/.test(path) || /\/signin\/identifier/.test(path) || /^\/AddSession/.test(path)) {
    // 先按账号行点选（已登录过该账号的 profile）
    const rows = Array.from(
      document.querySelectorAll("[data-identifier], li, div[role='link'], a[href*='signin']")
    );
    const hit = rows.find((e) =>
      ((e.getAttribute("data-identifier") || "") + " " + (e.textContent || "")).toLowerCase().includes(String(c.account || "").toLowerCase())
    );
    if (hit) {
      hit.click();
      out.action = "click-account";
      return out;
    }
    // 没有账号行 → 直接填邮箱
    const id = document.querySelector("#identifierId, input[name='identifier'], input[type='email']");
    if (id) {
      if (!id.value) {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        d.set.call(id, c.account);
        id.dispatchEvent(new Event("input", { bubbles: true }));
        out.action = "fill-identifier";
        return out;
      }
      const nx = byText(/^(下一步|Next)$/);
      if (nx) {
        nx.click();
        out.action = "identifier-next";
        return out;
      }
    }
    out.action = "no-account";
    return out;
  }

  if (/\/challenge\/pwd/.test(url)) {
    const inp = document.querySelector('input[type="password"]');
    if (!inp) {
      out.action = "no-pwd-input";
      return out;
    }
    if (!inp.value) {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      d.set.call(inp, c.pwd);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      out.action = "fill-pwd";
      return out;
    }
    const next = byText(/^(下一步|Next)$/);
    if (next) {
      next.click();
      out.action = "pwd-next";
      return out;
    }
    out.action = "pwd-no-next";
    return out;
  }

  if (/\/challenge\/iap\/qrcode/.test(url)) {
    out.action = "qr-page";
    return out;
  }

  if (/\/challenge\/(iap|uplevelingstep)/.test(url)) {
    // 默认不自动填号、不自动提交 —— 全部交给面板按钮（用户要求手动）
    if (!c.autoFill) {
      out.action = "sms-manual";
      return out;
    }
    // 短信验证码页：Google 的号码框是受控输入，一次性插「完整国际号」它自己会切国家，
    // 也不会叠串（拆成「切国家 + 只填本地号」会被受控输入重排成 18 位垃圾串）。
    const tel = document.querySelector(
      'input[type="tel"], input[name="phoneNumber"], input[jsname="YPqjbf"]'
    );
    if (tel) {
      const want = "+" + c.dial + c.national;
      const digits = (tel.value || "").replace(/[^\d]/g, "");
      const country = (document.querySelector("div[role='combobox']") || {}).textContent || "";
      if (digits.indexOf(c.dial + c.national) === -1 || digits.length > want.replace(/[^\d]/g, "").length) {
        tel.focus();
        const di = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        di.set.call(tel, "");
        tel.dispatchEvent(new Event("input", { bubbles: true }));
        document.execCommand("insertText", false, want);
        if ((tel.value || "").replace(/[^\d]/g, "").indexOf(c.dial + c.national) === -1) {
          di.set.call(tel, want);
          tel.dispatchEvent(new Event("input", { bubbles: true }));
        }
        out.action = "fill-number:" + (tel.value || "") + " | " + country.replace(/\s+/g, " ").trim();
        return out;
      }
      const next = byText(/^(下一步|Next)$/);
      if (next && next.getBoundingClientRect().width > 0) {
        next.click();
        out.action = "sms-next";
        return out;
      }
      out.action = "sms-wait";
      return out;
    }
    out.action = "sms-no-input";
    return out;
  }
  return out;
}

const START_URL =
  "https://accounts.google.com/AddSession?continue=https%3A%2F%2Fconsole.cloud.google.com%2Fwelcome%2Fnew&hl=zh-CN";
// 只用自己创建的后台标签，绝不碰用户正在用的标签页
async function pickTab() {
  if (flow.tabId) {
    try {
      const t = await chrome.tabs.get(flow.tabId);
      if (t && t.id && !t.discarded) return t;
    } catch (e) {
      flow.tabId = null;
    }
  }
  try {
    if (!flow.allowCreate) { flowNote("手动模式：不自建标签（请自行打开 Google 登录页）"); return null; }
    const t = await chrome.tabs.create({ url: START_URL, active: false });
    flow.tabId = t.id;
    flowNote("新建后台标签 " + t.id);
    return t;
  } catch (e) {
    flowNote("tabs.create 失败: " + ((e && e.message) || e));
    return null;
  }
}

async function clickRecaptcha(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (e) {
    /* 已经 attach 过 */
  }
  try {
    const r = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression:
        "(()=>{const f=Array.from(document.querySelectorAll('iframe')).find(i=>/recaptcha/i.test(i.src||'')||/recaptcha/i.test(i.title||''));if(!f)return 'no-iframe';const b=f.getBoundingClientRect();return JSON.stringify({x:Math.round(b.left+30),y:Math.round(b.top+30),w:Math.round(b.width),h:Math.round(b.height)});})()",
      returnByValue: true,
    });
    const v = r && r.result && r.result.value;
    if (!v || v === "no-iframe") return "no-iframe";
    const box = JSON.parse(v);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type, x: box.x, y: box.y, button: "left", clickCount: 1,
      });
      await new Promise((r2) => setTimeout(r2, 120));
    }
    return "clicked " + box.x + "," + box.y;
  } catch (e) {
    return "err:" + ((e && e.message) || e);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch (e) {}
  }
}

let flowTimer = null;
async function flowTick() {
  if (!flow.enabled || flow.busy) return;
  flow.busy = true;
  try {
    const tab = await pickTab();
    if (!tab || !tab.id) {
      flowNote("没有 accounts/console 标签页");
      return;
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: pageStep,
      args: [cfg],
    });
    const out = (res && res[0] && res[0].result) || { action: "exec-fail", url: "" };
    const sig = tab.id + "|" + out.action + "|" + (out.url || "").slice(0, 80);
    if (sig !== flow.last) {
      flow.last = sig;
      flowNote(tab.id + " " + out.action + " @ " + (out.url || "").replace(/^https:\/\/accounts\.google\.com/, ""));
    }
    if (out.action === "need-recaptcha") {
      const r = await clickRecaptcha(tab.id);
      if (r !== "no-iframe") flowNote("recaptcha: " + r);
    }
  } catch (e) {
    flowNote("tick err: " + ((e && e.message) || e));
  } finally {
    flow.busy = false;
  }
}

async function startFlow(force) {
  if (!force) {
    try {
      const o = await chrome.storage.local.get("qrsms_flow");
      if (o.qrsms_flow !== true) { flowNote("autoflow 已关闭（手动模式，不自动建标签/不自动跳转）"); return; }
    } catch (e) { return; }
  }
  if (flowTimer) clearInterval(flowTimer);
  flow.enabled = true;
  flowNote("autoflow 启动 v" + chrome.runtime.getManifest().version);
  flowTimer = setInterval(flowTick, 2500);
  flowTick();
}

// 自更新：磁盘上的 manifest 版本比当前 SW 新就自己 reload，免去每次手动点「重新加载」
async function checkVersion() {
  try {
    const r = await fetch("http://127.0.0.1:8799/ver", { cache: "no-store" });
    const j = await r.json();
    const mine = chrome.runtime.getManifest().version;
    if (j && j.version && j.version !== mine) {
      flowNote("磁盘版本 " + j.version + " ≠ 运行中 " + mine + "，自动重载");
      dump("flow-reload", j.version + " -> " + mine);
      setTimeout(() => chrome.runtime.reload(), 600);
    }
  } catch (e) {}
}
setInterval(checkVersion, 5000);
setTimeout(checkVersion, 2000);
chrome.runtime.onInstalled.addListener(() => setTimeout(startFlow, 1200));
chrome.runtime.onStartup.addListener(() => setTimeout(startFlow, 1200));
setTimeout(startFlow, 1500);

// SW 保活：MV3 的 service worker 空闲会被回收，桥和 autoflow 会一起断掉。
// chrome.alarms 能唤醒被回收的 SW（setInterval 不能），每分钟至少醒一次把定时器重建。
try {
  if (chrome.alarms) {
    chrome.alarms.create("qrsms-keepalive", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name !== "qrsms-keepalive") return;
      if (flow.enabled && !flowTimer) startFlow();
      bridgeTick();
      checkVersion();
    });
  }
} catch (e) {}

// ================= 远程控制桥（CDP 通道，绕页面 CSP） =================
// 主会话发 HTTP 命令 → SW 用 chrome.debugger 的 Runtime/Input 域执行 → 回传
// 仅监听 127.0.0.1；不装本地接收端时所有 fetch 静默失败。
const B = {
  sink: "http://127.0.0.1:8799",
  target: null,
  attached: new Set(),
};

async function bAttach(tabId) {
  if (B.attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (!/already attached/i.test(msg)) {
      B.attached.delete(tabId);
      throw new Error("attach failed: " + msg);
    }
  }
  B.attached.add(tabId);
}

try {
  chrome.debugger.onDetach.addListener((src) => {
    if (src && typeof src.tabId === "number") B.attached.delete(src.tabId);
  });
} catch (e) {}

async function bDetach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (e) {}
  B.attached.delete(tabId);
}

async function bFindTab(c) {
  if (typeof c.tab === "number") return await chrome.tabs.get(c.tab);
  if (typeof c.tab === "string" && c.tab.indexOf("match:") === 0) {
    const re = new RegExp(c.tab.slice(6));
    const all = await chrome.tabs.query({});
    return all.find((t) => re.test(t.url || ""));
  }
  const [a] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return a;
}

async function bCmd(tabId, method, params) {
  await bAttach(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}

async function bridgeEval(c) {
  const tab = await bFindTab(c);
  if (!tab) return { ok: false, data: "no tab" };
  const expr = "(async function(){ " + String(c.code || "return null;") + " })()";
  const r = await bCmd(tab.id, "Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return { ok: false, data: { tab: tab.id, url: tab.url, error: d.text + " " + ((d.exception && d.exception.description) || "") } };
  }
  return { ok: true, data: { tab: tab.id, url: tab.url, value: r.result && r.result.value } };
}

async function bridgeClick(c) {
  const tab = await bFindTab(c);
  if (!tab) return { ok: false, data: "no tab" };
  const x = Number(c.x),
    y = Number(c.y);
  await bCmd(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await new Promise((r) => setTimeout(r, 60));
  await bCmd(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 90));
  await bCmd(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { ok: true, data: { tab: tab.id, clicked: [x, y] } };
}

async function bridgeInsert(c) {
  const tab = await bFindTab(c);
  if (!tab) return { ok: false, data: "no tab" };
  if (c.focus) {
    await bCmd(tab.id, "Runtime.evaluate", { expression: String(c.focus), returnByValue: true, userGesture: true });
    await new Promise((r) => setTimeout(r, 250));
  }
  if (c.clear) {
    // 全选 + 删除：用真实按键
    await bCmd(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await bCmd(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await new Promise((r) => setTimeout(r, 120));
    await bCmd(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await bCmd(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await new Promise((r) => setTimeout(r, 200));
  }
  await bCmd(tab.id, "Input.insertText", { text: String(c.text || "") });
  const v = await bCmd(tab.id, "Runtime.evaluate", {
    expression: "document.activeElement ? document.activeElement.value : null",
    returnByValue: true,
  });
  return { ok: true, data: { tab: tab.id, typed: c.text, field: v.result && v.result.value } };
}

async function bridgeKey(c) {
  const tab = await bFindTab(c);
  if (!tab) return { ok: false, data: "no tab" };
  const k = String(c.key || "Enter");
  await bCmd(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: Number(c.vk || 13) });
  await bCmd(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: Number(c.vk || 13) });
  return { ok: true, data: { tab: tab.id, key: k } };
}

async function bridgeShot(c) {
  const tab = await bFindTab(c);
  if (!tab) return { ok: false, data: "no tab" };
  const r = await bCmd(tab.id, "Page.captureScreenshot", { format: "png" });
  await fetch(B.sink + "/shot", { method: "POST", body: JSON.stringify({ name: c.name || "t" + tab.id, b64: r.data }) }).catch(() => {});
  return { ok: true, data: "shot " + (c.name || tab.id) };
}

async function bridgeNav(c) {
  const tab = await bFindTab(c);
  const t = tab || (await pickTab());
  await chrome.tabs.update(t.id, { url: c.url });
  return { ok: true, data: { tab: t.id, url: c.url } };
}

async function bridgeTick() {
  let item = null;
  try {
    const r = await fetch(B.sink + "/cmd", { cache: "no-store" });
    item = await r.json();
  } catch (e) {
    return;
  }
  if (!item || !item.id) return;
  const c = item.cmd || {};
  let out = { ok: false, data: "unknown cmd " + c.cmd };
  try {
    if (c.cmd === "eval") out = await bridgeEval(c);
    else if (c.cmd === "click") out = await bridgeClick(c);
    else if (c.cmd === "insert") out = await bridgeInsert(c);
    else if (c.cmd === "key") out = await bridgeKey(c);
    else if (c.cmd === "shot") out = await bridgeShot(c);
    else if (c.cmd === "nav") out = await bridgeNav(c);
    else if (c.cmd === "detach") out = (await bDetach(c.tab), { ok: true, data: "detached" });
    else if (c.cmd === "reload") {
      out = { ok: true, data: "reloading" };
      setTimeout(() => chrome.runtime.reload(), 300);
    } else if (c.cmd === "cdp") {
      const tb1 = await bFindTab(c);
      const r = await bCmd(tb1.id, String(c.method), c.params || {});
      out = { ok: true, data: r };
    } else if (c.cmd === "focus") {
      const tb2 = await bFindTab(c);
      const doc = await bCmd(tb2.id, "DOM.getDocument", { depth: 0 });
      const q = await bCmd(tb2.id, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: String(c.selector) });
      if (!q.nodeId) out = { ok: false, data: "no node for " + c.selector };
      else out = (await bCmd(tb2.id, "DOM.focus", { nodeId: q.nodeId }), { ok: true, data: "focused " + c.selector });
    } else if (c.cmd === "tabs") {
      const all = await chrome.tabs.query({});
      out = { ok: true, data: all.map((t) => ({ id: t.id, active: t.active, url: (t.url || "").slice(0, 160) })) };
    } else if (c.cmd === "ver") {
      out = { ok: true, data: chrome.runtime.getManifest().version };
    }
  } catch (e) {
    out = { ok: false, data: String((e && e.message) || e) };
  }
  try {
    await fetch(B.sink + "/res", { method: "POST", body: JSON.stringify({ id: item.id, ...out }) });
  } catch (e) {}
}

(function bridgeLoop() {
  bridgeTick().finally(() => setTimeout(bridgeLoop, 180));
})();
