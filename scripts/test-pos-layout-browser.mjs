import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
const appPort = 3417;
const debugPort = 9417;
const baseUrl = `http://127.0.0.1:${appPort}/pos-layout-certification-local`;
const outputDir = join(repoRoot, ".visual-check", "pos-layout");

async function firstExecutable(paths) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {}
  }
  throw new Error("No se encontró Chrome/Chromium para la certificación visual.");
}

async function waitForUrl(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw lastError ?? new Error(`Timeout esperando ${url}`);
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();

  const opened = new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    if (payload.id) {
      const waiter = pending.get(payload.id);
      if (!waiter) return;
      pending.delete(payload.id);
      if (payload.error) waiter.reject(new Error(payload.error.message));
      else waiter.resolve(payload.result);
      return;
    }
    const waiters = eventWaiters.get(payload.method);
    if (!waiters?.length) return;
    eventWaiters.delete(payload.method);
    for (const resolveEvent of waiters) resolveEvent(payload.params);
  });

  async function send(method, params = {}) {
    await opened;
    const id = nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function once(method) {
    return new Promise((resolveEvent) => {
      const waiters = eventWaiters.get(method) ?? [];
      waiters.push(resolveEvent);
      eventWaiters.set(method, waiters);
    });
  }

  return { socket, send, once };
}

const viewportCases = [
  [1920, 1080], [1440, 900], [1366, 768], [1280, 800], [1100, 800], [1024, 768],
  [900, 768], [768, 1024], [430, 932], [392, 608], [390, 844], [360, 800],
];

const chromePath = await firstExecutable([
  process.env.CHROME_PATH,
  process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : null,
  process.platform === "win32" ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" : null,
  process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]);

await mkdir(outputDir, { recursive: true });
const chromeProfile = await mkdtemp(join(tmpdir(), "carzone-pos-layout-"));
let serverOutput = "";
const server = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
  cwd: repoRoot,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });

