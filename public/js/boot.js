// Starts the embedded app. The Magento admin opens this page with ?launch=<signed one-time token>. We exchange it for a
// session token, keep that in memory (and sessionStorage so a reload works), attach it to every /api call, load the
// initial data, and only then load the real app scripts.
(function () {
  "use strict";
  const SESSION_KEY = "flipickSession";

  function showFatal(message) {
    document.getElementById("appRoot").innerHTML =
      '<div style="max-width:520px;margin:60px auto;text-align:center;font-family:system-ui,sans-serif">' +
      '<h2 style="margin:0 0 8px">Video Generator can\'t open</h2><p style="color:#5f5e5a">' + message + '</p></div>';
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error("Could not load " + src)); };
      document.body.appendChild(el);
    });
  }

  async function start() {
    const params = new URLSearchParams(location.search);
    let token = null;
    try { token = sessionStorage.getItem(SESSION_KEY); } catch (e) { /* storage unavailable */ }

    const launch = params.get("launch");
    if (launch) {
      const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ launch: launch }) });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok) return showFatal(body.error || "The link to open it is not valid.");
      token = body.token;
      try { sessionStorage.setItem(SESSION_KEY, token); } catch (e) { /* ignore */ }
      params.delete("launch");
      history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params.toString() : ""));
    }
    if (!token) return showFatal("Open it from the Magento admin: Flipick, then Video Generator.");

    // Every API call carries the session. A 401 means it ran out; say so instead of failing quietly.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      let options = init || {};
      if (url.indexOf("/api/") === 0) options = Object.assign({}, options, { headers: Object.assign({}, options.headers, { Authorization: "Bearer " + token }) });
      const res = await nativeFetch(input, options);
      if (res.status === 401 && url.indexOf("/api/") === 0 && url.indexOf("/api/session") !== 0) {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
        showFatal("Your session ended. Close this window and open Video Generator again from the Magento admin.");
      }
      return res;
    };

    const res = await fetch("/api/bootstrap");
    if (!res.ok) {
      const body = await res.json().catch(function () { return {}; });
      return showFatal(body.error || "Could not load your store.");
    }
    window.__BOOTSTRAP__ = await res.json();
    document.getElementById("storeSubtitle").textContent = window.__BOOTSTRAP__.storeUrl || "";

    await loadScript("/static/js/billing.js");
    await loadScript("/static/js/app.js");
  }

  start().catch(function (err) { showFatal(err.message); });
})();
