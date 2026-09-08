const { test, expect } = require(process.env.EPICD_PLAYWRIGHT_ROOT + "/@playwright/test");
test("database-backed sign-in displays the delivered application output", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill("fixture-user");
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome green", exact: true })).toBeVisible();
  await expect(page.getByTestId("database-name")).toHaveText("browser_fixture");
});
