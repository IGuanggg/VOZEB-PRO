import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// 移动端（390px / 430px，由配置里的 mobile-390 / mobile-430 项目按文件名分派）最小回归：
// 打开画布 → 新建文字节点并直接输入中文 → 开关提示词面板 → 全程无横向溢出、关键控件可达。
// 复杂交互（剪贴板来源、组合态、撤销/重做、上传占位）只在桌面 spec 覆盖，这里不复制那套用例。
//
// 说明：这里验证的是 Chromium 的移动视口 + 触摸设备模拟（devices["iPhone 13"] / ["iPhone 14 Pro Max"]），
// 不是真实 iOS Safari / Android 浏览器，因此不声称验证了真实移动端浏览器差异。

const ADD_TEXT_BUTTON = { name: "文本", exact: true } as const;
const TEXT_NODE_CONTENT = 'textarea[placeholder="点击编辑文字"]';

test("移动端画布可新建文字节点直接输入，提示词面板可开关且无横向溢出", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: `Mobile canvas ${randomUUID().slice(0, 8)}`,
        viewport: { x: 20, y: 60, k: 1 },
        nodes: [{ id: "mobile-image", type: "image", title: "mobile-image", position: { x: 40, y: 10 }, width: 260, height: 200, metadata: { content: "/logo.svg", naturalWidth: 240, naturalHeight: 180 } }],
        connections: [],
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
        await page.goto(`/canvas/${project.id}`, { waitUntil: "domcontentloaded" });
        const surface = page.locator("[data-canvas-surface]");
        await expect(surface).toBeVisible({ timeout: 20_000 });
        const viewport = page.viewportSize();
        expect(viewport).not.toBeNull();
        await expectNoHorizontalOverflow(page, `${viewport!.width}px 打开画布`);

        // 关键入口：工具栏“文本”按钮必须能在当前视口里滚到可点位置。
        const addTextButton = page.getByRole("button", ADD_TEXT_BUTTON);
        await addTextButton.scrollIntoViewIfNeeded();
        const addTextBox = await requireBoundingBox(addTextButton);
        expect(addTextBox.x).toBeGreaterThanOrEqual(-1);
        expect(addTextBox.x + addTextBox.width).toBeLessThanOrEqual(viewport!.width + 1);
        await addTextButton.click();

        const textNode = page.locator('[data-node-id^="text-"]').first();
        await expect(textNode).toBeVisible();
        const textarea = textNode.locator(TEXT_NODE_CONTENT);
        // 新建即进入编辑态并获得焦点，直接键入即可，不需要再点一次。
        await expect.poll(() => textarea.evaluate((element) => document.activeElement === element)).toBe(true);
        await page.keyboard.type("移动端直接输入");
        await expect(textarea).toHaveValue("移动端直接输入");
        await expectNoHorizontalOverflow(page, `${viewport!.width}px 新建文字节点`);

        // 打开提示词面板：面板宽度必须落在视口内。
        const imageNode = page.locator('[data-node-id="mobile-image"]');
        await expect(imageNode).toBeVisible();
        await imageNode.click({ position: { x: 36, y: 36 } });
        const promptBox = page.getByRole("textbox", { name: "节点提示词" });
        await expect(promptBox).toBeVisible();
        const promptBounds = await requireBoundingBox(promptBox);
        expect(promptBounds.x).toBeGreaterThanOrEqual(-1);
        expect(promptBounds.x + promptBounds.width).toBeLessThanOrEqual(viewport!.width + 1);
        await expectNoHorizontalOverflow(page, `${viewport!.width}px 提示词面板打开`);

        // 点画布空白处关闭面板：面板消失且页面仍然正常。
        await clickCanvasBlank(page, surface, viewport!.width);
        await expect(promptBox).toBeHidden();
        await expectNoHorizontalOverflow(page, `${viewport!.width}px 提示词面板关闭`);
        await expect(surface).toBeVisible();
        await expect(textNode).toBeVisible();
        expect(pageErrors, `页面出现未捕获异常：${pageErrors.join(" | ")}`).toEqual([]);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

async function createCanvasProject(request: APIRequestContext, project: Record<string, unknown>) {
    const response = await request.post("/api/canvas/projects", { data: { title: project.title, project } });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { id: string } } }).data.project;
}

async function deleteCanvasProject(request: APIRequestContext, id: string) {
    try {
        const response = await request.delete("/api/canvas/projects", { data: { ids: [id] } });
        expect(response.ok(), await response.text()).toBe(true);
    } catch (error) {
        // 与服务端 5s keep-alive 关闭空闲连接有关，只对网络层错误原样重发一次。
        if (!(error instanceof Error) || !/ECONNRESET|ECONNREFUSED|socket hang up/i.test(error.message)) throw error;
        const response = await request.delete("/api/canvas/projects", { data: { ids: [id] } });
        expect(response.ok(), await response.text()).toBe(true);
    }
}

// 移动端右上角固定空白点：避开预设图片节点、底部工具栏与左下角缩放控件。
async function clickCanvasBlank(page: Page, surface: Locator, width: number) {
    const box = await requireBoundingBox(surface);
    await page.mouse.click(Math.min(box.x + width - 30, box.x + box.width - 30), box.y + 150);
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
    const widths = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(widths.scrollWidth, `${label} document overflow`).toBeLessThanOrEqual(widths.clientWidth + 1);
}

async function requireBoundingBox(locator: Locator) {
    const box = await locator.boundingBox();
    expect(box, "元素没有可见的 boundingBox").not.toBeNull();
    return box!;
}
