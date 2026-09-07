import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const appPort = 3421;
const debugPort = 9421;
const pageUrl = `http://127.0.0.1:${appPort}/pos-layout-certification-local?items=3`;

async function executable(paths) {
  for (const path of paths) {
    if (!path) continue;
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error("Chrome no está disponible para la prueba visual.");
}

async function waitFor(url, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if ((await fetch(url, { redirect: "manual" })).status < 500) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timeout esperando ${url}`);
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", rejectReady, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = new Map();
  socket.addEventListener("message", ({ data }) => {
    const value = JSON.parse(String(data));
    if (value.id) {
      const waiter = pending.get(value.id); pending.delete(value.id);
      if (value.error) waiter?.reject(new Error(value.error.message)); else waiter?.resolve(value.result);
    } else {
      const waiters = events.get(value.method) ?? []; events.delete(value.method);
      waiters.forEach((resolveEvent) => resolveEvent(value.params));
    }
  });
  async function send(method, params = {}) {
    await ready;
    const requestId = ++id;
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  function once(method) { return new Promise((resolveEvent) => events.set(method, [...(events.get(method) ?? []), resolveEvent])); }
  return { socket, send, once };
}

const chromePath = await executable([
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
]);
const profile = await mkdtemp(join(tmpdir(), "carzone-loading-ux-"));
let output = "";
const server = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
let chrome; let cdp;
try {
  await waitFor(pageUrl);
  chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--disable-background-networking", "--disable-extensions", "--disable-gpu", "--no-first-run", "about:blank"], { stdio: "ignore" });
  await waitFor(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" }).then((response) => response.json());
  cdp = connect(target.webSocketDebuggerUrl); await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  async function navigate(width, height) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: width < 768 });
    const loaded = cdp.once("Page.loadEventFired"); await cdp.send("Page.navigate", { url: pageUrl }); await loaded;
    const end = Date.now() + 30_000;
    while (Date.now() < end && !(await evaluate("Boolean(document.querySelector('[data-testid=pos-confirmation-panel]'))"))) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  }

  for (const width of [1920, 1440, 1280, 1024, 768, 430, 390, 360]) {
    await navigate(width, width <= 430 ? 844 : 900);
    const metrics = await evaluate(`(() => { const button=document.querySelector('#pos-confirmation > button:last-of-type'); const rect=button?.getBoundingClientRect(); return {overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,buttonVisible:Boolean(rect&&rect.width>=44&&rect.height>=44),buttonFits:Boolean(rect&&rect.left>=0&&rect.right<=innerWidth)} })()`);
    assert.equal(metrics.overflow, false, `${width}px: sin desbordamiento horizontal`);
    assert.equal(metrics.buttonVisible, true, `${width}px: acción de confirmación visible y táctil`);
    assert.equal(metrics.buttonFits, true, `${width}px: acción contenida en el viewport`);
  }

  await navigate(390, 844);
  await evaluate(`(() => { window.__loadingCalls=0; const original=window.fetch; window.fetch=async(input,init)=>{if(String(input).includes('/confirm')){window.__loadingCalls++;await new Promise(resolve=>setTimeout(resolve,800));return new Response(JSON.stringify({code:'TEST_DELAY',message:'Fallo controlado local'}),{status:409,headers:{'Content-Type':'application/json'}})}return original(input,init)};const panel=document.querySelector('[data-testid=pos-confirmation-panel]');panel.querySelector('input[type=checkbox]').click();const button=document.querySelector('#pos-confirmation > button:last-of-type');button.click();button.click();return true})()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 120));
  const pending = await evaluate(`(() => { const button=document.querySelector('#pos-confirmation > button:last-of-type');return {calls:window.__loadingCalls,disabled:button.disabled,busy:button.getAttribute('aria-busy'),text:button.innerText,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1} })()`);
  assert.equal(pending.calls, 1, "doble clic inicia una sola confirmación");
  assert.equal(pending.disabled, true, "la acción queda deshabilitada");
  assert.equal(pending.busy, "true", "la acción expone aria-busy");
  assert.match(pending.text, /Confirmando venta/, "la acción describe el proceso");
  assert.equal(pending.overflow, false, "el texto pendiente no crea overflow");
  await new Promise((resolveWait) => setTimeout(resolveWait, 850));
  const recovered = await evaluate(`(() => { const panel=document.querySelector('[data-testid=pos-confirmation-panel]');const button=document.querySelector('#pos-confirmation > button:last-of-type');return {disabled:button.disabled,busy:button.getAttribute('aria-busy'),error:panel.innerText.includes('Fallo controlado local')} })()`);
  assert.equal(recovered.disabled, false, "la acción se recupera tras el error");
  assert.equal(recovered.busy, null, "aria-busy se limpia tras el error");
  assert.equal(recovered.error, true, "el error queda visible");
  console.log("Global loading UX browser, delayed action, double click and responsive widths: PASS");
} catch (error) {
  if (output) console.error(output.slice(-5000));
  throw error;
} finally {
  if (cdp?.socket.readyState === WebSocket.OPEN) cdp.socket.close();
  for (const process of [chrome, server]) if (process && process.exitCode === null) process.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
