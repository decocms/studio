import { expect, test } from "@playwright/experimental-ct-react";
import { BusinessCaseHarness } from "../harness/business-case-harness";

test.use({ locale: "pt-BR", viewport: { width: 1200, height: 900 } });

const SHOTS = process.env.CASE_SCREENSHOTS;

test("a ready case opens with its verdict and the math behind it", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BusinessCaseHarness kind="ready" width={960} />,
  );
  await expect(component.getByText(/pode trazer/)).toBeVisible();
  await expect(component.getByText("Teste A/B", { exact: true })).toBeVisible();
  await expect(component.getByText("9 dias")).toBeVisible();
  await expect(component.getByText("carrinhos por mês")).toBeVisible();
  await expect(component.getByText("Tempo até o frete aparecer")).toBeVisible();
  await expect(component.getByText("4,1 s")).toBeVisible();
  await expect(component.getByText("Perguntar no chat")).toHaveCount(2);
  await component.getByText("Ver detalhes").first().click();
  await expect(
    component.getByText("No celular o abandono chega a 47%"),
  ).toBeVisible();
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/ready-wide.png`, fullPage: true });
});

test("a building case shows the live question and waiting tiles", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BusinessCaseHarness kind="building" width={960} />,
  );
  await expect(
    component.getByText(/Qual é a margem média por pedido/),
  ).toBeVisible();
  await expect(component.getByText("calculando agora")).toBeVisible();
  await expect(component.getByText("vem depois")).toHaveCount(2);
  await expect(component.getByText(/ainda está sendo calculado/)).toBeVisible();
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/building-wide.png`,
      fullPage: true,
    });
});

test("a case written before the numbers keeps its words and shows no tiles", async ({
  mount,
  page,
}) => {
  const component = await mount(<BusinessCaseHarness kind="old" width={960} />);
  await expect(component.getByText(/pode trazer/)).toHaveCount(0);
  await expect(component.getByText("Dinheiro em jogo")).toHaveCount(1);
  await expect(
    component.getByText("Uns R$ 40 mil por mês, pela conta da equipe"),
  ).toBeVisible();
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/old-wide.png`, fullPage: true });
});

test("a narrow panel puts each act's name above its steps", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 900 });
  const component = await mount(
    <BusinessCaseHarness kind="ready" width={560} />,
  );
  await expect(
    component.getByText("Vale a pena?").filter({ visible: true }),
  ).toHaveCount(1);
  if (SHOTS)
    await page.screenshot({
      path: `${SHOTS}/ready-narrow.png`,
      fullPage: true,
    });
});