let chrome;
let cdp;
try {
  await waitForUrl(`${baseUrl}?items=1`);
  chrome = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1920,1080",
    "about:blank",
  ], { stdio: "ignore" });

  await waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${baseUrl}?items=1`)}`, { method: "PUT" }).then((response) => response.json());
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async function navigate(width, height, itemCount) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width < 768, screenWidth: width, screenHeight: height,
    });
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: `${baseUrl}?items=${itemCount}` });
    await loaded;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const complete = await evaluate(`document.readyState === 'complete'
        && Boolean(document.querySelector('[data-testid=pos-admin-header]'))
        && Boolean(document.querySelector('[data-testid=pos-cart]'))
        && Boolean(document.querySelector('[data-testid=pos-customer-context]'))
        && document.querySelectorAll('[data-testid=pos-customer-info-card]').length === 4
        && [...document.querySelectorAll('[data-testid=pos-customer-info-card]')].every((card) => card.getBoundingClientRect().width > 0)
        && document.querySelectorAll('[data-testid=pos-cart-line]').length === ${itemCount}`);
      if (complete) {
        await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`La fixture no terminó de cargar en ${width}x${height}`);
  }

  async function metrics() {
    return evaluate(`(() => {
      const rect = (element) => element?.getBoundingClientRect();
      const header = document.querySelector('[data-testid=pos-admin-header]');
      const back = header?.querySelector('a');
      const grid = document.querySelector('[data-testid=pos-layout-certification]');
      const cart = document.querySelector('[data-testid=pos-cart]');
      const cartHeader = document.querySelector('[data-testid=pos-cart-header]');
      const lines = document.querySelector('[data-testid=pos-cart-lines]');
      const name = document.querySelector('[data-testid=pos-customer-name]');
      const email = document.querySelector('[data-testid=pos-customer-email]');
      const cards = [...document.querySelectorAll('[data-testid=pos-customer-info-card]')];
      const money = [...document.querySelectorAll('[data-testid=pos-credit-metric] p:last-child')];
      const nameStyle = getComputedStyle(name);
      const cartHeaderBefore = rect(cartHeader);
      if (lines) lines.scrollTop = lines.scrollHeight;
      const cartHeaderAfter = rect(cartHeader);
      const template = getComputedStyle(grid).gridTemplateColumns.trim();
      return {
        viewportWidth: innerWidth,
        pageHeight: document.documentElement.scrollHeight,
        globalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        headerHeight: rect(header).height,
        backVisible: Boolean(back && rect(back).width >= 44 && rect(back).height >= 44),
        columns: template ? template.split(/\\s+/).length : 1,
        cartHeight: rect(cart).height,
        listClientHeight: lines?.clientHeight ?? 0,
        listScrollHeight: lines?.scrollHeight ?? 0,
        cartHeaderStable: Math.abs(cartHeaderBefore.top - cartHeaderAfter.top) < 0.5,
        nameLines: Math.round(rect(name).height / parseFloat(nameStyle.lineHeight)),
        nameWidth: rect(name).width,
        emailFits: email.scrollWidth <= email.parentElement.clientWidth + 1,
        cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1),
        minimumCardWidth: Math.min(...cards.map((card) => rect(card).width)),
        moneyFits: money.every((value) => value.scrollWidth <= value.parentElement.clientWidth + 1),
      };
    })()`);
  }

  const cartCounts = {};
  for (const itemCount of [1, 3, 4, 5, 10, 20]) {
    await navigate(1440, 900, itemCount);
    cartCounts[itemCount] = await metrics();
  }
  assert.ok(cartCounts[3].cartHeight > cartCounts[1].cartHeight, "1–3 productos conservan altura natural");
  for (const itemCount of [4, 5, 10, 20]) {
    assert.ok(cartCounts[itemCount].listScrollHeight > cartCounts[itemCount].listClientHeight, `${itemCount} productos deben activar scroll interno`);
  }
  assert.ok(Math.abs(cartCounts[20].cartHeight - cartCounts[4].cartHeight) <= 3, "4–20 productos mantienen altura estable");
  assert.ok(Math.abs(cartCounts[20].pageHeight - cartCounts[4].pageHeight) <= 3, "20 productos no aumentan linealmente la página");
  assert.equal(cartCounts[20].cartHeaderStable, true, "el encabezado del carrito permanece fijo durante el scroll interno");

  const responsiveResults = {};
  for (const [width, height] of viewportCases) {
    await navigate(width, height, 10);
    const result = await metrics();
    responsiveResults[`${width}x${height}`] = result;
    assert.equal(result.globalOverflow, false, `${width}x${height}: sin overflow horizontal global`);
    assert.equal(result.backVisible, true, `${width}x${height}: Volver al inicio visible y táctil`);
    assert.ok(result.nameLines <= 1, `${width}x${height}: Ken Code permanece horizontal`);
    assert.equal(result.emailFits, true, `${width}x${height}: correo largo contenido`);
    assert.equal(result.cardsFit, true, `${width}x${height}: tarjetas comerciales contenidas`);
    assert.equal(result.moneyFits, true, `${width}x${height}: importes contenidos y legibles`);
    assert.ok(result.minimumCardWidth >= 250, `${width}x${height}: tarjetas no colapsan`);
    const expectedColumns = width >= 1700 ? 3 : width >= 1280 ? 2 : 1;
    assert.equal(result.columns, expectedColumns, `${width}x${height}: cambio de grid antes de comprimir`);
    if (width <= 430) assert.ok(result.headerHeight <= 84, `${width}x${height}: header móvil compacto`);
  }

  await navigate(1440, 900, 20);
  await evaluate("document.querySelector('[data-testid=pos-cart-lines]').scrollTop = 0; document.querySelector('[data-testid=pos-cart-lines]').focus(); true");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  assert.ok(await evaluate("document.querySelector('[data-testid=pos-cart-lines]').scrollTop > 0"), "PageDown desplaza la lista interna enfocada");

  const screenshots = [[1920, 1080, "desktop-wide"], [1100, 800, "desktop-intermediate"], [768, 1024, "tablet"], [392, 608, "mobile-392"]];
  for (const [width, height, name] of screenshots) {
    await navigate(width, height, 10);
    const capture = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(outputDir, `${name}.png`), Buffer.from(capture.data, "base64"));
  }

  await writeFile(join(outputDir, "metrics.json"), JSON.stringify({ cartCounts, responsiveResults }, null, 2));
  console.log("POS browser layout dimensions, responsive grid, keyboard scroll and screenshots: PASS");
} catch (error) {
  if (serverOutput) console.error(serverOutput.slice(-8_000));
  throw error;
} finally {
  if (cdp?.socket.readyState === WebSocket.OPEN) cdp.socket.close();
  const stop = async (processToStop) => {
    if (!processToStop || processToStop.exitCode !== null) return;
    const exited = new Promise((resolveExit) => processToStop.once("exit", resolveExit));
    processToStop.kill();
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  };
  await stop(chrome);
  await stop(server);
  await rm(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
