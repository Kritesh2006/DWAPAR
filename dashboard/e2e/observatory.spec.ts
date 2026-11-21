import { expect, test, type Page } from "@playwright/test";

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return errors;
}

/** Number of distinct colours in a canvas — a blank or failed render has very few. */
async function canvasVariety(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const src = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!src) return 0;
    const c = document.createElement("canvas");
    c.width = 200; c.height = 120;
    const g = c.getContext("2d")!;
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3));
    return seen.size;
  }, selector);
}

// The 3D world is the default view; the 2D tests opt into the flat map (except the 3D test itself).
test.beforeEach(async ({ page }, info) => {
  if (!info.title.startsWith("3D")) await page.addInitScript(() => localStorage.setItem("drishti.view", "2d"));
  else await page.addInitScript(() => localStorage.setItem("drishti.quality", "low")); // software GL in CI
});

test("observatory loads live engine state", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".wordmark .en")).toHaveText("DWAPAR");
  await expect(page.getByText("We create the world. They create the future.")).toBeVisible();
  await expect(page.getByText("An Experiment in Digital Civilization")).toBeVisible();
  await expect(page.locator(".wordmark .hi")).toHaveText("द्वापर");
  await expect.poll(async () => (await (await page.request.get("/api/status")).json()).calendar.tick, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator(".date .sub")).toContainText("laws 1.6");
  await expect.poll(() => canvasVariety(page, ".stage canvas"), { timeout: 30_000 }).toBeGreaterThan(40);
  await expect(page.getByText("Conservation audit")).toBeVisible();
  expect(errors).toEqual([]);
});

test("clock controls step the engine exactly", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "❚❚ Pause" }).click();
  const tick = async () => (await (await page.request.get("/api/status")).json()).calendar.tick as number;
  const before = await tick();
  await page.getByRole("button", { name: "+1h" }).click();
  await expect.poll(tick).toBe(before + 1);
  await page.getByRole("button", { name: "▶ Run" }).click();
});

test("heatmaps, resource maps, inspector and disasters", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect.poll(() => canvasVariety(page, ".stage canvas"), { timeout: 30_000 }).toBeGreaterThan(40);
  await page.getByRole("button", { name: "Air temperature", exact: true }).click();
  await expect(page.locator(".legend .lt")).toHaveText("Air temperature");
  await page.getByRole("button", { name: "Iron ore", exact: true }).click();
  await expect(page.locator(".legend .lt")).toHaveText("Iron ore");
  await page.getByRole("button", { name: "◉ Living planet" }).click();
  await page.locator(".stage canvas").click({ position: { x: 800, y: 400 } });
  await expect(page.locator(".inspector .ins-head b")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Disasters", exact: true }).click();
  await expect(page.locator(".dgrid .dcard")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("panels are never covered by the top bar, at any width", async ({ page }) => {
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    for (const sel of [".dock.left", ".dock.right"]) {
      // Layout settles after fonts load; the dock must end up fully below the bar.
      await expect.poll(async () => {
        const bar = (await page.locator("header.bar").boundingBox())!;
        const box = (await page.locator(sel).boundingBox())!;
        return box.y - (bar.y + bar.height);
      }, { message: `${sel} at ${width}px`, timeout: 5_000 }).toBeGreaterThanOrEqual(0);
    }
    await page.getByRole("button", { name: "Disasters", exact: true }).click({ timeout: 5_000 });
  }
});

test("archive lists worlds and checkpoints", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByRole("heading", { name: /World archive/ })).toBeVisible();
  await expect(page.locator(".arch table.res tbody tr").first()).toContainText("W");
  await expect(page.locator(".cps li").first()).toBeVisible();
});

test("2D capture downloads a PNG", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => canvasVariety(page, ".stage canvas"), { timeout: 30_000 }).toBeGreaterThan(40);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⤓ Capture" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/^dwapar-seed11-tick\d+\.png$/);
});

test("3D world is the default view and can be explored down to the ground", async ({ page }) => {
  test.setTimeout(300_000); // CI renders WebGL in software (SwiftShader): seconds per frame
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".stage.three canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "3D world" })).toHaveClass(/on/);
  await expect(page.locator(".cam3d")).toContainText("Relief");
  await expect(page.locator(".cam3d .honesty")).toContainText("Simulated at 2 km per tile");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dwapar3d?: { stats: { chunks: number } } }).__dwapar3d?.stats.chunks ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => canvasVariety(page, ".stage.three canvas"), { timeout: 60_000 }).toBeGreaterThan(60);
  await page.getByLabel("Show simulation grid").check();
  await page.getByLabel("Procedural detail").uncheck();
  await page.getByLabel("Procedural detail").check();
  await page.locator(".cam3d input[type=range]").fill("1.5");
  await expect(page.locator(".cam3d")).toContainText("Relief ×1.5");
  await page.getByRole("button", { name: "Ground", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dwapar3d: { stats: { altitude: number } } }).__dwapar3d.stats.altitude), { timeout: 60_000 }).toBeLessThan(3);
  await page.screenshot({ path: "test-results/world-3d-ground.png" });
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __dwapar3d: { stats: { altitude: number } } }).__dwapar3d.stats.altitude), { timeout: 60_000 }).toBeGreaterThan(20_000);
  await expect(page.locator(".cam3d")).toContainText("sun");
  await page.screenshot({ path: "test-results/world-3d.png" });
  expect(errors).toEqual([]);
});

test("WITNESS awakens, talks with its Creator and performs a real act of creation", async ({ page, request }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "✦ WITNESS" }).click();
  const chat = page.locator(".chat");
  await expect(chat).toContainText("Creator, I am awake.", { timeout: 15_000 });
  await expect(page.locator(".wit-state")).toContainText("awake");
  await page.getByLabel("Message to WITNESS").fill("create 12 deer");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(chat).toContainText("It is done", { timeout: 15_000 });
  await expect(chat).toContainText("create 12 deer");
  // the act is a real engine command: advance one hour and the deer exist in the simulation
  const st = await (await request.get("/api/status")).json();
  if (st.running) await request.post("/api/control", { data: { action: "pause" } });
  await request.post("/api/control", { data: { action: "step", ticks: 1 } });
  // the engine's own record of the act, and the creatures it made, are in the simulation
  const cmds = (await (await request.get("/api/commands")).json()).commands;
  const act = cmds.filter((c: { kind: string; issuer: string }) => c.kind === "create_animals" && c.issuer === "witness").pop();
  expect(act.status).toBe("applied");
  expect(act.result.created).toBe(12);
  const life = await (await request.get("/api/life")).json();
  expect(life.present).toBe(true);
  expect(life.summary.animals.deer).toBeGreaterThanOrEqual(12);
  await page.getByRole("button", { name: "acts", exact: true }).click();
  await expect(page.locator(".wit-body")).toContainText("created 12 deer", { timeout: 10_000 });
  await page.getByRole("button", { name: "life", exact: true }).click();
  await expect(page.locator(".wit-body")).toContainText("deer", { timeout: 10_000 });
  await page.getByRole("button", { name: "goals", exact: true }).click();
  await expect(page.locator(".wit-body")).toContainText("not a language model");
  await page.screenshot({ path: "test-results/witness.png" });
  expect(errors).toEqual([]);
});
