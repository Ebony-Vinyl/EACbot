import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { platform, release, version } from "node:os";
import { join, resolve } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";
import { fixtureApi, parkUntilSignal } from "./testing/preview-fixture.ts";

const out = resolve(process.argv[2] ?? ".omb-scratch/verify-evidence/workspace-ui");
const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const staticDir = resolve(flag("--static-dir") ?? "dist");
const indexFile = join(staticDir, "index.html");
const expectedBuild = flag("--expected-index-sha256");
const viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const mobileViewport = { ...viewport, width: 390, height: 844 };
const text = flag("--text") ?? "EACbot fixture: confirm this message reached Pepper.";
const reply = flag("--reply") ?? "Pepper received the message in the isolated EACbot workspace.";
const composer = JSON.stringify('textarea[aria-label="Message Pepper"]');
const transcript = JSON.stringify('[role="log"][aria-label="Conversation with Pepper"]');
const rail = ".workspace-rail";
const moreTrigger = `${rail} button[title="More"][aria-haspopup="dialog"]`;
const mobileNavigation = '.workspace-mobile-bar button[aria-label="Workspace navigation"]';
const drawerClose = '.workspace-drawer button[aria-label="Close settings"]';
const settingsClose = '[data-settings-workspace] button[aria-label="Close settings"]';
const railPage = (page: string) => `${rail} [data-workspace-page="${page}"]`;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const rectSource = `element => {
  if (!element) return null;
  const {left, top, right, bottom, width, height} = element.getBoundingClientRect();
  return {left, top, right, bottom, width, height};
}`;
const record = (name: string, value: unknown) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const note = (phase: string) => console.error(`[workspace-ui] ${new Date().toISOString()} ${phase}`);
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

