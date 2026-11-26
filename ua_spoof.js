(() => {
  // 只在 accounts.google.com 的验证链路里伪装，登录页/密码页保持原样
  const FLOW_RE = /^\/(v3\/signin\/challenge\/(iap|uplevelingstep)|uplevelingstep|devicephoneverification)/;
  const forced = (() => {
    try { return sessionStorage.getItem("qrsms_ipad") === "1"; } catch (e) { return false; }
  })();
  if (!FLOW_RE.test(location.pathname) && !forced) return;

  // 不篡改 innerWidth/innerHeight，避免 Google Closure 布局重绘把页面重置
  const IPAD_MINI_UA =
    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
  const APP_VERSION =
    "5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {}
  };

  def(navigator, "userAgent", () => IPAD_MINI_UA);
  def(navigator, "appVersion", () => APP_VERSION);
  def(navigator, "platform", () => "iPad");
  def(navigator, "vendor", () => "Apple Computer, Inc.");
  def(navigator, "maxTouchPoints", () => 5);
  def(navigator, "userAgentData", () => undefined);
})();
