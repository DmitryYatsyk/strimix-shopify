/**
 * Builds the Strimix tracker script for storefront embed.
 * Injects streamId and cookieName (userIdAlias) from shop settings.
 *
 * Custom domains (not *.myshopify.com): setCookie adds Domain=.<root> when hostname has a subdomain
 * so the same sx_uid is visible on checkout.* and www.* (same-site cookie). Never set Domain on
 * myshopify.com (would leak across shops). Naive root = last two labels (wrong for some ccTLDs).
 */

const STRIMIX_JS_SDK_URL = "https://cdn.strimix.io/strimix-1.1.0.js";
const STRIMIX_LOGGER_URL = "https://api.strimix.io/collect/log";

/**
 * Returns the inline script that defines window.StrimixGlobal and loads the Strimix SDK.
 * Parameters are escaped for safe embedding into JavaScript.
 */
export function getInlineTrackerScript(
  streamId: string,
  userIdAlias: string,
): string {
  const streamIdJson = JSON.stringify(streamId);
  const userIdAliasJson = JSON.stringify(userIdAlias);
  const jsSdkUrlJson = JSON.stringify(STRIMIX_JS_SDK_URL);
  const loggerUrlJson = JSON.stringify(STRIMIX_LOGGER_URL);

  return `try{window.StrimixGlobal={streamId:${streamIdJson},userIdAlias:${userIdAliasJson},jsSdkUrl:${jsSdkUrlJson},loggerUrl:${loggerUrlJson},generateUuid:function(){let e=new Date().getTime(),t="undefined"!=typeof performance&&performance.now?1e3*performance.now():0;return"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(i){let o=16*Math.random();return e>0?(o=(e+o)%16|0,e=Math.floor(e/16)):(o=(t+o)%16|0,t=Math.floor(t/16)),("x"===i?o:3&o|8).toString(16)})},getCookie:function(e){let t=e.replace(/[.*+?^${"$"}{}()|[\\]\\\\]/g,"\\$&"),i=document.cookie.match(RegExp("(?:^|; )"+t+"=([^;]*)"));if(i)try{return decodeURIComponent(i[1])}catch(o){return i[1]}},cookieDomainAttr:function(){let e=location.hostname;return e&&!/^(localhost|127\\.0\\.0\\.1)$/i.test(e)&&!/\\.myshopify\\.com$/i.test(e)?(e=e.split("."),e.length>=3?"; Domain=."+e.slice(-2).join("."):""):""},setCookie:function(e,t,i){let o="https:"===location.protocol,s=new Date(Date.now()+864e5*i),r=this.cookieDomainAttr();document.cookie=e+"="+encodeURIComponent(t)+"; expires="+s.toUTCString()+"; path=/; SameSite=Lax"+(o?"; Secure":"")+r},getCookieInfo:function(){return{cookie_name:this.userIdAlias,cookie_value:this.getCookie(this.userIdAlias),cookies_enabled:navigator.cookieEnabled,has_cookies:document.cookie.length>0}},setUserId:function(e){let t=this.userIdAlias,i=e??this.getCookie(t);return i||(i=this.generateUuid()),this.setCookie(t,i,730),window[this.userIdAlias]=i,i},getUserId:function(){return window[this.userIdAlias]??this.setUserId()},logMessage:function({payload:e,tag:t}){return new Promise((i,o)=>{let s={stream_id:this.streamId,user_id:window[this.userIdAlias],user_id_alias:this.userIdAlias,cookie_info:this.getCookieInfo(),url:window.location.href,unix_timestamp:Date.now(),tag:t,payload:e,device_info:{screen_resolution:""+window.screen.width+"x"+window.screen.height,language:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,timezone_offset_seconds:-(60*new Date().getTimezoneOffset()),user_agent:navigator.userAgent}},r=new XMLHttpRequest;r.open("POST",this.loggerUrl+"?stream_id="+this.streamId),r.setRequestHeader("Content-type","application/json"),r.send(JSON.stringify(s)),r.onload=function(){r.status>=200&&r.status<300?i():o(Error("StrimixGlobal: Log collection error! Status: "+r.status))},r.onerror=function(){o(Error("StrimixGlobal: Log collection error!"))}})}},function(e,t,i,o,s,r,n){window.StrimixGlobal.setUserId(),e[o]=e[o]||[],("undefined"==typeof StrimixClient||null===StrimixClient)&&(r=t.getElementsByTagName(i)[0],(n=t.createElement(i)).async=!0,n.src=window.StrimixGlobal.jsSdkUrl,r.parentNode.insertBefore(n,r),n.onload=function(){StrimixClient.init(s)},n.onerror=function(){window.StrimixGlobal.logMessage({payload:{message:"strimix.js onload error"},tag:"strimix_js_onload_error"})})}(window,document,"script","strimix",window.StrimixGlobal.streamId);}catch(err){window.__StrimixEmbedError=err.message||String(err);}`;
}

