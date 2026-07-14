export const SANDBOX_COMPATIBILITY_PARAM = "__playground_iframe";

export function consumeSandboxCompatibility(requestPath) {
  const url = new URL(String(requestPath || "/"), "https://playground.invalid");
  const compatible = url.searchParams.has(SANDBOX_COMPATIBILITY_PARAM);
  url.searchParams.delete(SANDBOX_COMPATIBILITY_PARAM);

  return {
    requestPath: `${url.pathname}${url.search}`,
    compatible,
  };
}

export function preserveSandboxCompatibilityRedirect(
  response,
  compatible,
  origin,
) {
  const location = response.headers.get("location");
  if (!location || !compatible) {
    return response;
  }

  const base = new URL(String(origin || "https://playground.invalid"));
  const target = new URL(location, base);
  if (target.origin !== base.origin) {
    return response;
  }

  target.searchParams.set(SANDBOX_COMPATIBILITY_PARAM, "1");
  const headers = new Headers(response.headers);
  headers.set(
    "location",
    location.startsWith("http")
      ? target.toString()
      : `${target.pathname}${target.search}${target.hash}`,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function buildSandboxedIframeCompatibilityScript(scopedBasePath) {
  const base = JSON.stringify(String(scopedBasePath || "/"));
  const param = JSON.stringify(SANDBOX_COMPATIBILITY_PARAM);

  return `(function(){try{var b=${base},p=${param},a=Element.prototype.setAttribute,n=Node.prototype,h=HTMLIFrameElement.prototype;function u(i,r){r=r===undefined?i.getAttribute("src"):r;if(!r)return null;var x;try{x=new URL(r,window.location.href)}catch(e){return null}return x.origin===window.location.origin&&(x.pathname===b||x.pathname.indexOf(b+"/")===0)?x:null}function o(i){return(i.getAttribute("sandbox")||"").trim().split(/\\s+/).some(function(x){return x.toLowerCase()==="allow-same-origin"})}function f(i){if(!i||i.tagName!=="IFRAME"||!i.hasAttribute("sandbox")||!o(i))return;var x=u(i);if(!x)return;i.removeAttribute("credentialless");if(x.searchParams.has(p))return;x.searchParams.set(p,"1");a.call(i,"src",x.toString())}function q(e){if(!e||e.nodeType!==1)return;f(e);e.querySelectorAll&&e.querySelectorAll("iframe[sandbox]").forEach(f)}function d(k,w){var r=Object.getOwnPropertyDescriptor(h,k);if(r&&r.get&&r.set)Object.defineProperty(h,k,{configurable:r.configurable,enumerable:r.enumerable,get:r.get,set:function(v){return w.call(this,r,v)}})}Element.prototype.setAttribute=function(k,v){var l=String(k).toLowerCase();if(this.tagName==="IFRAME"&&l==="credentialless"&&o(this)&&u(this))return;var r=a.call(this,k,v);if(this.tagName==="IFRAME"&&(l==="src"||l==="sandbox"))f(this);return r};d("src",function(r,v){var x=o(this)&&u(this,v);if(x){this.removeAttribute("credentialless");x.searchParams.set(p,"1");return r.set.call(this,x.toString())}return r.set.call(this,v)});d("sandbox",function(r,v){var x=r.set.call(this,v);f(this);return x});d("credentialless",function(r,v){if(v&&o(this)&&u(this)){this.removeAttribute("credentialless");return}return r.set.call(this,v)});["appendChild","insertBefore","replaceChild"].forEach(function(k){var r=n[k];n[k]=function(e){q(e);return r.apply(this,arguments)}});new MutationObserver(function(rs){rs.forEach(function(r){if(r.type==="attributes"){f(r.target);return}r.addedNodes.forEach(q)})}).observe(document.documentElement,{attributes:true,attributeFilter:["sandbox","src","credentialless"],childList:true,subtree:true});document.querySelectorAll("iframe[sandbox]").forEach(f)}catch(e){}})();`;
}
