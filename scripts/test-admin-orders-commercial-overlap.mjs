import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const componentSource = await readFile(join(repoRoot, "src/components/admin/order-commercial-terms.tsx"), "utf8");
const responsiveCss = await readFile(join(repoRoot, "src/components/admin/admin-orders-responsive.module.css"), "utf8");

assert.match(componentSource, /styles\.commercialLayout/);
assert.doesNotMatch(componentSource, /xl:grid-cols-\[minmax\(0,1fr\)_minmax\(300px,0\.7fr\)\]/);
assert.match(responsiveCss, /@container \(min-width: 1080px\)[\s\S]*grid-template-columns: minmax\(746px, 1fr\) minmax\(300px, 0\.7fr\)/);
assert.match(responsiveCss, /@container \(min-width: 1080px\)[\s\S]*\.commercialSummary[\s\S]*position: sticky/);

const nextBin = join(repoRoot, "node_modules", "next", "dist", "bin", "next");
const appPort = 3427;
const debugPort = 9427;
const baseUrl = `http://127.0.0.1:${appPort}/admin-orders-commercial-overlap-certification-local`;
const outputDir = join(repoRoot, ".visual-check", "admin-orders-commercial-overlap");

async function firstExecutable(paths) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {}
  }
  throw new Error("No se encontró Chrome/Chromium para la certificación del solapamiento comercial.");
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

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
}

const viewportCases = [
  [1920, 1080], [1768, 1000], [1600, 1000], [1440, 900], [1366, 768], [1280, 800],
  [1180, 820], [1024, 768], [834, 1194], [768, 1024], [430, 932], [390, 844], [360, 800],
];

const screenshotCases = new Set(["1440x900", "1024x768", "768x1024", "390x844"]);
const chromePath = await firstExecutable([
  process.env.CHROME_PATH,
  process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : null,
  process.platform === "win32" ? "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" : null,
  process.platform === "win32" && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
]);