/**
 * Returns the tracking logic: page_view, view_product, add_to_cart, remove_from_cart.
 * Order creation is server-side (new_order via orders/create webhook). Buy now: inject line item property _strimix_avid.
 */
export function getTrackingLogicScript(): string {
  return `
(function(){
  var cfg = window.__StrimixEmbedConfig && window.__StrimixEmbedConfig.events;
  if (!cfg) return;
  function log() {}
  function runTracking() {
  log("runTracking started");
  function currency() {
    return (window.__StrimixProduct && window.__StrimixProduct.currency) || (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || "USD";
  }
  function productItem(id, name, quantity, value) {
    return { id: String(id), name: name || "", quantity: quantity || 1, value: Number(value) || 0, currency: currency() };
  }
  function sha256Hex(str) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function(buf) {
      return Array.from(new Uint8Array(buf)).map(function(b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    });
  }
  function buildUserExternalIds(cb) {
    var c = window.__StrimixCustomer;
    var o = {};
    if (c && c.id) o.shopify_customer_id = String(c.id);
    if (!c) return Promise.resolve(o).then(cb);
    var p = Promise.resolve();
    if (c.email && typeof c.email === "string") p = p.then(function() { return sha256Hex(c.email.trim().toLowerCase()); }).then(function(h) { o.hashed_email = h; });
    if (c.phone && typeof c.phone === "string") p = p.then(function() { return sha256Hex(c.phone.replace(/\\D/g, "")); }).then(function(h) { o.hashed_phone = h; });
    return p.then(function() { return cb(o); });
  }
  function getStrimixAvid() {
    return (window.StrimixGlobal && window.StrimixGlobal.getUserId && window.StrimixGlobal.getUserId()) || (window.StrimixGlobal && window.StrimixGlobal.userIdAlias && window[window.StrimixGlobal.userIdAlias]) || null;
  }
  function syncStrimixAvidToCart() {
    var avid = getStrimixAvid();
    log("syncStrimixAvidToCart", "avid=" + (avid ? avid.substring(0, 8) + "..." : "null"));
    if (!avid) return Promise.resolve();
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    var updateUrl = root.replace(/\\/$/, "") + "/cart/update.js";
    return fetch(updateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: { strimix_avid: avid } })
    }).then(function(r) { log("syncStrimixAvidToCart result status=" + r.status); return r; }).catch(function(e) { log("syncStrimixAvidToCart error", e); });
  }
  function syncStrimixAvidToCustomer() {
    var c = window.__StrimixCustomer;
    var avid = getStrimixAvid();
    if (!c || !c.id || !avid) return;
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    var base = root.replace(/\\/$/, "");
    var url = base + "/apps/strimix/set-customer-avid";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ customerId: c.id, strimix_avid: avid })
    }).then(function(r) { if (r.ok) log("syncStrimixAvidToCustomer ok"); else log("syncStrimixAvidToCustomer status=" + r.status); }).catch(function(e) { log("syncStrimixAvidToCustomer error", e); });
  }
  strimix.push({ event: "page_view" });
  if (window.StrimixGlobal && window.StrimixGlobal.getUserId) {
    syncStrimixAvidToCart();
    syncStrimixAvidToCustomer();
  } else {
    setTimeout(function() { syncStrimixAvidToCart(); syncStrimixAvidToCustomer(); }, 100);
  }
  if (cfg.view_product && window.__StrimixProduct) {
    var p = window.__StrimixProduct;
    var v = p.selected_or_first_available_variant || (p.variants && p.variants[0]);
    var prod = v ? productItem(p.id, p.title, 1, v.price) : productItem(p.id, p.title, 1, 0);
    buildUserExternalIds(function(ids) {
      strimix.push({
        event: "view_product",
        event_name: "view_product",
        user_external_ids: ids,
        products: [prod]
      });
    });
  }
  var cartCache = null;
  var cacheCartTimer = null;
  function cacheCart() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    fetch(root + "cart.js").then(function(r) { return r.json(); }).then(function(cart) { cartCache = cart; }).catch(function() {});
  }
  function cacheCartDebounced() {
    if (cacheCartTimer) clearTimeout(cacheCartTimer);
    cacheCartTimer = setTimeout(cacheCart, 800);
  }
  function parseRemoveBody(bodyStr) {
    var qty = null, line = null, id = null;
    if (typeof bodyStr !== "string") return { qty: null, line: null, id: null };
    if (bodyStr.indexOf("=") !== -1) {
      var params = new URLSearchParams(bodyStr);
      qty = params.get("quantity");
      line = params.get("line");
      id = params.get("id");
    } else if (bodyStr.trim().charAt(0) === "{") {
      try {
        var j = JSON.parse(bodyStr);
        qty = j.quantity != null ? String(j.quantity) : null;
        line = j.line != null ? String(j.line) : null;
        id = j.id != null ? String(j.id) : null;
      } catch (e) { }
    }
    return { qty: qty, line: line, id: id };
  }
  function isRemoveQty(qty) { return qty === "0" || qty === 0; }
  function findRemovedItem(line, id) {
    if (!cartCache || !cartCache.items) return null;
    if (line != null && line !== "") {
      var idx = parseInt(line, 10) - 1;
      return cartCache.items[idx] || null;
    }
    if (id != null && id !== "") {
      for (var i = 0; i < cartCache.items.length; i++) {
        var it = cartCache.items[i];
        if (String(it.variant_id || it.id) === String(id)) return it;
      }
    }
    return null;
  }
  function findRemovedItemByKey(key) {
    if (!cartCache || !cartCache.items || !key) return null;
    for (var i = 0; i < cartCache.items.length; i++) {
      if (String(cartCache.items[i].key) === String(key)) return cartCache.items[i];
    }
    return null;
  }
  function handleCartUpdateBody(bodyStr) {
    if (typeof bodyStr !== "string" || bodyStr.trim().charAt(0) !== "{") return;
    try {
      var j = JSON.parse(bodyStr);
      var updates = j.updates;
      if (!updates || typeof updates !== "object") return;
      for (var key in updates) {
        if (updates[key] === 0 || updates[key] === "0") {
          var item = findRemovedItemByKey(key);
          pushRemoveFromCartEvent(item);
        }
      }
    } catch (e) { }
  }
  function pushRemoveFromCartEvent(item) {
    if (!item) return;
    var prod = productItem(item.variant_id || item.id, item.product_title || item.title, item.quantity, (item.price || 0) / 100);
    var avid = getStrimixAvid();
    buildUserExternalIds(function(ids) {
      strimix.push({
        event: "remove_from_cart",
        event_name: "remove_from_cart",
        strimix_avid: avid || null,
        user_external_ids: ids,
        products: [prod]
      });
    });
  }
  function cartToProducts(cart) {
    if (!cart || !cart.items || !Array.isArray(cart.items)) return [];
    var cur = currency();
    return cart.items.map(function(item) {
      return productItem(item.variant_id || item.id, item.product_title || item.title, item.quantity || 1, (item.price || 0) / 100);
    });
  }
  if (cfg.add_to_cart) {
    document.addEventListener("submit", function(ev) {
      var form = ev.target;
      if (!form || typeof form.action !== "string" || form.action.indexOf("/cart/add") === -1) return;
      var returnToInput = form.querySelector('input[name="return_to"]');
      var returnTo = (returnToInput && returnToInput.value) ? String(returnToInput.value) : "";
      var isBuyNow = returnTo.indexOf("checkout") !== -1;
      log("form submit /cart/add", "return_to=" + returnTo, "isBuyNow=" + isBuyNow, "action=" + (form.action || ""));
      var idInput = form.querySelector('[name="id"]');
      var qtyInput = form.querySelector('[name="quantity"]');
      var variantId = idInput ? (idInput.value || idInput.getAttribute("value")) : null;
      var qty = parseInt(qtyInput ? (qtyInput.value || qtyInput.getAttribute("value")) : 1, 10) || 1;
      var prod = null;
      if (window.__StrimixProduct && window.__StrimixProduct.variants) {
        var v = window.__StrimixProduct.variants.find(function(vr) { return String(vr.id) === String(variantId); });
        if (v) prod = productItem(window.__StrimixProduct.id, window.__StrimixProduct.title, qty, v.price);
      }
      if (!prod) prod = productItem(variantId || "", "", qty, 0);
      if (isBuyNow) {
        ev.preventDefault();
        var avid = getStrimixAvid();
        log("Buy Now: avid=" + (avid ? avid.substring(0, 8) + "..." : "null"));
        if (avid) {
          var existing = form.querySelector('input[name="properties[_strimix_avid]"]');
          if (!existing) {
            var input = document.createElement("input");
            input.type = "hidden";
            input.name = "properties[_strimix_avid]";
            input.value = avid;
            form.appendChild(input);
            log("Buy Now: injected line item property properties[_strimix_avid]");
          } else {
            log("Buy Now: properties[_strimix_avid] already present");
          }
        } else {
          log("Buy Now: no avid to inject - getStrimixAvid() returned null");
        }
        buildUserExternalIds(function(ids) {
          strimix.push({
            event: "add_to_cart",
            event_name: "add_to_cart",
            strimix_avid: avid || null,
            user_external_ids: ids,
            products: [prod]
          });
        });
        form.submit();
        return;
      }
      syncStrimixAvidToCart();
      if (!variantId) return;
      var avid = getStrimixAvid();
      buildUserExternalIds(function(ids) {
        strimix.push({
          event: "add_to_cart",
          event_name: "add_to_cart",
          strimix_avid: avid || null,
          user_external_ids: ids,
          products: [prod]
        });
      });
    }, true);
  }
  if (cfg.remove_from_cart) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function() { cacheCart(); }); else cacheCart();
  }
  function injectStrimixAvidIntoCartAddBody(opts) {
    var avid = getStrimixAvid();
    if (!avid || !opts || opts.method !== "POST") return opts;
    var body = opts.body;
    if (typeof body === "string" && body.trim().charAt(0) === "{") {
      try {
        var j = JSON.parse(body);
        j.attributes = j.attributes || {};
        j.attributes.strimix_avid = avid;
        if (j.items && Array.isArray(j.items) && j.items.length > 0) {
          j.items[0].properties = j.items[0].properties || {};
          j.items[0].properties._strimix_avid = avid;
        }
        return Object.assign({}, opts, { body: JSON.stringify(j) });
      } catch (e) { return opts; }
    }
    if (typeof body === "string" && body.length >= 0) {
      var sep = body.indexOf("=") !== -1 ? "&" : "";
      var added = sep + "attributes[strimix_avid]=" + encodeURIComponent(avid);
      return Object.assign({}, opts, { body: body + added });
    }
    return opts;
  }
  function injectStrimixAvidIntoBodyString(body) {
    var avid = getStrimixAvid();
    if (!avid || body == null) return body;
    if (typeof body === "string" && body.trim().charAt(0) === "{") {
      try {
        var j = JSON.parse(body);
        j.attributes = j.attributes || {};
        j.attributes.strimix_avid = avid;
        if (j.items && Array.isArray(j.items) && j.items.length > 0) {
          j.items[0].properties = j.items[0].properties || {};
          j.items[0].properties._strimix_avid = avid;
        }
        return JSON.stringify(j);
      } catch (e) { return body; }
    }
    if (typeof body === "string") {
      var sep = body.indexOf("=") !== -1 ? "&" : "";
      return body + sep + "attributes[strimix_avid]=" + encodeURIComponent(avid);
    }
    return body;
  }
  if (cfg.add_to_cart || cfg.remove_from_cart) {
    var OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      window.XMLHttpRequest = function() {
        var xhr = new OrigXHR();
        var origOpen = xhr.open;
        var origSend = xhr.send;
        var xhrMethod, xhrUrl;
        xhr.open = function(method, url) {
          xhrMethod = method;
          xhrUrl = typeof url === "string" ? url : "";
          return origOpen.apply(this, arguments);
        };
        xhr.send = function(body) {
          if (cfg.add_to_cart && xhrMethod === "POST" && xhrUrl && xhrUrl.indexOf("/cart/add") !== -1) {
            body = injectStrimixAvidIntoBodyString(body);
          }
          if (cfg.remove_from_cart && xhrMethod === "POST" && xhrUrl && body != null) {
            var bodyStr = typeof body === "string" ? body : "";
            if (xhrUrl.indexOf("/cart/change") !== -1) {
              var parsed = parseRemoveBody(bodyStr);
              if (isRemoveQty(parsed.qty)) {
                var item = findRemovedItem(parsed.line, parsed.id);
                pushRemoveFromCartEvent(item);
              }
            } else if (xhrUrl.indexOf("/cart/update") !== -1) {
              handleCartUpdateBody(bodyStr);
            }
          }
          var xhrRef = this;
          origSend.call(this, body);
          if (cfg.remove_from_cart && xhrMethod === "POST" && xhrUrl && (xhrUrl.indexOf("/cart/change") !== -1 || xhrUrl.indexOf("/cart/update") !== -1)) {
            xhrRef.addEventListener("load", function() { cacheCartDebounced(); });
          }
        };
        return xhr;
      };
    }
  }
  if (cfg.remove_from_cart || cfg.add_to_cart) {
    var origFetch = window.fetch;
    window.fetch = function(url, opts) {
      var u = typeof url === "string" ? url : (url && url.url);
      var fetchOpts = opts;
      if (cfg.add_to_cart && u && u.indexOf("/cart/add") !== -1) fetchOpts = injectStrimixAvidIntoCartAddBody(opts || {});
      if (cfg.remove_from_cart && u && opts && opts.method === "POST") {
        var bodyStr = typeof (opts && opts.body) === "string" ? opts.body : "";
        if (u.indexOf("/cart/change") !== -1) {
          var parsed = parseRemoveBody(bodyStr);
          if (isRemoveQty(parsed.qty)) {
            var item = findRemovedItem(parsed.line, parsed.id);
            pushRemoveFromCartEvent(item);
          }
        } else if (u.indexOf("/cart/update") !== -1) {
          handleCartUpdateBody(bodyStr);
        }
      }
      return origFetch.call(this, url, fetchOpts).then(function(res) {
        if (cfg.remove_from_cart && u && (u.indexOf("/cart/change") !== -1 || u.indexOf("/cart/update") !== -1)) cacheCartDebounced();
        return res;
      });
    };
  }
  }
  if (window.StrimixClient) {
    runTracking();
  } else {
    var attempts = 0;
    var maxAttempts = 60;
    var t = setInterval(function() {
      attempts++;
      if (window.StrimixClient) { clearInterval(t); runTracking(); return; }
      if (attempts >= maxAttempts) { clearInterval(t); runTracking(); }
    }, 100);
  }
})();
`;
}