assert(process.env.EAC_CDP_CHROME && existsSync(process.env.EAC_CDP_CHROME), "Set EAC_CDP_CHROME to an installed Chromium browser executable");
assert(existsSync(indexFile), `Build this worktree before launching: ${indexFile}`);
const indexSha256 = sha256(readFileSync(indexFile));
if (expectedBuild !== undefined) assert.equal(indexSha256, expectedBuild.toLowerCase(), "The built index does not match the requested build");
const build = { staticDir, indexModified: statSync(indexFile).mtime.toISOString(), indexSha256, expectedBuild };
mkdirSync(out, { recursive: true });
const fixture = await launchVerificationServer({
  SYSTEMROOT: process.env.SystemRoot,
  WINDIR: process.env.windir,
  COMSPEC: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  FAKE_CLAUDE_REPLIES: JSON.stringify([reply]),
  FAKE_CLAUDE_TOOL_CALLS: "[]",
}, controller.signal, undefined, undefined, undefined, undefined, [], undefined, staticDir, { timeoutMs: 120_000, note });
let page: HeadlessPage | undefined;
try {
  const actions: unknown[] = [];
  const api = fixtureApi(fixture.info.url, { observe: (action) => actions.push(action) });
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  await api("PATCH", "/api/config", { language: "en" });
  const { bots } = await api("GET", "/api/bots");
  for (const bot of bots.filter((bot: { defaultBot?: object }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
  const { bot } = await control(["new-bot", "--name", "Pepper"]) as { bot: { id: string } };
  await api("PATCH", `/api/bots/${bot.id}`, { color: "silver" });
  record("fixture-preferences.json", { botId: bot.id, color: "silver", method: "PATCH", path: `/api/bots/${bot.id}` });
  const { task } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Workspace check" });
  const threadId = task.threadId as string;
  await api("POST", `/api/bots/${bot.id}/tasks/${threadId}`, {});
  record("dataset.json", { botId: bot.id, threadId, title: "Workspace check", userText: text, fakeReply: reply, identityColor: "silver", createdThrough: "POST /api/bots/:id/tasks", selectedThrough: "POST /api/bots/:id/tasks/:threadId" });
  const group = process.argv.includes("--regressions") ? (await api("POST", "/api/groups", {
    name: "Fixture team", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
  })).group as { id: string } : undefined;
  controller.signal.throwIfAborted();
  const previewUrl = `${fixture.info.url}/`;
  const res = await fetch(previewUrl);
  assert(res.ok);
  assert.equal(sha256(Buffer.from(await res.arrayBuffer())), indexSha256, "The fixture must serve the selected built index");
  const run = { ...fixture.info, previewUrl, botId: bot.id, threadId, groupId: group?.id, out, viewport, build, actions };
  record("run.json", run);
  console.log(JSON.stringify(run));
  const doctor = await control(["doctor"]);
  record("doctor.json", doctor);
  assert((doctor as { ok: boolean }).ok);
  controller.signal.throwIfAborted();
  note("Opening the preview in the disposable browser profile");
  page = await openHeadlessChrome(join(fixture.info.dataDir, "ui-browser"));
  console.log(JSON.stringify({ debuggerUrl: page.debuggerUrl }));
  for (const method of ["Runtime.enable", "Log.enable", "Network.enable", "DOM.enable", "CSS.enable"]) await page.send(method);
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: 'localStorage.setItem("omb-analytics-opt-out", "1"); localStorage.setItem("omb-email-gate", "skipped"); localStorage.setItem("omb-simple-mode-prompt", "1"); localStorage.setItem("grok-move-2026-11", "1");' });
  await page.send("Emulation.setDeviceMetricsOverride", viewport);
  await page.send("Page.navigate", { url: previewUrl });
  await page.until(`location.href === ${JSON.stringify(previewUrl)} && document.body`);
  record("environment.json", {
    ...await page.evaluate(`({userAgent: navigator.userAgent, language: navigator.language, devicePixelRatio, viewportScale: visualViewport.scale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, capturedAt: new Date().toISOString()})`),
    os: { platform: platform(), release: release(), version: version() }, browser: await page.send("Browser.getVersion"), viewport,
  });
  if (process.argv.includes("--park")) {
    note("Parked for manual CDP; stop this launcher with Ctrl-C");
    await parkUntilSignal();
  } else {
    const browser = page;
    const key = async (key: string, code: number) => {
      const params = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await browser.send("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
      await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    };
    const click = async (selector: string, label?: string) => {
      const elementExpression = label === undefined ? `document.querySelector(${JSON.stringify(selector)})`
        : `[...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.textContent.trim() === ${JSON.stringify(label)})`;
      await browser.until(elementExpression);
      const point = await browser.evaluate(`(async () => {
        const element = ${elementExpression};
        element.scrollIntoView({block: 'nearest'});
        const hit = () => {
          const box = element.getBoundingClientRect();
          const x = box.left + box.width / 2, y = box.top + box.height / 2;
          const target = document.elementFromPoint(x, y);
          return {x, y, reachable: !!box.width && !!box.height && (target === element || element.contains(target)), target: target?.outerHTML.slice(0, 200)};
        };
        let point = hit();
        for (let frame = 0; frame < 60 && !point.reachable; frame++) {
          await new Promise(done => requestAnimationFrame(done));
          point = hit();
        }
        return point;
      })()`);
      assert(point.reachable, `${label ?? selector} is covered: ${point.target}`);
      for (const type of ["mousePressed", "mouseReleased"]) await browser.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
      return point;
    };
    const shot = async (name: string) => {
      await browser.evaluate(`(async () => {
        await document.fonts.ready;
        for (let pass = 0; pass < 5; pass++) {
          const running = document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
          if (!running.length) break;
          await Promise.allSettled(running.map(animation => animation.finished));
        }
        const geometry = () => JSON.stringify([...document.querySelectorAll('.workspace-rail, .workspace-conversation-list, [data-sidebar], [data-conversation-header], [data-tour=composer], .workspace-drawer')].map(element => {
          const box = element.getBoundingClientRect(), style = getComputedStyle(element);
          return [box.x, box.y, box.width, box.height, style.transform, style.opacity];
        }));
        let previous = geometry(), stable = 0;
        for (let frame = 0; frame < 60 && stable < 3; frame++) {
          await new Promise(done => requestAnimationFrame(done));
          const current = geometry();
          stable = current === previous ? stable + 1 : 0;
          previous = current;
        }
        if (stable < 3) throw new Error('Screenshot geometry did not settle');
      })()`);
      writeFileSync(join(out, `${name}.png`), await browser.capture());
    };
    const geometry = () => browser.evaluate(`(() => {
      const rect = ${rectSource};
      const selectors = ['.workspace-rail', '.workspace-conversation-list', '[data-sidebar]', '[data-board-card]', '.workspace-drawer', '.workspace-content'];
      return {
        viewport: {width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth},
        panels: Object.fromEntries(selectors.map(selector => {
          const element = document.querySelector(selector);
          if (!element) return [selector, null];
          const style = getComputedStyle(element);
          return [selector, {bounds: rect(element), display: style.display, visibility: style.visibility, transform: style.transform,
            translate: style.translate, opacity: style.opacity, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden')}];
        })),
        animations: document.getAnimations().map(animation => ({playState: animation.playState, currentTime: animation.currentTime, duration: animation.effect?.getTiming().duration}))
      };
    })()`);
    const waitForReply = () => browser.until(`document.querySelector(${transcript})?.textContent?.includes(${JSON.stringify(reply)}) && !document.querySelector('[data-welcome]')`);
    const transcriptRows = () => browser.evaluate(`[...document.querySelector(${transcript}).querySelectorAll('[data-mid]')].map(row => ({ id: row.dataset.mid, text: row.innerText }))`);
    const railControls = () => browser.evaluate(`(() => {
      const rect = ${rectSource};
      return [...document.querySelectorAll('.workspace-rail button')].map(element => ({page: element.dataset.workspacePage,
        label: element.getAttribute('aria-label'), title: element.title, text: element.innerText, current: element.getAttribute('aria-current'), bounds: rect(element)}));
    })()`);
    const checkOverflow = (name: string, width: number, actual: { width: number; scrollWidth: number; bodyWidth: number }) => {
      assert.equal(actual.width, width, `${name} viewport width`);
      assert(actual.scrollWidth <= width && actual.bodyWidth <= width, `Horizontal overflow in ${name}: ${JSON.stringify(actual)}`);
    };
    const palette = () => browser.evaluate(`(() => {
      const rect = ${rectSource};
      const root = getComputedStyle(document.documentElement);
      const shell = getComputedStyle(document.querySelector('.workspace-shell'));
      const surfaces = Object.fromEntries(Object.entries({rail: '.workspace-rail', sidebar: '[data-sidebar]', list: '.workspace-conversation-list', canvas: '[data-chat-pane]', surface: '.workspace-surface', header: '[data-conversation-header]', title: '[data-chathead-pill]', model: '.workspace-header-model [data-tour=model]', chatBar: '[data-chat-pane] > [data-glass-frame] > [data-glass-bar=top]', composer: '[data-tour=composer]', shell: '.workspace-shell', settings: '[data-settings-workspace]', settingsNav: '.settings-workspace-nav'}).map(([name, selector]) => {
        const element = document.querySelector(selector);
        if (!element) return [name, null];
        const style = getComputedStyle(element);
        return [name, {background: style.backgroundColor, color: style.color, fontFamily: style.fontFamily, borderRadius: style.borderRadius,
          display: style.display, bounds: rect(element)}];
      }));
      const bounds = surfaces.surface?.bounds;
      return {skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.mpTheme, lang: document.documentElement.lang,
        semantic: Object.fromEntries(['app','frame','panel','card','raised','raised-hover','composer','edge','ink','ink-secondary','accent'].map(key => [key, shell.getPropertyValue('--color-' + key).trim()])),
        fontFamily: root.fontFamily, surfaces,
        viewport: {width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth},
        surfaceRightInset: bounds ? innerWidth - bounds.right : null, surfaceBottomInset: bounds ? innerHeight - bounds.bottom : null};
    })()`);
    const fontTelemetry = async () => {
      const { root } = await browser.send("DOM.getDocument", { depth: 0 });
      const fonts: Record<string, unknown> = {};
      for (const [name, selector] of Object.entries({
        conversation: `[data-sidebar-bot-row="${bot.id}"] .truncate .truncate`, title: "[data-chathead-pill] .truncate",
        message: '[role="log"] [data-chat-bubble]', composer: "[data-tour=composer] textarea",
      })) {
        const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        if (!nodeId) continue;
        fonts[name] = {
          style: await browser.evaluate(`(() => {
            const element = document.querySelector(${JSON.stringify(selector)}), style = getComputedStyle(element);
            return {sample: element.innerText?.trim() || element.placeholder, family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight};
          })()`),
          ...await browser.send("CSS.getPlatformFontsForNode", { nodeId }),
        };
      }
      return { faces: await browser.evaluate("[...document.fonts].map(({family, status, weight}) => ({family, status, weight}))"), fonts };
    };
    const pepperRow = `Array.from(document.querySelectorAll('[data-sidebar-bot-row]')).find(row => row.textContent?.includes('Pepper'))`;
    await page.until(`document.querySelector('[data-welcome]') || document.querySelector(${composer}) || ${pepperRow}`, 120_000);
    if (await page.evaluate("!!document.querySelector('[data-welcome=meet]')")) {
      await shot("welcome-meet");
      await click("[data-welcome=meet] [data-primary]");
      await page.until("!document.querySelector('[data-welcome=meet]')");
    }
    if (await page.evaluate("!!document.querySelector('[data-welcome=chief]')")) {
      await shot("welcome-chief");
      await click("[data-chief-later]");
    }
    await page.until("!document.querySelector('[data-welcome]')");
    await click(`[data-sidebar-bot-row="${bot.id}"]`);
    await page.until(`document.querySelector(${composer}) && !document.querySelector(${composer}).disabled`);
    assert.equal(await page.evaluate(`document.querySelector(${transcript}).querySelectorAll('[data-mid]').length`), 0, "Workspace check must start with an empty conversation");
    await shot("before-send");
    record("before-send-accessibility.json", await page.send("Accessibility.getFullAXTree"));
    record("chat-header-geometry.json", await page.evaluate(`(() => {
      const header = document.querySelector('[data-conversation-header]').getBoundingClientRect();
      const bubble = document.querySelector(${transcript}).querySelector('[data-chat-bubble]')?.getBoundingClientRect();
      return {headerBottom: header.bottom, firstBubbleTop: bubble?.top, firstBubbleBottom: bubble?.bottom};
    })()`));
    controller.signal.throwIfAborted();
    note("Sending through the composer with Enter");
    record("composer-hit.json", await click('textarea[aria-label="Message Pepper"]'));
    assert(await page.evaluate(`document.activeElement === document.querySelector(${composer})`));
    await page.send("Input.insertText", { text });
    assert.equal(await page.evaluate(`document.querySelector(${composer}).value`), text);
    await key("Enter", 13);
    await page.until(`document.querySelector(${transcript})?.textContent?.includes(${JSON.stringify(text)})`);
    const wait = await control(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "60"]);
    record("wait.json", wait);
    const messages = await control(["messages", "--bot", bot.id, "--task", threadId, "--limit", "10"]) as { messages: Array<{ role: string; kind: string; text: string }> };
    record("messages.json", messages);
    assert.equal((wait as { status: string }).status, "settled");
    await waitForReply();
    const spoken = messages.messages.filter((message) => message.kind === "text").map(({ role, text }) => ({ role, text }));
    assert.deepEqual(spoken, [{ role: "user", text }, { role: "bot", text: reply }]);
    const rendered = await transcriptRows();
    assert.equal(rendered.filter((row: { text: string }) => row.text.includes(text)).length, 1);
    assert.equal(rendered.filter((row: { text: string }) => row.text.includes(reply)).length, 1);
    record("renderer.json", await page.evaluate(`({title: document.title, url: location.href, userAgent: navigator.userAgent, transcript: document.querySelector(${transcript}).innerText})`));
    await shot("after-reply");
    record("transcript-row-count.json", { rows: await page.evaluate(`document.querySelector(${transcript}).querySelectorAll('[data-mid]').length`) });
    record("after-reply-accessibility.json", await page.send("Accessibility.getFullAXTree"));
    record("chat-header-after-reply-geometry.json", await page.evaluate(`(() => {
      const header = document.querySelector('[data-conversation-header]').getBoundingClientRect();
      const bubble = document.querySelector(${transcript}).querySelector('[data-chat-bubble]')?.getBoundingClientRect();
      return {headerBottom: header.bottom, firstBubbleTop: bubble?.top, firstBubbleBottom: bubble?.bottom};
    })()`));
    note("Confirmed the sent message and fake reply in Pepper's conversation");
    await page.send("Page.reload");
    await waitForReply();
    assert.deepEqual((await transcriptRows()).map((row: { id: string }) => row.id), rendered.map((row: { id: string }) => row.id), "Reload must restore the same transcript rows");
    record("refresh.json", await page.evaluate(`({url: location.href, transcript: document.querySelector(${transcript}).innerText})`));
    await shot("after-refresh");
    if (process.argv.includes("--visuals")) {
      const visualAssertions: string[] = [];
      const desktopAcceptance = (theme: string, actual: Awaited<ReturnType<typeof palette>>) => {
        const { rail, sidebar, canvas, header, title, model, chatBar, composer } = actual.surfaces;
        const near = (name: string, observed: number | undefined, expected: number, tolerance = 1) => {
          if (observed === undefined || Math.abs(observed - expected) > tolerance) visualAssertions.push(`${theme} ${name} is ${observed}px; expected ${expected}px`);
        };
        const centerX = (surface: { bounds: { left: number; right: number } }) => (surface.bounds.left + surface.bounds.right) / 2;
        near("rail width", rail?.bounds.width, 52);
        near("sidebar width", sidebar?.bounds.width, 280);
        near("chat header height", header?.bounds.height, 38);
        near("chat top bar height", chatBar?.bounds.height, 38);
        near("composer height", composer?.bounds.height, 48);
        near("Pepper identity offset from chat header center", title && header ? centerX(title) - centerX(header) : undefined, 0, 2);
        near("chat header inset from the canvas top", header && canvas ? header.bounds.top - canvas.bounds.top : undefined, 1, 2);
        if (!header || header.bounds.top < 37) visualAssertions.push(`${theme} header starts at ${header?.bounds.top}px; expected y=37px or lower`);
        if (!header || [title, model].some(element => !element || element.bounds.width === 0 || element.bounds.height === 0 || element.bounds.top < header.bounds.top || element.bounds.bottom > header.bounds.bottom)) {
          visualAssertions.push(`${theme} Pepper identity and model controls must fit inside the chat header`);
        }
        if (!rail || !sidebar || !canvas || rail.bounds.right > sidebar.bounds.left + 1 || sidebar.bounds.right > canvas.bounds.left + 1) {
          visualAssertions.push(`${theme} rail, sidebar and chat must be separate columns in that order`);
        }
        checkOverflow(`${theme} desktop`, viewport.width, actual.viewport);
      };
      const selected = (selector: string) => JSON.stringify(`${selector}[aria-current="page"]`);
      const settingsButton = `${rail} [data-workspace-settings]`;
      const setTheme = async (theme: "light" | "dark") => {
        await click(".workspace-drawer button", `Switch to ${theme} theme`);
        await page.until(`document.documentElement.dataset.mpTheme === '${theme}'`);
        if (await page.evaluate("!!document.querySelector('.workspace-drawer')")) await click(drawerClose);
        await page.until("!document.querySelector('.workspace-drawer')");
      };
      const defaultTheme = await page.evaluate("document.documentElement.dataset.mpTheme");
      if (defaultTheme === "dark") {
        await click(moreTrigger);
        await setTheme("light");
      }
      record("initial-theme.json", { defaultTheme });
      note("Checking the desktop function rail, Settings return, and theme persistence");
      await click(railPage("task-center"));
      await page.until(`document.querySelector(${selected(railPage("task-center"))}) && document.querySelector('.task-center')`);
      await click(settingsButton);
      await page.until(`document.querySelector('[data-settings-workspace]') && document.querySelector(${selected(settingsButton)})`);
      await shot("settings-desktop-light");
      const settingsLayout = await palette();
      record("settings-desktop-light-palette.json", settingsLayout);
      if (settingsLayout.surfaces.rail?.bounds.width !== 52 || Math.abs((settingsLayout.surfaces.settingsNav?.bounds.width ?? 0) - 280) > 1) visualAssertions.push("Settings must keep the 52px function rail and show a separate 280px settings column");
      await click(settingsClose);
      await page.until(`!document.querySelector('[data-settings-workspace]') && document.querySelector(${selected(railPage("task-center"))}) && document.querySelector('.task-center')`);
      record("settings-return.json", { returnedTo: "task-center", current: await railControls() });
      await shot("settings-return-route");
      await click(railPage("chat"));
      await waitForReply();
      await shot("desktop-light");
      const desktopLight = await palette();
      record("desktop-light-palette.json", desktopLight);
      record("desktop-light-fonts.json", await fontTelemetry());
      desktopAcceptance("light", desktopLight);
      const controls = await railControls() as Array<{ page?: string; label: string | null; title: string; current: string | null; bounds: { width: number; height: number; top: number; bottom: number } }>;
      record("rail-controls.json", controls);
      assert(controls.length >= 6 && controls.every(({ label, title, bounds }) => (label || title) && bounds.width > 0 && bounds.height > 0), "Desktop rail must show named controls");
      assert.equal(controls.find((control) => control.page === "chat")?.current, "page");
      assert(controls.slice(1).every((control, index) => control.bounds.top >= controls[index]!.bounds.bottom - 1), "Desktop rail controls must stack vertically without overlapping");
      await click(moreTrigger);
      await page.until("document.querySelector('.workspace-drawer')");
      await shot("desktop-more-light");
      await setTheme("dark");
      await page.send("Page.reload");
      await waitForReply();
      await page.until('document.documentElement.dataset.mpTheme === "dark"');
      await shot("desktop-dark");
      const desktopDark = await palette();
      record("desktop-dark-palette.json", desktopDark);
      record("desktop-dark-fonts.json", await fontTelemetry());
      desktopAcceptance("dark", desktopDark);
      if (process.argv.includes("--regressions")) {
        note("Checking keyboard resize, compact sidebar controls, and persisted width");
        const initialWidth = await page.evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().width");
        const resize = async (key: "ArrowRight" | "ArrowLeft", expected: number) => {
          await browser.until("document.querySelector('[data-sidebar-resize]')");
          await browser.evaluate("document.querySelector('[data-sidebar-resize]').focus()");
          assert(await browser.evaluate("document.activeElement.matches('[data-sidebar-resize]')"));
          await pressResizeKey(key);
          await browser.until(`document.querySelector('[data-sidebar-resize]').getAttribute('aria-valuenow') === '${expected}'`);
          await shot(`sidebar-resize-${expected}`);
          const measured = await browser.evaluate("({width: document.querySelector('[data-sidebar]').getBoundingClientRect().width, ariaValue: Number(document.querySelector('[data-sidebar-resize]').getAttribute('aria-valuenow'))})");
          assert.equal(measured.width, expected);
          assert.equal(measured.ariaValue, expected);
          return { key, delta: key === "ArrowRight" ? 16 : -16, ...measured };
        };
        const pressResizeKey = (direction: "ArrowRight" | "ArrowLeft") => key(direction, direction === "ArrowRight" ? 39 : 37);
        const compactSidebar = "[data-sidebar][data-sidebar-density=icons]";
        const widened = await resize("ArrowRight", initialWidth + 16);
        await page.send("Page.reload");
        await waitForReply();
        await shot("sidebar-resize-persisted");
        const persisted = await page.evaluate("({width: document.querySelector('[data-sidebar]').getBoundingClientRect().width, ariaValue: Number(document.querySelector('[data-sidebar-resize]').getAttribute('aria-valuenow'))})");
        assert.equal(persisted.width, widened.width);
        assert.equal(persisted.ariaValue, widened.ariaValue);
        const restored = await resize("ArrowLeft", initialWidth);
        const collapseKeys: string[] = [];
        for (let count = 0; count < 20 && !await browser.evaluate(`!!document.querySelector(${JSON.stringify(compactSidebar)})`); count++) {
          await browser.evaluate("document.querySelector('[data-sidebar-resize]').focus()");
          await pressResizeKey("ArrowLeft");
          collapseKeys.push("ArrowLeft");
        }
        await browser.until(`document.querySelector(${JSON.stringify(compactSidebar)})`);
        await shot("sidebar-icons");
        const icons = await browser.evaluate(`(() => {
          const rect = ${rectSource};
          const sidebar = document.querySelector(${JSON.stringify(compactSidebar)}), header = sidebar.querySelector('[data-sidebar-top-row]');
          const inspect = element => {
            const bounds = rect(element), target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
            const ancestors = [];
            for (let item = element; item && item !== sidebar; item = item.parentElement) {
              const display = getComputedStyle(item).display;
              ancestors.push({tag: item.tagName, marker: Object.keys(item.dataset), display, bounds: rect(item)});
            }
            return {label: element.getAttribute('aria-label'), bounds, reachable: bounds.width > 0 && bounds.height > 0 && (target === element || element.contains(target)), ancestors};
          };
          return {width: rect(sidebar).width, ariaValue: Number(document.querySelector('[data-sidebar-resize]').getAttribute('aria-valuenow')),
            header: rect(header), buttons: [...sidebar.querySelectorAll('[data-sidebar-rail-top] button, [data-sidebar-top-buttons] button')].map(inspect),
            tabs: [...sidebar.querySelectorAll('[data-sidebar-view-switch] button')].map(inspect)};
        })()`);
        record("sidebar-icons.json", icons);
        assert.equal(icons.width, icons.ariaValue);
        assert.deepEqual(icons.buttons.map((item: { label: string }) => item.label), ["Search bots and messages", "New or share"]);
        for (const item of [...icons.buttons, ...icons.tabs]) assert(item.reachable, `Collapsed sidebar control ${item.label} is hidden or covered`);
        assert.equal(icons.tabs.length, 2);
        assert(icons.buttons.every(({ bounds: box }: { bounds: { left: number; top: number; right: number; bottom: number } }) => box.left >= icons.header.left && box.right <= icons.header.right && box.top >= icons.header.top && box.bottom <= icons.header.bottom), "Collapsed sidebar controls must fit their header");
        assert(icons.buttons[0].bounds.bottom <= icons.buttons[1].bounds.top || icons.buttons[1].bounds.bottom <= icons.buttons[0].bounds.top, "Collapsed sidebar controls must not overlap");
        await browser.evaluate("document.querySelector('[data-sidebar-resize]').focus()");
        await pressResizeKey("ArrowRight");
        await browser.until(`!document.querySelector(${JSON.stringify(compactSidebar)})`);
        await shot("sidebar-reopened");
        const drag = await browser.evaluate(`(() => {
          const rect = ${rectSource};
          const sidebar = rect(document.querySelector('[data-sidebar]')), handle = document.querySelector('[data-sidebar-resize]'), edge = rect(handle);
          const fromX = edge.left + edge.width / 2, y = edge.top + edge.height / 2;
          const hit = x => { const target = document.elementFromPoint(x, y); return {x, handle: target === handle || handle.contains(target), target: target?.outerHTML.slice(0, 220)}; };
          const hits = [edge.left + 1, fromX - 1, fromX, fromX + 1, edge.right - 1].map(hit);
          return {sidebar, edge, fromX, toX: sidebar.left + ${Number(initialWidth)}, y, hits, reachedCenter: hits[2].handle};
        })()`);
        if (drag.reachedCenter) {
          await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", x: drag.fromX, y: drag.y, button: "left", clickCount: 1 });
          await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.toX, y: drag.y, button: "left", buttons: 1 });
          await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: drag.toX, y: drag.y, button: "left", clickCount: 1 });
        } else visualAssertions.push("The center of the desktop sidebar resize handle is covered");
        await shot("sidebar-restored");
        const finalWidth = await browser.evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().width");
        record("sidebar-resize.json", { initialWidth, widened, persisted, restored, collapseKeys, icons, reopenedWith: "ArrowRight", restoreDrag: drag, finalWidth });
        if (finalWidth !== initialWidth) visualAssertions.push(`Dragging the sidebar back to ${initialWidth}px left it at ${finalWidth}px`);
      }
      note("Checking mobile overflow, conversation switching, and navigation drawer motion");
      await page.send("Emulation.setDeviceMetricsOverride", mobileViewport);
      await shot("mobile-dark");
      const mobileDark = await palette();
      record("mobile-dark-palette.json", mobileDark);
      const mobileDarkGeometry = await geometry();
      record("mobile-closed-dark-geometry.json", mobileDarkGeometry);
      checkOverflow("closed dark mobile", mobileViewport.width, mobileDarkGeometry.viewport);
      assert.equal(mobileDark.surfaces.rail?.bounds.width ?? 0, 0, "Desktop rail must not occupy the mobile viewport");
      const closedList = mobileDarkGeometry.panels[".workspace-conversation-list"];
      assert(!closedList || closedList.inert && closedList.bounds.right <= 1, "Closed conversation column must not show on mobile");
      const modelPickers = await page.evaluate("[...document.querySelectorAll('[data-tour=model]')].map(element => { const box = element.getBoundingClientRect(); return {text: element.innerText, left: box.left, right: box.right, width: box.width, height: box.height, display: getComputedStyle(element).display, viewportWidth: innerWidth}; })") as Array<{ left: number; right: number; width: number; height: number; viewportWidth: number }>;
      record("mobile-model-picker.json", modelPickers);
      assert.equal(modelPickers.filter((picker) => picker.width > 0 && picker.height > 0).length, 1);
      assert(modelPickers.every((picker) => picker.left >= 0 && picker.right <= picker.viewportWidth), "Mobile model picker must fit the viewport");
      const openNavigation = async () => { await click(mobileNavigation); await page.until("document.querySelector('.workspace-drawer')"); };
      const waitNavigationClosed = () => page.until("!document.querySelector('.workspace-drawer')");
      if (process.argv.includes("--regressions")) {
        const drawerOpen = `document.querySelector('[data-conversation-drawer]')`;
        const drawerClosed = `!(${drawerOpen}) && !document.querySelector('.workspace-content').inert`;
        const openConversationDrawer = async () => {
          await click('button[aria-label="Open bot list"]');
          await page.until(`${drawerOpen} && document.querySelector('.workspace-content').inert`);
        };
        await openConversationDrawer();
        await click(`[data-mobile-conversation="${bot.id}"]`);
        await page.until(drawerClosed);
        await shot("mobile-strip-closed-drawer");
        assert(group);
        await openConversationDrawer();
        await click(`[data-mobile-conversation="${group.id}"]`);
        await page.until(`${drawerClosed} && document.querySelector('textarea[aria-label="Message Fixture team"]')`);
        await shot("mobile-group-strip-closed-drawer");
        await page.send("Page.reload");
        await page.until(`${drawerClosed} && document.querySelector('[data-mobile-conversation="${group.id}"][aria-current=true]') && document.querySelector('textarea[aria-label="Message Fixture team"]')`);
        await shot("mobile-group-persisted");
        await click(`[data-mobile-conversation="${bot.id}"]`);
        await waitForReply();
        await openConversationDrawer();
        const boardTab = '[data-conversation-drawer] [data-shell-surface="sidebar"] [data-segment="board"]';
        await page.evaluate(`document.querySelector(${JSON.stringify(boardTab)}).focus()`);
        assert(await page.evaluate(`document.activeElement.matches(${JSON.stringify(boardTab)})`));
        await key("Enter", 13);
        await page.until("document.querySelector('[data-conversation-drawer] [data-shell-surface=board] [data-board-card]')", 5_000);
        const activeBoard = "document.activeElement.closest('[data-conversation-drawer] [data-shell-surface=board]') !== null";
        record("mobile-board-focus.json", await page.evaluate(`({keptInsideBoard: ${activeBoard}, active: document.activeElement.outerHTML.slice(0, 250)})`));
        await shot("mobile-board-open");
        const mobileBoard = await geometry();
        record("mobile-board-open-geometry.json", mobileBoard);
        checkOverflow("mobile conversation board", mobileViewport.width, mobileBoard.viewport);
        await key("Escape", 27);
        await page.until(drawerClosed, 3_000);
        await shot("mobile-board-escape-closed");
        await openConversationDrawer();
        await click('[data-conversation-drawer] [data-shell-surface="board"] [data-segment="sidebar"]');
        await page.until("document.querySelector('[data-shell-surface=sidebar] [data-sidebar]')");
        await click(`[data-mobile-conversation="${bot.id}"]`);
        await page.until(drawerClosed);
        await openConversationDrawer();
        await openNavigation();
        await click('.workspace-drawer [data-workspace-inbox]');
        await waitNavigationClosed();
        await page.until(`${drawerClosed} && document.querySelector('[data-inbox-panel=sheet]')`, 8_000);
        await shot("mobile-inbox-from-conversation-drawer");
        const inbox = await geometry();
        record("mobile-inbox-from-conversation-drawer.json", inbox);
        checkOverflow("mobile Inbox reached from conversation drawer", mobileViewport.width, inbox.viewport);
        await click('[data-inbox-panel=sheet] button[aria-label="Close inbox"]');
        await page.until("!document.querySelector('[data-inbox-panel]')");
        await waitForReply();
        record("mobile-regressions.json", { stripClosesConversationDrawer: true, groupStripClosesConversationDrawer: true, groupRetainedAfterReload: true, chatContentInertCleared: true, keyboardEnterThenEscapeClosesBoardDrawer: true, inboxClosesConversationDrawer: true });
      }
      await page.evaluate(`(() => {
        const rect = ${rectSource};
        const samples = [];
        window.workspaceDrawerSamples = samples;
        const observer = new MutationObserver(() => {
          const drawer = document.querySelector('.workspace-drawer');
          if (!drawer) return;
          observer.disconnect();
          const animation = drawer.getAnimations()[0];
          const sample = (stamp, frames = 0) => {
            const style = getComputedStyle(drawer);
            samples.push({stamp, bounds: rect(drawer), display: style.display, transform: style.transform,
              opacity: Number(style.opacity), animation: style.animationName, playState: animation?.playState,
              currentTime: Number(animation?.currentTime ?? 0)});
            if (animation && animation.playState !== 'finished' && frames < 60) requestAnimationFrame(next => sample(next, frames + 1));
          };
          sample(performance.now());
        });
        observer.observe(document.body, {childList: true, subtree: true});
      })()`);
      await openNavigation();
      await shot("mobile-drawer-dark");
      const drawerSamples = await page.evaluate("window.workspaceDrawerSamples");
      record("drawer-motion.json", drawerSamples);
      const first = drawerSamples[0], middle = drawerSamples.find((sample: { bounds: { left: number } }) => sample.bounds.left > first.bounds.left + 1 && sample.bounds.left < -1), last = drawerSamples.at(-1);
      assert(first && middle && last && first.bounds.left < -1 && Math.abs(last.bounds.left) <= 1 && first.opacity < last.opacity && last.opacity === 1 && last.currentTime > first.currentTime,
        "Navigation drawer must paint an initial, intermediate and settled frame");
      const drawerEnd = await geometry();
      record("drawer-tend.json", drawerEnd);
      checkOverflow("open mobile navigation", mobileViewport.width, drawerEnd.viewport);
      await click('.workspace-drawer button[data-workspace-page="task-center"]');
      await waitNavigationClosed();
      await page.until("document.querySelector('.task-center')");
      await openNavigation();
      await click(drawerClose);
      await waitNavigationClosed();
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await openNavigation();
      const reducedMotion = await page.evaluate(`(() => {
        const drawer = document.querySelector('.workspace-drawer');
        return {prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          animation: getComputedStyle(drawer).animationName, activeAnimations: drawer.getAnimations().length,
          left: drawer.getBoundingClientRect().left, opacity: Number(getComputedStyle(drawer).opacity)};
      })()`);
      record("drawer-reduced-motion.json", reducedMotion);
      assert(reducedMotion.prefersReducedMotion && reducedMotion.animation === "none" && reducedMotion.activeAnimations === 0 && Math.abs(reducedMotion.left) <= 1 && reducedMotion.opacity === 1);
      await page.send("Emulation.setEmulatedMedia", { features: [] });
      await setTheme("light");
      await openNavigation();
      await click('.workspace-drawer button[data-workspace-page="chat"]');
      await waitNavigationClosed();
      await click(`[data-mobile-conversation="${bot.id}"]`);
      await waitForReply();
      await page.send("Page.reload");
      await page.until('document.documentElement.dataset.mpTheme === "light"');
      await waitForReply();
      await shot("mobile-light");
      record("mobile-light-palette.json", await palette());
      const mobileLight = await geometry();
      record("mobile-closed-light-geometry.json", mobileLight);
      checkOverflow("closed light mobile", mobileViewport.width, mobileLight.viewport);
      assert.deepEqual((await transcriptRows()).map((row: { id: string }) => row.id), rendered.map((row: { id: string }) => row.id), "Mobile reload must restore the same transcript rows");
      const responsive: unknown[] = [];
      for (const [width, height] of [[767, 1024], [768, 1024], [1024, 768], [1600, 1000]] as const) {
        await page.send("Emulation.setDeviceMetricsOverride", { ...viewport, width, height });
        await shot(`responsive-${width}-light`);
        const layout = await palette();
        responsive.push(layout);
        checkOverflow(`responsive ${width}×${height}`, width, layout.viewport);
      }
      record("responsive-layouts.json", responsive);
      if (process.argv.includes("--chinese")) {
        await page.send("Emulation.setDeviceMetricsOverride", viewport);
        await click(settingsButton);
        await page.until("document.querySelector('[data-settings-workspace]')");
        const language = '[data-settings-workspace] select[aria-label="App language"]';
        await page.until(`document.querySelector(${JSON.stringify(language)})`);
        const steps = await page.evaluate(`(() => {
          const select = document.querySelector(${JSON.stringify(language)});
          select.scrollIntoView({block: 'nearest'});
          select.focus();
          const destination = [...select.options].findIndex(option => option.value === 'zh');
          if (document.activeElement !== select || destination < 0) throw new Error('The App language setting cannot select Chinese');
          return destination - select.selectedIndex;
        })()`);
        for (let step = 0; step < Math.abs(steps); step++) await key(steps > 0 ? "ArrowDown" : "ArrowUp", steps > 0 ? 40 : 38);
        const zhClose = '[data-settings-workspace] button[aria-label="关闭设置"]';
        await page.until(`document.querySelector(${JSON.stringify(zhClose)}) && document.querySelector('select[aria-label="应用语言"]')?.value === 'zh'`);
        await shot("settings-desktop-zh-light");
        await click(zhClose);
        await page.until("!document.querySelector('[data-settings-workspace]')");
        await shot("desktop-zh-light");
        await page.send("Page.reload");
        await page.until(`document.querySelector('[role=log]')?.textContent?.includes(${JSON.stringify(reply)}) && document.querySelector('.workspace-rail button[title="更多工具"]')`);
        await shot("desktop-zh-persisted");
        await page.send("Emulation.setDeviceMetricsOverride", mobileViewport);
        await shot("mobile-zh-light");
        record("chinese-locale.json", await page.evaluate(`({changedThrough: 'Settings native language select and keyboard input', lang: document.documentElement.lang, navigation: document.querySelector('.workspace-mobile-bar button[aria-label="工作空间导航"]')?.getAttribute('aria-label')})`));
        const chineseMobile = await geometry();
        record("mobile-zh-geometry.json", chineseMobile);
        checkOverflow("Chinese mobile", mobileViewport.width, chineseMobile.viewport);
      }
      record("visual-assertions.json", visualAssertions);
      assert.deepEqual(visualAssertions, []);
    }
    const errors = page.events.filter((event) => event.method === "Runtime.exceptionThrown" ||
      event.method === "Network.loadingFailed" && !(event.params as { canceled?: boolean }).canceled ||
      event.method === "Runtime.consoleAPICalled" && (event.params as { type?: string }).type === "error" ||
      event.method === "Log.entryAdded" && (event.params as { entry?: { level?: string } }).entry?.level === "error");
    record("browser-errors.json", errors);
    assert.deepEqual(errors, []);
    if (process.argv.includes("--park-after")) await parkUntilSignal();
  }
} catch (error) {
  record("failure.json", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
  if (page) {
    await page.capture().then((image) => writeFileSync(join(out, "failure.png"), image)).catch(() => {});
    await page.evaluate("({width: innerWidth, height: innerHeight, body: document.body.innerText})").then((state) => record("failure-renderer.json", state)).catch(() => {});
  }
  throw error;
} finally {
  if (page) record("browser-events.json", page.events);
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  try { await page?.closeAndWait(); }
  finally { await fixture.close(); }
  assert(!existsSync(fixture.info.dataDir), `Fixture data remains at ${fixture.info.dataDir}`);
  assert(fixture.child.exitCode !== null || fixture.child.signalCode !== null, `Fixture child ${fixture.info.pid} did not exit`);
  note(`Closed browser and child ${fixture.info.pid}, removed ${fixture.info.dataDir}`);
}
