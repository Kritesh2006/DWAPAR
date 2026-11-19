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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("drishti.view", "2d"));
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
    const barBox = await page.locator("header.bar").boundingBox();
    for (const sel of [".dock.left", ".dock.right"]) {
      const box = await page.locator(sel).boundingBox();
      expect(box!.y, `${sel} at ${width}px`).toBeGreaterThanOrEqual(barBox!.y + barBox!.height);
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

test("3D world renders the engine terrain with WebGL", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.getByRole("button", { name: "3D world" }).click();
  await expect(page.locator(".stage.three canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".cam3d")).toContainText("Relief");
  await expect.poll(() => canvasVariety(page, ".stage.three canvas"), { timeout: 45_000 }).toBeGreaterThan(60);
  await page.locator(".cam3d input[type=range]").fill("14");
  await page.getByRole("button", { name: "Overview" }).click();
  await expect(page.locator(".cam3d")).toContainText("sun");
  await page.screenshot({ path: "test-results/world-3d.png" });
  expect(errors).toEqual([]);
});
