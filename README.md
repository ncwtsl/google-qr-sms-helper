# google-qr-sms-helper（ncw fork · v2.20.0）

> 把 Google 的「二维码跨设备验证」降级回「6 位短信验证码」的 Chrome / Edge 扩展（Manifest V3）。
> 这是 [havenicec/google-qr-sms-helper](https://github.com/havenicec/google-qr-sms-helper) 的 fork，
> 在 v1.1.0 基础上做了**手动化改造**与**填号逻辑重写**，并沉淀了一整套浏览器内调试设施。

🇨🇳 详细使用说明与踩坑记录见 **[docs/使用说明.md](docs/使用说明.md)**。

> [!IMPORTANT]
> **登录界面也能降级验证**，不只是 Cloud Shell / 第三方授权页弹出来的二维码。
> 在 `accounts.google.com` 输完密码后出现的扫码页（`/v3/signin/challenge/iap/qrcode`）同样点 ⚡ →「手动降级到短信页」即可。
> 详见 **[docs/使用说明.md · 第零节](docs/使用说明.md#零登录界面也能降级验证最重要)**。

> 📖 第一次上手先看 **[附录 A：原作者使用教程](docs/使用说明.md#附录-a原作者使用教程havenicec-v110-原版)**。

---

## 它解决什么问题

Google 对部分账号（尤其是新账号、机房 IP、Cloud Shell 场景）强制要求用**另一台手机扫码**才能继续验证。
这个扩展利用 `devicephoneverification` 链路的 batchexecute RPC（`MypxBd` → `consent` → `YDtwf`），
让服务端返回回落标记 `[3,null,4]`，从而把页面换成传统的**短信验证码**流程。

全程不碰系统鼠标键盘，所有动作发生在浏览器内部。

---

## 关于「出了点问题 · 抱歉，出了点问题。请重试。」

这是 Google 的**通用风控报错**，不是扩展 bug。实测下来它至少有三种含义：

| 现象 | 实际含义 |
|---|---|
| 号码格式不对 / 叠串 | 提交前就能自查（本扩展会先校验长度，不对就不提交） |
| 号码被判定为虚拟号 / 接码号 | 换国家或号段 |
| 账号已被停用 | 会重定向到 `/v3/signin/speedbump/disabled/*`，要求申诉 |
| 出口 IP 是机房 IP | 换住宅 IP 后同类提交会变成「此号码用于验证的次数过多」这类精确报错 |

`content.js` 里的 `watchDialog()` 会实时识别这个弹窗，并把上述归因打印到面板上。

---

## 安装

**方式一：加载已解压的扩展（推荐，适合自己改）**

1. 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选中本仓库根目录

**方式二：打包成 crx**

```bat
msedge.exe --pack-extension="<本仓库目录>" --pack-extension-key="<你的.pem>"
```

> ⚠️ `.pem` 是扩展签名私钥，**不要提交到仓库**（本仓库的 `.gitignore` 已排除）。

### 可选：启用 jsQR

`content.js` 解二维码时**优先用浏览器的 `BarcodeDetector`**，只有它不可用才回落 jsQR。
为了不把 130KB 第三方库塞进仓库，jsQR 默认不打包：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fetch-jsqr.ps1
```

脚本会把 `jsqr.min.js` 拉到根目录，并自动加回 `manifest.json` 的 `content_scripts`。

---

## 使用

1. 走到 Google 的二维码验证页（`/v3/signin/challenge/iap/qrcode`）—— **普通登录界面弹出的扫码页同样适用**，不用非得从 Cloud Shell 进
2. 右下角会出现一个 **⚡ 圆点**，点开面板（默认收起，就是为了不遮住「下一步」）
3. 点 **「⚡ 手动降级到短信页」**
4. 成功后页面自动跳转到 `/challenge/iap?idv_xdevice=1`（短信方式选择页）
5. 在短信页把接码号填进面板输入框，点 **「填入号码并点下一步」**
6. 收到 6 位码后手动填入

**注意**：同一张二维码只能用一次。连续点「降级」会把会话消耗掉，
此时面板会提示「二维码会话已失效…按 F5 刷新」。

### 无人值守模式（可选）

默认关闭。需要自动跑时，显式打开：

```js
sessionStorage.qrsms_auto = "1";     // 二维码页允许自动降级一次
chrome.storage.local.set({ qrsms_flow: true });   // 允许后台流水线
```

后台流水线的账号/密码/号码在 `background.js` 的 `cfg` 里，**默认全空**，需要你自己填。
这些值会跟着扩展源码走，**不要提交进仓库**。

---

## 调试设施（可选，不影响功能）

这个 fork 附带一套「用 HTTP 指挥浏览器」的本地桥，全部只监听 `127.0.0.1`，
没有安装接收端时所有请求静默失败。

SW 侧命令（`background.js` 的 `bridgeTick`）：

| 命令 | 作用 |
|---|---|
| `eval` | 在页面里执行一段函数体（`Runtime.evaluate`，绕 CSP） |
| `click` | CDP 三段式鼠标点击（moved → pressed → released） |
| `insert` | 输入文本，可选 `clear`（真 Ctrl+A + Backspace）与 `focus` |
| `key` | 发送按键（如 `Enter`） |
| `focus` | `DOM.focus` 到指定选择器（密码框必须走这条，`.focus()` 无效） |
| `cdp` | 透传任意 CDP `method` / `params` |
| `shot` | `Page.captureScreenshot` → POST 到本地 sink |
| `nav` / `tabs` / `ver` / `reload` / `detach` | 导航、列标签、查版本、重载扩展、断开调试 |

几个实测结论：

- **CDP 坐标 = CSS 像素**，不要乘 `devicePixelRatio`
- 点击 Google 的账号行，`Input.dispatchMouseEvent` 无效，必须 `element.click()`
- 密码框 `input[type=password].focus()` 无效（`activeElement` 是 `IFRAME`），要 `DOM.focus` + `Input.insertText`
- Google 会用一个全屏 `div.ZQxJQe`（`pointer-events:auto`、`opacity:.5`）当 loading scrim，把点击全吞掉
- reCAPTCHA 的 anchor iframe 首次 rect 可能是 0，重新导航一次才会渲染；勾选框坐标 = anchor rect + (26,26)
- **reCAPTCHA 图片题无法用脚本通过**（靠行为指纹判分），这一步只能人工点

---

## 已知限制

- **出口 IP 信誉比代码重要得多。** 机房 IP（AWS / Azure / GCP）下 reCAPTCHA 必出图片题、号码必被拒；
  换到非云 ISP 的节点后，勾选框点一下就过、报错也从「出了点问题」变成精确的号码侧提示。
- Google 的前端是编译过的 Closure 代码，class 名（`ZQxJQe`、`YPqjbf`）会随版本变，选择器都已做多重兜底。
- 短信验证的号码配额是按号码+IP+账号一起算的，接码平台的公共号段命中率随时间下降很快。

---

## 目录

```
manifest.json          扩展清单（MV3）
background.js          service worker：RPC 降级、UA 规则、后台流水线、CDP 调试桥
content.js             页面面板：识别二维码、手动降级、短信页填号
ua_spoof.js            验证链路内的 navigator 伪装（MAIN world）
scripts/fetch-jsqr.ps1 可选依赖：拉取 jsQR
docs/使用说明.md       详细说明、实测数据、报错对照表
```

---

## 许可与声明

继承上游的 `LICENSE`。本项目仅用于**自己账号的登录**与浏览器自动化技术研究，
请勿用于批量注册、绕过平台风控牟利等场景。

---

## English summary

A Chrome/Edge MV3 extension that downgrades Google's mandatory QR-code cross-device
verification back to standard 6-digit SMS verification, by driving the
`devicephoneverification` batchexecute RPC (`MypxBd` → `consent` → `YDtwf`) and
checking for the `[3,null,4]` fallback marker.

This fork (v2.20.0) makes everything **manual by default** (no auto-downgrade, no
auto-submit), fixes the 18-digit phone-number concatenation bug caused by Google's
controlled input, keeps the panel collapsed so it never covers Google's Next button,
and ships an optional local CDP debug bridge over `127.0.0.1`.
