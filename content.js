(() => {
  "use strict";

  const isCloudConsole = location.hostname === "console.cloud.google.com";
  // Google 的挑战路径段会在 iap / ipp 之间切换（2026-11 实测新账号落到 /challenge/ipp/qrcode），
  // 只认 iap 会让整个脚本在第 8 行 return —— 页面上连圆点都不出现，用户看到的就是"插件没反应"。
  const isQrPage = /\/challenge\/(iap|ipp)\/qrcode/.test(location.pathname);
  // 降级成功后落在 /challenge/(iap|ipp)?idv_xdevice=1（短信页）：只挂提示，不干预跳转
  const isSmsPage = !isQrPage && /\/challenge\/(iap|ipp|uplevelingstep)/.test(location.pathname);
  if (!isCloudConsole && !isQrPage && !isSmsPage) return;
  if (window.__qrsmsPanelMounted) return;
  window.__qrsmsPanelMounted = true;

  // ---------------------------------------------------------------- UI
  // 默认收起成小圆点：不遮住 Google 卡片右下角的「下一步」
  const dot = document.createElement("div");
  dot.textContent = "⚡";
  dot.title = "Google 验证降级助手（点开）";
  dot.style.cssText =
    "position:fixed;right:14px;bottom:14px;z-index:2147483647;width:42px;height:42px;border-radius:50%;" +
    "background:#1a73e8;color:#fff;display:flex;align-items:center;justify-content:center;font-size:19px;" +
    "box-shadow:0 4px 14px rgba(0,0,0,.32);cursor:pointer;user-select:none;font-family:system-ui,sans-serif;";

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;bottom:64px;right:14px;z-index:2147483647;background:#1a73e8;color:#fff;" +
    "padding:12px 14px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.28);" +
    "font-family:system-ui,-apple-system,sans-serif;font-size:13px;display:none;" +
    "flex-direction:column;gap:8px;width:330px;max-height:calc(100vh - 110px);overflow:auto;";

  const title = document.createElement("div");
  title.style.cssText =
    "font-weight:600;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:8px;";
  title.textContent = "⚡ Google 验证降级助手 v" + (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return "?"; } })();
  const x = document.createElement("span");
  x.textContent = "×";
  x.title = "收起";
  x.style.cssText = "cursor:pointer;opacity:.75;font-size:16px;line-height:1;";
  x.onclick = () => {
    panel.style.display = "none";
    dot.style.display = "flex";
  };
  title.appendChild(x);
  panel.appendChild(title);

  const statusEl = document.createElement("div");
  statusEl.style.cssText =
    "font-size:12px;color:#e8f0fe;word-break:break-word;line-height:1.5;max-height:220px;overflow:auto;white-space:pre-wrap;";
  panel.appendChild(statusEl);

  const btn = document.createElement("button");
  btn.style.cssText =
    "background:#fff;color:#1a73e8;border:none;padding:9px 12px;border-radius:6px;" +
    "font-weight:600;cursor:pointer;font-size:13px;";
  panel.appendChild(btn);

  const manualBtn = document.createElement("button");
  manualBtn.style.cssText =
    "background:transparent;color:#e8f0fe;border:1px solid rgba(255,255,255,.45);" +
    "padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;display:none;";
  manualBtn.textContent = "手动粘贴二维码链接";
  panel.appendChild(manualBtn);

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "粘贴 g.co/verify/... 或 devicephoneverification/begin?...";
  input.style.cssText =
    "display:none;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;" +
    "border:none;font-size:11px;color:#202124;";
  panel.appendChild(input);

  const logEl = document.createElement("div");
  logEl.style.cssText =
    "font-size:11px;color:#bcd4fb;line-height:1.45;max-height:140px;overflow:auto;white-space:pre-wrap;display:none;";
  panel.appendChild(logEl);

  document.body.appendChild(panel);
  document.body.appendChild(dot);
  dot.onclick = () => {
    dot.style.display = "none";
    panel.style.display = "flex";
  };

  const setStatus = (s) => {
    statusEl.textContent = s;
  };
  const setLog = (lines) => {
    if (!lines || !lines.length) return;
    logEl.style.display = "block";
    logEl.textContent = lines.join("\n");
  };

  // ---------------------------------------------------------------- 页面令牌
  function pageTokens() {
    const q = new URLSearchParams(location.search);
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    const grab = (re) => (html.match(re) || [])[1] || "";
    const at = grab(/"SNlM0e"\s*:\s*"([^"]+)"/);
    const dshHtml = grab(/"Qzxixc"\s*:\s*"([^"]+)"/);
    let tlHtml = grab(/key:\s*['"]ds:0['"][^}]{0,160}?data:\["([^"]+)"/);
    if (!tlHtml) tlHtml = grab(/ADG-[A-Za-z0-9_\-]{20,}/);
    const tlUrl = q.get("TL") || q.get("tl") || "";
    const dshUrl = q.get("dsh") || "";
    return {
      at,
      dsh: dshHtml || dshUrl,
      tl: tlHtml || tlUrl,
      hasPageTokens: Boolean((dshHtml || dshUrl) && (tlHtml || tlUrl)),
    };
  }

  // ---------------------------------------------------------------- 二维码解析
  function toCanvas(el) {
    const w = el.naturalWidth || el.width || el.clientWidth || 0;
    const h = el.naturalHeight || el.height || el.clientHeight || 0;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    try {
      ctx.drawImage(el, 0, 0, w, h);
    } catch (e) {
      return null;
    }
    return c;
  }

  async function decodeCanvas(c) {
    if ("BarcodeDetector" in window) {
      try {
        const det = new window.BarcodeDetector({ formats: ["qr_code"] });
        const codes = await det.detect(c);
        if (codes && codes.length && codes[0].rawValue) return codes[0].rawValue;
      } catch (e) {
        /* 平台不支持 barcode，落到 jsQR */
      }
    }
    if (typeof self.jsQR === "function") {
      try {
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const r = self.jsQR(img.data, c.width, c.height, { inversionAttempts: "attemptBoth" });
        if (r && r.data) return r.data;
      } catch (e) {
        /* canvas 被跨域图片污染 */
      }
    }
    return "";
  }

  async function extractQrUrlFromPage() {
    // 二维码里往往才是关键：devicephoneverification/begin?...&plt=...&dsh=...
    try {
      const dec = await decodeQrOnly();
      if (dec && /devicephoneverification\/begin\?/.test(dec)) return dec;
      if (dec && /g\.co\/verify\//.test(dec)) return dec.startsWith("http") ? dec : "https://" + dec;
    } catch (e) {}
    // 兜底：页面文本里印的短链
    const text = document.body ? document.body.innerText || "" : "";
    const short = text.match(/g\.co\/verify\/[A-Za-z0-9_-]+/);
    if (short) return "https://" + short[0];
    // 最后再扫一遍图片（非 begin 的结果也用）
    const media = Array.from(document.querySelectorAll("img, canvas"));
    media.sort((a, b) => (b.naturalWidth || b.width || 0) - (a.naturalWidth || a.width || 0));
    for (const el of media) {
      const cw = el.clientWidth || el.naturalWidth || 0;
      const ch = el.clientHeight || el.naturalHeight || 0;
      if (cw < 80 || ch < 80) continue;
      if (cw / ch < 0.7 || cw / ch > 1.45) continue;
      const c = toCanvas(el);
      if (!c) continue;
      const v = await decodeCanvas(c);
      if (v) return v.startsWith("http") ? v : "https://" + v.replace(/^\/+/, "");
    }
    const text2 = document.body ? document.body.innerText || "" : "";
    const short2 = text2.match(/g\.co\/verify\/[A-Za-z0-9_-]+/);
    if (short2) return "https://" + short2[0];
    return "";
  }

  async function decodeQrOnly() {
    const media = Array.from(document.querySelectorAll("img, canvas"));
    media.sort((a, b) => (b.naturalWidth || b.width || 0) - (a.naturalWidth || a.width || 0));
    for (const el of media) {
      const cw = el.clientWidth || el.naturalWidth || 0;
      const ch = el.clientHeight || el.naturalHeight || 0;
      if (cw < 80 || ch < 80) continue;
      if (cw / ch < 0.7 || cw / ch > 1.45) continue;
      const c = toCanvas(el);
      if (!c) continue;
      const v = await decodeCanvas(c);
      if (v) return v;
    }
    return "";
  }

  // ---------------------------------------------------------------- 跳转目标
  function stripParam(u, name) {
    return u
      .replace(new RegExp("([?&])" + name + "=[^&]*&?", "g"), "$1")
      .replace(/\?&/, "?")
      .replace(/[?&]$/, "");
  }

  function buildTarget() {
    const params = new URLSearchParams(location.search);
    let cont = params.get("continue") || "";
    if (cont && cont.startsWith("https://accounts.google.com/uplevelingstep/")) {
      cont = stripParam(cont, "idv_xdevice");
      cont = cont.replace(/([?&])authuser(&|$)/, "$1authuser=0$2");
      return cont + (cont.includes("?") ? "&" : "?") + "idv_xdevice=1";
    }
    let t = stripParam(
      location.href.replace(/\/challenge\/(iap|ipp)\/qrcode/, "/challenge/$1"),
      "idv_xdevice"
    );
    return t + (t.includes("?") ? "&" : "?") + "idv_xdevice=1";
  }

  // ---------------------------------------------------------------- 主流程
  async function runDowngrade(manualQr) {
    btn.disabled = true;
    btn.textContent = "处理中…";
    manualBtn.style.display = "none";
    try {
      const pt = pageTokens();
      let qrUrl = manualQr || "";

      setStatus(
        `页面令牌：tl ${pt.tl ? "✓" : "✗"} / dsh ${pt.dsh ? "✓" : "✗"} / at ${pt.at ? "✓" : "✗"}`
      );

      if (!pt.hasPageTokens && !qrUrl) {
        setStatus("页面没带令牌，正在识别二维码…");
      }
      if (!qrUrl) {
        try {
          qrUrl = await extractQrUrlFromPage();
        } catch (e) {}
      }
      if (!pt.hasPageTokens && !qrUrl) throw new Error("没识别到二维码，点「手动粘贴二维码链接」");
      setStatus(
        (pt.hasPageTokens ? "先用页面令牌发 RPC" : "用二维码取 begin 页令牌") +
          (qrUrl ? "（二维码：" + qrUrl.slice(-20) + "）" : "") +
          "\n正在执行 MypxBd / consent / YDtwf…"
      );

      const res = await chrome.runtime.sendMessage({
        action: "downgradeQr",
        at: pt.at,
        dsh: pt.dsh,
        tl: pt.tl,
        qrUrl,
      });
      if (!res) throw new Error("后台无响应（扩展刚被重载？刷新页面再试）");
      setLog(res.log);

      if (res.error) throw new Error(res.error);

      if (!res.hit) {
        setStatus(
          "❌ 服务端没返回 [3,null,4]（HTTP " +
            res.ydStatus +
            "）：\n" +
            (res.ydResp || res.reason || "") +
            "\n返回体里没有回落状态，流程未生效。\n" +
            "想再来一次请先按 F5 刷新本页拿新二维码——同一张二维码只能用一次。"
        );
        btn.disabled = false;
        btn.textContent = "F5 刷新后再点这里";
        manualBtn.style.display = "block";
        return;
      }

      setStatus("✅ 命中 [3,null,4]，正在跳转短信验证选择页…");
      try {
        sessionStorage.setItem("qrsms_ipad", "1");
      } catch (e) {}
      location.replace(buildTarget());
    } catch (e) {
      setStatus("❌ " + ((e && e.message) || e));
      btn.disabled = false;
      btn.textContent = "F5 刷新后再点这里";
      manualBtn.style.display = "block";
    }
  }

  // ---------------------------------------------------------------- 挂载
  if (isQrPage) {
    // 调试：直接把二维码真实内容、页面文本短链上报到本地 sink（content 端直连，绕开 SW）
    const debug = location.hash.includes("qrsms-debug");
    const sink = (name, data) => {
      if (!debug) return;
      try {
        fetch("http://127.0.0.1:8799/", {
          method: "POST",
          body: JSON.stringify({ name, data }),
        }).catch(() => {});
      } catch (e) {}
    };
    setTimeout(async () => {
      try {
        const decoded = await decodeQrOnly();
        const printed = (document.body.innerText || "").match(/g\.co\/verify\/[A-Za-z0-9_-]+/);
        const imgs = Array.from(document.querySelectorAll("img")).map(
          (i) => (i.src || "").slice(0, 60) + "|" + (i.naturalWidth || 0) + "x" + (i.naturalHeight || 0)
        );
        sink(
          "qr-probe",
          JSON.stringify(
            { decoded, printed: printed ? printed[0] : "", url: location.href, imgs },
            null,
            2
          )
        );
        setStatus(
          decoded
            ? "✅ 已识别页面二维码，点下面按钮一键降级到短信选择框。"
            : "⚠️ 没解出二维码，可用「手动粘贴二维码链接」兜底。\n页面短链：" +
                (printed ? printed[0] : "无")
        );
      } catch (e) {
        setStatus("探测异常：" + ((e && e.message) || e));
      }
    }, 2000);
  }
  if (isSmsPage) {
    // 短信页诊断/无人值守：URL 带 #qrsms-debug 时把页面控件结构 dump 到本地 sink
    const smsDebug = /qrsms-(debug|fill)/.test(location.hash) || (() => {
      try {
        return sessionStorage.getItem("qrsms_dbg") === "1";
      } catch (e) {
        return false;
      }
    })();
    const sinkSms = (name, data) => {
      if (!smsDebug) return;
      try {
        fetch("http://127.0.0.1:8799/", { method: "POST", body: JSON.stringify({ name, data }) }).catch(() => {});
      } catch (e) {}
    };
    const dumpSmsDom = () => {
      const out = {
        url: location.href,
        selects: Array.from(document.querySelectorAll("select")).map((s) => ({
          name: s.name,
          id: s.id,
          jsname: s.getAttribute("jsname"),
          aria: s.getAttribute("aria-label"),
          cls: (s.className || "").toString().slice(0, 80),
          value: s.value,
          options: Array.from(s.options)
            .slice(0, 8)
            .map((o) => (o.textContent || "").trim() + " = " + o.value),
          optCount: s.options.length,
        })),
        telInputs: Array.from(
          document.querySelectorAll('input[type="tel"], input[name="phoneNumber"], input[jsname="YPqjbf"]')
        ).map((i) => ({
          type: i.type,
          name: i.name,
          jsname: i.getAttribute("jsname"),
          id: i.id,
          aria: i.getAttribute("aria-label"),
          value: i.value,
          outer: i.outerHTML.slice(0, 400),
        })),
        countryish: Array.from(document.querySelectorAll("[role='combobox'], [aria-haspopup='listbox'], [jsname]"))
          .slice(0, 30)
          .map((e) => ({
            tag: e.tagName,
            jsname: e.getAttribute("jsname"),
            role: e.getAttribute("role"),
            aria: e.getAttribute("aria-label"),
            text: (e.textContent || "").trim().slice(0, 40),
          })),
        buttons: Array.from(document.querySelectorAll("button")).map((b) => ({
          text: (b.textContent || "").trim().slice(0, 24),
          aria: b.getAttribute("aria-label"),
          jsname: b.getAttribute("jsname"),
        })),
      };
      sinkSms("sms-dom", JSON.stringify(out, null, 2));
    };
    const saved = (() => {
      let v = "";
      try {
        v = localStorage.getItem("qrsms_phone") || "";
      } catch (e) {}
      // 之前几轮重复写入会把输入框内容叠成 +57 52245757… 这种脏值，长度超限就重置
      const digits = v.replace(/[^\d]/g, "");
      if (!v || digits.length > 12) {
        v = "+57 3000000000";
        try {
          localStorage.setItem("qrsms_phone", v);
        } catch (e) {}
      }
      return v;
    })();
    const tip = document.createElement("div");
    tip.textContent =
      "✅ 已到短信页。下方填入接码号后点「填入并下一步」，收到 6 位码再手动填。\n" +
      "（+86 会被 Google 拒，用 +1/+44/+57 等）";
    panel.insertBefore(tip, btn);

    const phoneInput = document.createElement("input");
    phoneInput.type = "text";
    phoneInput.value = saved;
    phoneInput.placeholder = "+57 3000000000";
    phoneInput.style.cssText =
      "width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:none;font-size:12px;color:#202124;";
    panel.insertBefore(phoneInput, btn);

    const setNative = (el, val) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (desc && desc.set) desc.set.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    btn.style.display = "block";
    btn.textContent = "填入号码并点下一步";

    const fillAndNext = async () => {
      const raw = (phoneInput.value || "").trim();
      if (!raw) {
        setStatus("⚠️ 先填号码");
        return;
      }
      // 统一成完整国际格式：+573000000000
      const digits = raw.replace(/[^\d]/g, "");
      const full = "+" + digits;

      const field =
        document.querySelector("input#phoneNumberId") ||
        document.querySelector('input[type="tel"]') ||
        document.querySelector('input[name="phoneNumber"]') ||
        document.querySelector('input[jsname="YPqjbf"]');
      if (!field) {
        setStatus("⚠️ 没找到电话号码输入框，请手动填");
        return;
      }
      if (smsDebug) dumpSmsDom();

      // Google 的号码框会自己解析 "+57…" 并把国家切过去，
      // 所以一次性插完整国际号；别再走「切国家 + 只填本地号」那条路（那条会叠成 18 位）。
      field.focus();
      try {
        field.select();
      } catch (e) {}
      try {
        document.execCommand("delete", false);
      } catch (e) {}
      setNative(field, "");
      // 清空会让受控输入立刻回填「+国家码」，等它重排完再插，否则会和旧值叠成 18 位
      await new Promise((r) => setTimeout(r, 180));
      try {
        document.execCommand("insertText", false, full);
      } catch (e) {}
      let got = (field.value || "").replace(/[^\d]/g, "");
      if (got !== digits) {
        setNative(field, full);
        got = (field.value || "").replace(/[^\d]/g, "");
      }

      const combo = document.querySelector('div[role="combobox"]');
      const country = combo ? (combo.textContent || "").replace(/\s+/g, " ").trim() : "";
      const ok = got === digits;
      setStatus(
        (ok ? "✅ " : "⚠️ ") +
          "号码：" +
          (field.value || "（空）") +
          "\n国家：" +
          (country || "未识别") +
          "\n" +
          (ok
            ? "长度正确（" + got.length + " 位），正在点「下一步」…"
            : "长度不对（该是 " + digits.length + " 位，实得 " + got.length + " 位），已停止，没有提交。")
      );
      if (!ok) return;

      setTimeout(() => {
        const next = Array.from(document.querySelectorAll("button")).find(
          (b) => /^(下一步|Next)$/.test((b.textContent || "").trim()) && b.getBoundingClientRect().width > 0
        );
        if (next) {
          next.click();
          setStatus("✅ 已提交 " + full + "，等短信到达后填 6 位码。");
        } else {
          setStatus("✅ 已填入 " + full + "，请手动点「下一步」。");
        }
      }, 600);
      try {
        localStorage.setItem("qrsms_phone", raw);
      } catch (e) {}
    };

    btn.onclick = fillAndNext;

    // 盯住 Google 的「出了点问题」弹窗：它是 Google 服务端拒绝，不是插件没跑
    let lastDialogText = "";
    const watchDialog = () => {
      const d = document.querySelector("[role=dialog],[role=alertdialog]");
      const txt = d ? (d.innerText || "").replace(/\s+/g, " ").trim() : "";
      if (!txt) {
        lastDialogText = "";
        return;
      }
      if (!/出了点问题|抱歉|retry|went wrong/i.test(txt)) return;
      if (txt === lastDialogText) return;
      lastDialogText = txt;
      setStatus(
        "❌ Google 拒绝了这次提交：" +
          txt.slice(0, 80) +
          "\n\n这通常不是插件的问题，而是 Google 侧风控：" +
          "\n· 号码被当成虚拟号/接码号（换国家或号段再试）" +
          "\n· 账号或当前 IP 已进风控（换账号、换 IP）" +
          "\n\n点下面的按钮 → 重新开始，然后要重新取二维码。"
      );
      btn.textContent = "重新开始（重新取二维码）";
      btn.onclick = () => {
        const d2 = document.querySelector("[role=dialog],[role=alertdialog]");
        const rb = d2
          ? Array.from(d2.querySelectorAll("button,div[role=button]")).find((b) =>
              /重新开始|Restart/i.test(b.textContent || "")
            )
          : null;
        if (rb) rb.click();
        else location.href = location.origin + "/restart";
      };
    };
    setInterval(watchDialog, 1500);
    if (smsDebug) {
      dumpSmsDom();
      if (location.hash.includes("qrsms-fill")) setTimeout(fillAndNext, 1500);
    }
  } else if (isCloudConsole) {
    setStatus("第一步：点击右上角终端图标 [>_] 唤出 Verify 弹窗");
    btn.textContent = "1. 自动点击 Cloud Shell 终端图标";
    btn.onclick = () => {
      const shellBtn = document.querySelector(
        'button[aria-label*="Cloud Shell"], button[mattooltip*="Cloud Shell"], [id*="cloudshell"]'
      );
      if (!shellBtn) {
        setStatus("⚠️ 未找到终端按钮，请手动点右上角 [>_] 图标");
        return;
      }
      shellBtn.click();
      setStatus("✅ 已点终端图标，等待 Verify 按钮出现…");
      setTimeout(() => {
        const v = Array.from(document.querySelectorAll("button, a")).find(
          (b) => (b.textContent || "").trim() === "Verify"
        );
        if (v) {
          v.click();
          setStatus("✅ 已点 Verify，等待二维码页");
        } else {
          setStatus("⚠️ 没找到 Verify 按钮，请手动点");
        }
      }, 2500);
    };
  } else {
    setStatus("已检测到二维码验证页。插件不会自动跳转 —— 点下面的按钮才会降级。");
    btn.textContent = "⚡ 手动降级到短信页";
    btn.onclick = () => runDowngrade("");
    // 调试/无人值守触发：URL 带 #qrsms-auto 或 sessionStorage.qrsms_auto=1 时自动跑一次
    let auto = false;
    try {
      auto = sessionStorage.getItem("qrsms_auto") === "1";
    } catch (e) {}
    if (!auto && location.hash.includes("qrsms-auto")) auto = true;
    // 扫码页默认「绝不自动降级」——必须由用户点面板按钮才跳短信页
    // 无人值守场景保留显式开关：URL 带 #qrsms-auto 或 sessionStorage.qrsms_auto=1
    if (auto) {
      setTimeout(() => runDowngrade(""), 1200);
    }
    manualBtn.onclick = () => {
      input.style.display = "block";
      input.focus();
      btn.disabled = false;
      btn.textContent = "用粘贴的链接降级";
      btn.onclick = () => {
        const v = input.value.trim();
        if (!v) return;
        runDowngrade(v);
      };
      setStatus("粘贴二维码里的链接（g.co/verify/... 或 devicephoneverification/begin?...）");
    };
  }
})();
