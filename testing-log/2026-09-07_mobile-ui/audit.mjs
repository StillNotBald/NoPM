// Mobile UI audit script for NoPM.
// Usage: node audit.mjs
// Requires the dev server running at http://localhost:3110 with the demo
// account seeded. Read-only: never submits create/edit/delete forms.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:3110";
const OUT = __dirname;

const VIEWPORTS = {
  iphone: {
    dir: "iphone",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  android: {
    dir: "android",
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 2.5,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  },
};

const PAGES = [
  "/",
  "/login",
  "/case-study",
  "/start",
  "/dashboard",
  "/my-work",
  "/my-tasks",
  "/portfolio",
  "/projects",
  "/projects/__FIRST__",
  "/tasks",
  "/mainline",
  "/sprints",
  "/timesheets",
  "/resources",
  "/budget",
  "/risks",
  "/issues",
  "/clashes",
  "/documents",
  "/decisions",
  "/change-control",
  "/baselines",
  "/approvals",
  "/review",
  "/trust",
  "/tokens",
  "/settings",
  "/email-previews",
];

const PANEL_PAGES = ["/risks", "/issues", "/tasks", "/projects/__FIRST__", "/resources"];

function safeName(p) {
  return p.replace(/^\//, "").replace(/\//g, "_") || "home";
}

async function measurePage(page) {
  return page.evaluate(() => {
    const innerW = window.innerWidth;
    const scrollW = document.documentElement.scrollWidth;
    const overflow = scrollW > innerW + 1;

    let offenders = [];
    if (overflow) {
      const all = document.querySelectorAll("body *");
      const seen = new Set();
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.right > innerW + 1 && r.width > 0) {
          const sig =
            el.tagName.toLowerCase() +
            (el.className && typeof el.className === "string"
              ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
              : "");
          if (!seen.has(sig)) {
            seen.add(sig);
            offenders.push({ sig, right: Math.round(r.right), width: Math.round(r.width) });
          }
        }
      }
      offenders = offenders.sort((a, b) => b.right - a.right).slice(0, 8);
    }

    // Tiny tap targets
    const interactive = document.querySelectorAll(
      'a, button, input, select, [role="button"]',
    );
    const tiny = [];
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (r.width < 40 || r.height < 40) {
        const sig =
          el.tagName.toLowerCase() +
          (el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
            : "") +
          (el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label")}"]` : "");
        tiny.push({ sig, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    const tinyCounts = {};
    for (const t of tiny) tinyCounts[t.sig] = (tinyCounts[t.sig] || 0) + 1;
    const tinyTop = Object.entries(tinyCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sig, count]) => ({ sig, count }));

    // Small text
    const allEls = document.querySelectorAll("body *");
    const smallTextSigs = {};
    let smallTextCount = 0;
    for (const el of allEls) {
      if (el.children.length > 0) continue; // leaf-ish only, avoid double counting containers
      const text = el.textContent && el.textContent.trim();
      if (!text) continue;
      const style = window.getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      if (size && size < 13) {
        smallTextCount++;
        const sig =
          el.tagName.toLowerCase() +
          (el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
            : "");
        smallTextSigs[sig] = (smallTextSigs[sig] || 0) + 1;
      }
    }
    const smallTextTop = Object.entries(smallTextSigs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sig, count]) => ({ sig, count }));

    // Fixed/sticky header overlap check at scroll 0
    let headerOverlap = null;
    const headers = document.querySelectorAll("header, [class*='sticky'], [class*='fixed']");
    let topHeader = null;
    for (const h of headers) {
      const style = window.getComputedStyle(h);
      if (style.position === "sticky" || style.position === "fixed") {
        const r = h.getBoundingClientRect();
        if (r.top <= 5 && r.height > 0) {
          topHeader = { sig: h.tagName.toLowerCase(), bottom: Math.round(r.bottom) };
          break;
        }
      }
    }
    if (topHeader) {
      const probeX = innerW / 2;
      const elBelow = document.elementFromPoint(probeX, topHeader.bottom + 2);
      headerOverlap = {
        headerBottom: topHeader.bottom,
        elementJustBelow: elBelow ? elBelow.tagName.toLowerCase() + (elBelow.className ? "." + String(elBelow.className).split(" ")[0] : "") : null,
      };
    }

    // Wide tables
    const tables = document.querySelectorAll("table");
    const wideTables = [];
    for (const t of tables) {
      const r = t.getBoundingClientRect();
      if (r.width > innerW + 1) {
        let wrapper = t.parentElement;
        let hasScrollWrapper = false;
        let depth = 0;
        while (wrapper && depth < 4) {
          const ws = window.getComputedStyle(wrapper);
          if (ws.overflowX === "auto" || ws.overflowX === "scroll") {
            hasScrollWrapper = true;
            break;
          }
          wrapper = wrapper.parentElement;
          depth++;
        }
        wideTables.push({ width: Math.round(r.width), hasScrollWrapper });
      }
    }

    // Bottom nav
    let bottomNav = null;
    const nav = document.querySelector("nav.fixed.inset-x-0.bottom-0, nav[class*='fixed'][class*='bottom-0']");
    if (nav) {
      const r = nav.getBoundingClientRect();
      const bodyStyle = window.getComputedStyle(document.querySelector("main") || document.body);
      bottomNav = {
        visible: r.height > 0,
        height: Math.round(r.height),
        mainPaddingBottom: bodyStyle.paddingBottom,
      };
    }

    return {
      innerW,
      scrollW,
      overflow,
      offenders,
      tinyCount: tiny.length,
      tinyTop,
      smallTextCount,
      smallTextTop,
      headerOverlap,
      wideTables,
      bottomNav,
    };
  });
}

async function main() {
  const browser = await chromium.launch();
  const results = { iphone: {}, android: {} };
  const panelResults = { iphone: {}, android: {} };
  let firstProjectId = null;

  for (const [key, cfg] of Object.entries(VIEWPORTS)) {
    console.log(`\n=== Viewport: ${key} ===`);
    const context = await browser.newContext({
      viewport: cfg.viewport,
      deviceScaleFactor: cfg.deviceScaleFactor,
      isMobile: cfg.isMobile,
      hasTouch: cfg.hasTouch,
      userAgent: cfg.userAgent,
    });
    const page = await context.newPage();

    // Demo login
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const demoBtn = page.locator('button:has-text("Try the live demo")').first();
    if (await demoBtn.count()) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => {}),
        demoBtn.click(),
      ]);
    } else {
      console.log("  demo login button not found on landing; navigating to /dashboard directly");
      await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" }).catch(() => {});
    }
    console.log("  logged in, url=", page.url());

    // Resolve first project id once
    if (!firstProjectId) {
      await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" }).catch(() => {});
      const link = page.locator('a[href^="/projects/"]').first();
      if (await link.count()) {
        const href = await link.getAttribute("href");
        const m = href && href.match(/\/projects\/([a-f0-9-]+)/i);
        if (m) firstProjectId = m[1];
      }
      console.log("  firstProjectId =", firstProjectId);
    }

    for (const rawPath of PAGES) {
      const p = rawPath.replace("__FIRST__", firstProjectId || "");
      if (rawPath.includes("__FIRST__") && !firstProjectId) {
        console.log(`  skip ${rawPath} (no project id resolved)`);
        continue;
      }
      const name = safeName(rawPath === "/projects/__FIRST__" ? "/projects/detail" : rawPath);
      try {
        await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 20000 });
      } catch (e) {
        console.log(`  ! nav failed ${p}: ${e.message}`);
        results[key][name] = { error: String(e.message) };
        continue;
      }
      await page.waitForTimeout(400); // settle animations

      const shotPath = path.join(OUT, "baseline", cfg.dir, `${name}.png`);
      await page.screenshot({ path: shotPath, fullPage: true }).catch((e) => {
        console.log(`  ! screenshot failed ${p}: ${e.message}`);
      });

      const metrics = await measurePage(page).catch((e) => ({ error: String(e.message) }));
      results[key][name] = { path: p, ...metrics };
      console.log(
        `  ${p} -> overflow=${metrics.overflow} tiny=${metrics.tinyCount} smallText=${metrics.smallTextCount}`,
      );
    }

    // Panel/form interactions on representative pages
    for (const rawPath of PANEL_PAGES) {
      const p = rawPath.replace("__FIRST__", firstProjectId || "");
      if (rawPath.includes("__FIRST__") && !firstProjectId) continue;
      const name = safeName(rawPath === "/projects/__FIRST__" ? "/projects/detail" : rawPath) + "_panel";
      try {
        await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(400);

        // Try to find a row / card / "new" trigger to open a panel — don't submit anything.
        let opened = false;
        const candidates = [
          'tr[role="button"]',
          '[data-testid*="row"]',
          'button:has-text("New")',
          'button:has-text("Add")',
          '.kanban-card',
        ];
        for (const sel of candidates) {
          const loc = page.locator(sel).first();
          if (await loc.count()) {
            await loc.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);
            const dialog = page.locator('[role="dialog"]').first();
            if (await dialog.count()) {
              opened = true;
              break;
            }
          }
        }

        if (opened) {
          const bodyScrollBefore = await page.evaluate(() => document.body.style.overflow);
          const shotPath = path.join(OUT, "baseline", cfg.dir, `${name}.png`);
          await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
          const panelInfo = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return null;
            const r = dialog.getBoundingClientRect();
            const closeBtn = dialog.querySelector('[aria-label="Close"], [aria-label="Close panel"], [aria-label="Close command palette"]');
            let closeReachable = null;
            if (closeBtn) {
              const cr = closeBtn.getBoundingClientRect();
              closeReachable = {
                inViewport: cr.top >= 0 && cr.left >= 0 && cr.bottom <= window.innerHeight && cr.right <= window.innerWidth,
                w: Math.round(cr.width),
                h: Math.round(cr.height),
              };
            }
            return {
              fullScreen: r.width >= window.innerWidth - 2 && r.height >= window.innerHeight - 2,
              width: Math.round(r.width),
              height: Math.round(r.height),
              top: Math.round(r.top),
              bodyOverflow: document.body.style.overflow || getComputedStyle(document.body).overflow,
              closeReachable,
            };
          });
          panelResults[key][name] = { path: p, ...panelInfo };
          console.log(`  panel on ${p}:`, JSON.stringify(panelInfo));
          // close it (Escape) — don't submit
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(300);
        } else {
          panelResults[key][name] = { path: p, opened: false };
          console.log(`  no panel opened on ${p}`);
        }
      } catch (e) {
        panelResults[key][name] = { path: p, error: String(e.message) };
        console.log(`  ! panel test failed ${p}: ${e.message}`);
      }
    }

    await context.close();
  }

  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, panelResults, firstProjectId }, null, 2));
  await browser.close();
  console.log("\nDone. Results written to results.json");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