await mkdir(outputDir, { recursive: true });
const chromeProfile = await mkdtemp(join(tmpdir(), "carzone-orders-commercial-overlap-"));
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
  await waitForUrl(baseUrl);
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
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(baseUrl)}`, { method: "PUT" }).then((response) => response.json());
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async function navigate(width, height) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: width < 768, screenWidth: width, screenHeight: height,
    });
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: baseUrl });
    await loaded;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const complete = await evaluate(`document.readyState === "complete"
        && Boolean(document.querySelector('[data-testid="order-commercial-layout"]'))
        && Boolean(document.querySelector('[data-testid="order-commercial-pricing"]'))
        && Boolean(document.querySelector('[data-testid="order-commercial-summary"]'))
        && Boolean(document.querySelector('[data-testid="order-commercial-delivery"]'))`);
      if (complete) {
        await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const controlsDeadline = Date.now() + 2_000;
        while (Date.now() < controlsDeadline) {
          const visibleControls = await evaluate(`[...document.querySelectorAll('[data-testid^="order-commercial-price-input-"]')]
            .filter((input) => input.getBoundingClientRect().width > 0).length`);
          if (visibleControls === 2) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`La fixture no terminó de cargar en ${width}x${height}`);
  }

  async function metrics() {
    return evaluate(`(() => {
      const layout = document.querySelector('[data-testid="order-commercial-layout"]');
      const pricing = document.querySelector('[data-testid="order-commercial-pricing"]');
      const summary = document.querySelector('[data-testid="order-commercial-summary"]');
      const delivery = document.querySelector('[data-testid="order-commercial-delivery"]');
      const tableWrap = document.querySelector('[data-testid="order-commercial-pricing-table"]');
      const table = tableWrap?.querySelector('table');
      const rect = (el) => el?.getBoundingClientRect();
      const visible = (el) => { const r = rect(el); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const intersection = (a, b) => !a || !b ? { width: 0, height: 0, area: 0 } : (() => {
        const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return { width, height, area: width * height };
      })();
      const pricingRect = rect(pricing), summaryRect = rect(summary), deliveryRect = rect(delivery), tableRect = rect(table);
      const visibleInputs = [...document.querySelectorAll('[data-testid^="order-commercial-price-input-"]')].filter(visible);
      const allPriceInputs = [...document.querySelectorAll('[data-testid^="order-commercial-price-input-"]')];
      const firstCardInput = document.querySelector('[data-testid$="-card"]');
      const cardContainer = firstCardInput?.closest('article')?.parentElement;
      const inputGeometry = visibleInputs.map((input) => {
        const r = rect(input);
        const probeY = Math.min(Math.max(r.top + 5, 0), innerHeight - 1);
        const probeX = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
        const hit = document.elementFromPoint(probeX, probeY);
        return {
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          insidePricing: r.left >= pricingRect.left - 1 && r.right <= pricingRect.right + 1,
          insideViewport: r.left >= -1 && r.right <= innerWidth + 1,
          summaryIntercepts: Boolean(hit && summary.contains(hit)),
          pricingOwnsProbe: r.top >= 0 && r.top < innerHeight ? Boolean(hit && pricing.contains(hit)) : true,
        };
      });
      const pricingText = pricing.innerText;
      const pricingTextLower = pricingText.toLocaleLowerCase('es');
      const summaryText = summary.innerText;
      const summaryValues = [...summary.querySelectorAll('dd')];
      const providerInput = delivery.querySelector('input:not([type="number"])');
      const providerRect = rect(providerInput);
      const layoutWidth = rect(layout).width;
      const columns = getComputedStyle(layout).gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length;
      return {
        viewport: [innerWidth, innerHeight],
        layoutWidth,
        columns,
        expectedColumns: layoutWidth >= 1080 ? 2 : 1,
        pricingSummaryIntersection: intersection(pricingRect, summaryRect),
        tableSummaryIntersection: visible(table) ? intersection(tableRect, summaryRect) : { width: 0, height: 0, area: 0 },
        pricingClipped: pricing.scrollWidth > pricing.clientWidth + 1,
        summaryClipped: summary.scrollWidth > summary.clientWidth + 1,
        deliveryClipped: delivery.scrollWidth > delivery.clientWidth + 1,
        providerValuePreserved: providerInput?.value.normalize('NFC') === 'Transportes Internacionales del Valle y Servicios Logísticos Especializados de Honduras'.normalize('NFC'),
        providerInputInsideDelivery: Boolean(providerRect)
          && providerRect.left >= deliveryRect.left - 1
          && providerRect.right <= deliveryRect.right + 1,
        tableClipped: visible(tableWrap) ? tableWrap.scrollWidth > tableWrap.clientWidth + 1 : false,
        deliveryBelowPricing: deliveryRect.top >= pricingRect.bottom - 1,
        summaryBelowLeftColumnWhenStacked: columns === 1 ? summaryRect.top >= deliveryRect.bottom - 1 : true,
        documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        visibleInputCount: visibleInputs.length,
        inputDiagnostics: {
          all: allPriceInputs.length,
          cards: allPriceInputs.filter((input) => input.dataset.testid.endsWith('-card')).length,
          tables: allPriceInputs.filter((input) => input.dataset.testid.endsWith('-table')).length,
          cardDisplay: cardContainer ? getComputedStyle(cardContainer).display : null,
          tableDisplay: tableWrap ? getComputedStyle(tableWrap).display : null,
          commercialWidth: document.querySelector('section[aria-labelledby^="commercial-terms-title-"]')?.getBoundingClientRect().width,
        },
        inputGeometry,
        pricingData: {
          product1: pricingText.includes('Kit premium de iluminación automotriz para instalación profesional'),
          product2: pricingText.includes('Protector lateral universal extralargo'),
          quantity12: /(^|\\D)12(\\D|$)/.test(pricingText),
          quantity25: /(^|\\D)25(\\D|$)/.test(pricingText),
          original: pricingTextLower.includes('original'),
          cost: pricingTextLower.includes('costo'),
          finalPrice: pricingTextLower.includes('precio final'),
        },
        summaryData: {
          merchandise: summaryText.includes('Mercadería'),
          base: summaryText.includes('Base'),
          tax: summaryText.includes('ISV incluido'),
          delivery: summaryText.includes('Entrega'),
          cashOnDelivery: summaryText.includes('Contra entrega'),
          total: summaryText.includes('Total'),
          largeMoney: /3,954,117[.,]11/.test(summaryText),
          allValuesFit: summaryValues.every((value) => value.scrollWidth <= value.clientWidth + 1),
        },
      };
    })()`);
  }

  const results = {};
  for (const [width, height] of viewportCases) {
    await navigate(width, height);
    const result = await metrics();
    const key = `${width}x${height}`;
    results[key] = result;
    assert.equal(result.columns, result.expectedColumns, `${key}: el layout responde al ancho real del contenedor`);
    assert.equal(result.pricingSummaryIntersection.area, 0, `${key}: pricing y resumen no se solapan`);
    assert.equal(result.tableSummaryIntersection.area, 0, `${key}: tabla y resumen no se solapan`);
    assert.equal(result.pricingClipped, false, `${key}: pricing no queda recortado`);
    assert.equal(result.summaryClipped, false, `${key}: resumen no queda recortado`);
    assert.equal(result.deliveryClipped, false, `${key}: entrega no queda recortada`);
    assert.equal(result.providerValuePreserved, true, `${key}: proveedor largo conserva su valor completo`);
    assert.equal(result.providerInputInsideDelivery, true, `${key}: proveedor largo permanece dentro de entrega`);
    assert.equal(result.tableClipped, false, `${key}: tabla visible cabe completa`);
    assert.equal(result.deliveryBelowPricing, true, `${key}: entrega permanece debajo del pricing`);
    assert.equal(result.summaryBelowLeftColumnWhenStacked, true, `${key}: el resumen apilado no cubre la columna editorial`);
    assert.equal(result.documentOverflow, 0, `${key}: sin overflow horizontal del documento`);
    assert.equal(result.visibleInputCount, 2, `${key}: ambos precios editables permanecen visibles ${JSON.stringify(result.inputDiagnostics)}`);
    assert.equal(result.inputGeometry.every((input) => input.insidePricing && input.insideViewport), true, `${key}: controles dentro de pricing/viewport`);
    assert.equal(result.inputGeometry.every((input) => !input.summaryIntercepts && input.pricingOwnsProbe), true, `${key}: el resumen no intercepta controles`);
    assert.equal(Object.values(result.pricingData).every(Boolean), true, `${key}: producto/unidades/precios preservados ${JSON.stringify(result.pricingData)}`);
    assert.equal(Object.values(result.summaryData).every(Boolean), true, `${key}: resumen financiero preservado y legible ${JSON.stringify(result.summaryData)}`);

    if (screenshotCases.has(key)) {
      const layoutMetrics = await cdp.send("Page.getLayoutMetrics");
      const contentSize = layoutMetrics.cssContentSize;
      const capture = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 },
      });
      await writeFile(join(outputDir, `after-${key}.png`), Buffer.from(capture.data, "base64"));
    }

    if (width === 1440) {
      const dirtyBefore = await evaluate(`document.querySelector('[data-testid="commercial-dirty-state"]').textContent.trim()`);
      assert.equal(dirtyBefore, "clean", "fixture inicia sin cambios pendientes");
      const focusAndEdit = await evaluate(`(() => {
        const input = [...document.querySelectorAll('[data-testid^="order-commercial-price-input-"]')]
          .find((candidate) => candidate.getBoundingClientRect().width > 0);
        input.focus();
        const focused = document.activeElement === input;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '123457.78');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return focused;
      })()`);
      assert.equal(focusAndEdit, true, "input de precio es alcanzable por teclado");
      await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate(`document.querySelector('[data-testid="commercial-dirty-state"]').textContent.trim()`), "dirty", "editar precio conserva dirty-state");
    }
  }

  console.log(JSON.stringify({
    status: "PASS",
    viewports: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, {
      layoutWidth: value.layoutWidth,
      columns: value.columns,
      pricingSummaryOverlap: value.pricingSummaryIntersection.area,
      tableSummaryOverlap: value.tableSummaryIntersection.area,
      documentOverflow: value.documentOverflow,
      visibleInputs: value.visibleInputCount,
    }])),
  }, null, 2));
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  try { cdp?.socket.close(); } catch {}
  await stopChild(chrome);
  await stopChild(server);
  await rm(chromeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
