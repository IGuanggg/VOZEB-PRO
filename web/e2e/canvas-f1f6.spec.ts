import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// F1–F6 画布可用性修复的浏览器回归（桌面，chromium 项目 / Desktop Chrome 1280x720）。
//
// 覆盖范围与局限（不要把这些用例当成比它们实际更强的证据）：
// 1. 所有用例都不触发真实收费生成：F3 里的图片任务在浏览器网络层被 page.route 拦下，服务端与上游都不会收到请求。
// 2. F3 的输入法部分用 page.evaluate 派发合成 KeyboardEvent（isComposing 来自构造参数），
//    不是真实输入法：自动化环境无法驱动操作系统输入法组合态，这里只验证 isComposing 分支的实现逻辑。
// 3. 断言全部走真实 UI（节点 DOM、提示词输入框、工具栏按钮、服务端项目数据），失败时不重启浏览器进程。

type CanvasNodeSeed = {
    id: string;
    type: string;
    title: string;
    position: { x: number; y: number };
    width: number;
    height: number;
    metadata: Record<string, unknown>;
};

// 站内静态资源，不依赖外网；带 naturalWidth/Height 让水合时不必再探测图片尺寸。
const IMAGE_METADATA = { content: "/logo.svg", naturalWidth: 240, naturalHeight: 180 };

// 项目标题会出现在顶栏标题按钮的可访问名里，所以测试标题只用 ASCII，避免撞上界面文案。
function projectTitle(scope: string) {
    return `${scope} ${randomUUID().slice(0, 8)}`;
}

// 工具栏按钮靠 aria-label 精确匹配：getByRole 的 name 默认是子串匹配，
// “文本”会同时命中节点上的“用文本生图”，“撤销/重做”会命中带项目标题的顶栏按钮。
const ADD_TEXT_BUTTON = { name: "文本", exact: true } as const;
const UNDO_BUTTON = { name: "撤销", exact: true } as const;
const REDO_BUTTON = { name: "重做", exact: true } as const;
const TEXT_NODE_CONTENT = 'textarea[placeholder="点击编辑文字"]';

// 仓库里已有的真实 1200x720 WebP，直接当上传素材用，不依赖外网也不伪造图片字节。
function uploadFixture() {
    return readFileSync(new URL("../public/generation-smoke.webp", import.meta.url));
}

test("F1 提示词草稿关闭面板、切换节点、刷新后都不丢失", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F1 prompt draft"),
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [node("draft-image-a", "image", 60, 120, 260, 200, { ...IMAGE_METADATA, prompt: "A 节点上一轮提示词" }), node("draft-image-b", "image", 380, 120, 260, 200, { ...IMAGE_METADATA, prompt: "B 节点上一轮提示词" })],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;
    const draftA = "把这张图改成清晨薄雾中的海边栈道，保留人物轮廓，整体色调偏冷，增加空气透视和雾气层次。";
    const draftA2 = "A 节点第二版草稿：改成黄昏光线。";
    const draftB = "B 节点专用草稿：把背景换成城市夜景。";

    try {
        const surface = await openCanvas(page, project.id);
        const nodeA = page.locator('[data-node-id="draft-image-a"]');
        const nodeB = page.locator('[data-node-id="draft-image-b"]');
        const promptBox = page.getByRole("textbox", { name: "节点提示词" });

        // 已有内容的节点：草稿走 promptDraft，不能回填上一轮的 prompt。
        await clickCanvasNode(nodeA);
        await expect(promptBox).toBeVisible();
        await expect.poll(() => promptBox.evaluate((element) => document.activeElement === element)).toBe(true);
        await expect(promptBox).toHaveValue("");

        await promptBox.fill(draftA);
        await expectCanvasSaved(page);
        await expect.poll(async () => readCanvasNodeMetadata(request, projectPath, "draft-image-a")).toMatchObject({ promptDraft: draftA });

        // 点画布空白处关闭面板，再打开：草稿仍在。
        await clickCanvasBlank(page, surface);
        await expect(promptBox).toBeHidden();
        await clickCanvasNode(nodeA);
        await expect(promptBox).toHaveValue(draftA);

        // 刷新后重新打开：草稿经服务端自动保存链恢复。
        await reloadCanvas(page);
        await clickCanvasNode(nodeA);
        await expect(promptBox).toHaveValue(draftA);

        // 清空草稿后刷新：仍是空，不能被旧 prompt 顶回来（节点上确实还挂着旧 prompt）。
        await promptBox.fill("");
        await expectCanvasSaved(page);
        await expect.poll(async () => readCanvasNodeMetadata(request, projectPath, "draft-image-a")).toMatchObject({ promptDraft: "" });
        await reloadCanvas(page);
        await clickCanvasNode(nodeA);
        await expect(promptBox).toHaveValue("");

        // 两个节点各自独立：A 的草稿不出现在 B 上，反之亦然。
        await promptBox.fill(draftA2);
        await expectCanvasSaved(page);
        await clickCanvasNode(nodeB);
        await expect(promptBox).toHaveValue("");
        await promptBox.fill(draftB);
        await expectCanvasSaved(page);
        await reloadCanvas(page);
        await clickCanvasNode(nodeA);
        await expect(promptBox).toHaveValue(draftA2);
        await clickCanvasNode(nodeB);
        await expect(promptBox).toHaveValue(draftB);
        await expect.poll(async () => readCanvasNodeMetadata(request, projectPath, "draft-image-b")).toMatchObject({ promptDraft: draftB });
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F2 粘贴按本次剪贴板来源分流：节点副本 → 外部文字 → 节点副本", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F2 clipboard source"),
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [node("copy-source", "image", 80, 130, 260, 200, { ...IMAGE_METADATA })],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;

    try {
        const surface = await openCanvas(page, project.id);
        const allNodes = page.locator("[data-node-id]");
        const imageNodes = page.locator('[data-node-id^="image-"]');
        const textNodes = page.locator('[data-node-id^="text-"]');
        const textNodeContent = page.locator(`[data-node-id^="text-"] ${TEXT_NODE_CONTENT}`);
        await expect(allNodes).toHaveCount(1);

        // 复制节点 → 粘贴：新增且只新增一个副本。
        await selectCanvasNode(page, surface, page.locator('[data-node-id="copy-source"]'));
        await page.keyboard.press("Control+c");
        await page.keyboard.press("Control+v");
        await expect(allNodes).toHaveCount(2);
        await expect(imageNodes).toHaveCount(1);

        // 外部文字（navigator.clipboard.writeText）→ 粘贴：应创建文本节点，而不是再粘贴一个节点副本。
        await page.evaluate(() => navigator.clipboard.writeText("外部文字"));
        await focusCanvasSurface(page, surface);
        await page.keyboard.press("Control+v");
        await expect(allNodes).toHaveCount(3);
        await expect(textNodes).toHaveCount(1);
        await expect(imageNodes).toHaveCount(1);
        await expect(textNodeContent).toHaveValue("外部文字");
        await expect.poll(() => readCanvasNodeCount(request, projectPath)).toBe(3);

        // 回到节点复制 → 粘贴：仍然只粘贴节点副本。
        await selectCanvasNode(page, surface, page.locator('[data-node-id="copy-source"]'));
        await page.keyboard.press("Control+c");
        await page.keyboard.press("Control+v");
        await expect(allNodes).toHaveCount(4);
        await expect(imageNodes).toHaveCount(2);
        await expect(textNodes).toHaveCount(1);
        await expect.poll(() => readCanvasNodeCount(request, projectPath)).toBe(4);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F3 组合态 Enter 不提交、非组合态 Enter 提交一次（合成事件，不是真实输入法）", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F3 composing"),
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [node("compose-image", "image", 60, 130, 260, 200, { ...IMAGE_METADATA })],
        connections: [],
    });
    const draft = "组合态草稿：把主体换成夜里的霓虹招牌";
    let imageTaskRequests = 0;

    // 浏览器层拦截：生成的 HTTP 请求不会离开页面，服务端与上游模型都不会被打到。
    await page.route("**/api/image-tasks", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        imageTaskRequests += 1;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: { id: "e2e-f3-task", status: "pending", model: "e2e-image" } }) });
    });
    await page.route("**/api/image-tasks/e2e-f3-task", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task: { id: "e2e-f3-task", status: "pending", model: "e2e-image" } }) });
    });

    try {
        const surface = await openCanvas(page, project.id);
        const node = page.locator('[data-node-id="compose-image"]');
        const promptBox = page.getByRole("textbox", { name: "节点提示词" });
        const generateButton = page.locator(".canvas-generate-button");

        await clickCanvasNode(node);
        await expect(promptBox).toBeVisible();
        await promptBox.fill(draft);
        await expect(generateButton).toHaveAttribute("aria-label", "生成");

        // 合成组合态 Enter：isComposing=true 必须被忽略（不提交、不改内容、未 preventDefault）。
        const composingPrevented = await dispatchSyntheticEnter(promptBox, true);
        // 负向断言窗口：合成键不会产生请求，这里只等一个很短的窗口再确认计数仍为 0。
        await page.waitForTimeout(500);
        expect(composingPrevented).toBe(false);
        expect(imageTaskRequests).toBe(0);
        await expect(promptBox).toHaveValue(draft);
        await expect(generateButton).toHaveAttribute("aria-label", "生成");

        // 放大编辑器里 Shift+Enter 换行而不是提交（真实键盘事件）。
        await page.getByRole("button", { name: "放大提示词输入" }).click();
        const dialog = page.getByRole("dialog", { name: "编辑提示词" });
        const expandedPrompt = dialog.getByRole("textbox", { name: "提示词编辑器" });
        await expect(dialog).toBeVisible();
        await expect(expandedPrompt).toHaveValue(draft);
        await expandedPrompt.press("Shift+Enter");
        await expect(expandedPrompt).toHaveValue(`${draft}\n`);
        await expect(dialog).toBeVisible();
        expect(imageTaskRequests).toBe(0);
        await dialog.getByRole("button", { name: "收起提示词输入" }).click();
        await expect(dialog).toBeHidden();
        await expect(promptBox).toHaveValue(`${draft}\n`);

        // 非组合态 Enter：同一个入口、同一个合成事件通道，这一次必须提交且只提交一次。
        const submittingPrevented = await dispatchSyntheticEnter(promptBox, false);
        expect(submittingPrevented).toBe(true);
        await expect.poll(() => imageTaskRequests).toBe(1);
        await expect(generateButton).toHaveAttribute("aria-label", "停止生成");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F4 新建文字节点即可输入，连续新建互不重叠", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F4 new text nodes"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });

    try {
        await openCanvas(page, project.id);
        const created: Array<{ id: string; text: string }> = [];

        for (const text of ["直接输入中文", "第二段中文", "第三段中文"]) {
            const before = await canvasNodeIds(page);
            await page.getByRole("button", ADD_TEXT_BUTTON).click();
            const id = await expectNewCanvasNode(page, before);
            const textarea = page.locator(`[data-node-id="${id}"] ${TEXT_NODE_CONTENT}`);
            // 新建后 textarea 自动获得焦点，不需要再点一次。
            await expect.poll(() => textarea.evaluate((element) => document.activeElement === element)).toBe(true);
            await page.keyboard.type(text);
            await expect(textarea).toHaveValue(text);
            created.push({ id, text });
        }

        await expect(page.locator("[data-node-id]")).toHaveCount(3);

        // 三个节点位置不完全重叠。
        const boxes = [];
        for (const item of created) boxes.push(await requireBoundingBox(page.locator(`[data-node-id="${item.id}"]`)));
        for (let first = 0; first < boxes.length; first += 1) {
            for (let second = first + 1; second < boxes.length; second += 1) {
                const sameX = Math.abs(boxes[first].x - boxes[second].x) < 2;
                const sameY = Math.abs(boxes[first].y - boxes[second].y) < 2;
                expect(sameX && sameY, `第 ${first + 1} 和第 ${second + 1} 个文字节点完全重叠`).toBe(false);
            }
        }
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F4 点击正文中间位置插入字符，顶部可拖动、正文拖动不改位置", async ({ page, request }) => {
    const content = "画布文字节点光标与拖动验收用例正文段落";
    const project = await createCanvasProject(request, {
        title: projectTitle("F4 text caret and drag"),
        viewport: { x: 80, y: 80, k: 1 },
        nodes: [node("text-caret", "text", 60, 140, 300, 200, { content })],
        connections: [],
    });

    try {
        await openCanvas(page, project.id);
        const node = page.locator('[data-node-id="text-caret"]');
        const textarea = node.locator(TEXT_NODE_CONTENT);
        await expect(textarea).toHaveValue(content);

        // 点击第一行中间位置 → 光标落在点击处，而不是被强制追加到末尾。
        await textarea.click({ position: { x: 60, y: 12 } });
        const caret = await textarea.evaluate((element) => element.selectionStart);
        expect(caret).toBeGreaterThan(0);
        expect(caret).toBeLessThan(content.length);
        await page.keyboard.type("中");
        await expect(textarea).toHaveValue(`${content.slice(0, caret)}中${content.slice(caret)}`);

        // 节点顶部区域（正文上方的内边距）按下并移动 → 节点位置改变。
        const beforeDrag = await requireBoundingBox(node);
        await page.mouse.move(beforeDrag.x + 60, beforeDrag.y + 10);
        await page.mouse.down();
        await page.mouse.move(beforeDrag.x + 60 + 120, beforeDrag.y + 10 + 60, { steps: 10 });
        await page.mouse.up();
        const afterDrag = await requireBoundingBox(node);
        expect(afterDrag.x - beforeDrag.x).toBeGreaterThan(80);
        expect(afterDrag.y - beforeDrag.y).toBeGreaterThan(30);

        // 正文区域按下并移动 → 是编辑区（选字），节点位置不变。
        await page.mouse.move(afterDrag.x + 60, afterDrag.y + 90);
        await page.mouse.down();
        await page.mouse.move(afterDrag.x + 60 + 140, afterDrag.y + 90 + 60, { steps: 10 });
        await page.mouse.up();
        const afterBodyDrag = await requireBoundingBox(node);
        expect(Math.abs(afterBodyDrag.x - afterDrag.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(afterBodyDrag.y - afterDrag.y)).toBeLessThanOrEqual(1);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F5 新建节点可撤销可重做", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F5 undo new node"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");
        const undoButton = page.getByRole("button", UNDO_BUTTON);
        const redoButton = page.getByRole("button", REDO_BUTTON);
        await expect(nodes).toHaveCount(0);
        await expect(undoButton).toBeDisabled();

        await page.getByRole("button", ADD_TEXT_BUTTON).click();
        const createdId = await expectNewCanvasNode(page, []);
        await expect(nodes).toHaveCount(1);
        // 把焦点移出 textarea：焦点在可编辑元素里时 Ctrl+Z 是浏览器原生文本撤销，不会走画布历史。
        await clickCanvasBlank(page, surface);
        await expect(undoButton).toBeEnabled();

        await page.keyboard.press("Control+z");
        await expect(nodes).toHaveCount(0);
        await expect(page.locator(`[data-node-id="${createdId}"]`)).toHaveCount(0);

        await page.keyboard.press("Control+Shift+z");
        await expect(nodes).toHaveCount(1);
        await expect(page.locator(`[data-node-id="${createdId}"]`)).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F5 一次拖动只算一步撤销", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F5 undo drag"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [node("drag-base", "text", 80, 160, 300, 200, { content: "拖动前的位置" })],
        connections: [],
    });

    try {
        await openCanvas(page, project.id);
        const node = page.locator('[data-node-id="drag-base"]');
        const undoButton = page.getByRole("button", UNDO_BUTTON);
        await expect(undoButton).toBeDisabled();
        const before = await requireBoundingBox(node);

        await page.mouse.move(before.x + 60, before.y + 10);
        await page.mouse.down();
        await page.mouse.move(before.x + 60 + 130, before.y + 10 + 70, { steps: 10 });
        await page.mouse.up();

        const moved = await requireBoundingBox(node);
        expect(moved.x - before.x).toBeGreaterThan(90);
        // 拖动结束会立即提交一步历史：撤销按钮可用即代表这一笔已经进栈（不是靠等待/重试掩盖）。
        await expect(undoButton).toBeEnabled();
        await page.keyboard.press("Control+z");

        await expect.poll(async () => Math.round((await requireBoundingBox(node)).x)).toBe(Math.round(before.x));
        await expect.poll(async () => Math.round((await requireBoundingBox(node)).y)).toBe(Math.round(before.y));
        await expect(page.locator("[data-node-id]")).toHaveCount(1);
        // 一次拖动只产生一步：再没有可撤销的历史。
        await expect(undoButton).toBeDisabled();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F5 连续两次独立操作各自一步撤销", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F5 undo twice"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");

        await page.getByRole("button", ADD_TEXT_BUTTON).click();
        const firstId = await expectNewCanvasNode(page, []);
        await clickCanvasBlank(page, surface);

        await page.getByRole("button", ADD_TEXT_BUTTON).click();
        const secondId = await expectNewCanvasNode(page, [firstId]);
        await clickCanvasBlank(page, surface);
        await expect(nodes).toHaveCount(2);

        await page.keyboard.press("Control+z");
        await expect(page.locator(`[data-node-id="${secondId}"]`)).toHaveCount(0);
        await expect(page.locator(`[data-node-id="${firstId}"]`)).toHaveCount(1);

        await page.keyboard.press("Control+z");
        await expect(page.locator("[data-node-id]")).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F5 连续两次结构操作各自一步撤销", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F5 undo two structural ops"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");
        const promptBox = page.getByRole("textbox", { name: "节点提示词" });
        await expect(nodes).toHaveCount(0);

        // 连续两次结构操作（新建图片节点），中间不做任何“结束编辑会话/拖动”的动作：
        // 这两步必须各自成为一步历史，不能被离散操作的合并窗口并成一步。
        await page.getByRole("button", { name: "图片", exact: true }).click();
        const firstId = await expectNewCanvasNode(page, []);
        await page.getByRole("button", { name: "图片", exact: true }).click();
        const secondId = await expectNewCanvasNode(page, [firstId]);
        await expect(nodes).toHaveCount(2);
        // 新建图片节点会打开提示词面板并自动聚焦：等它聚焦完再把焦点移回画布，Ctrl+Z 才走画布历史。
        await expect.poll(() => promptBox.evaluate((element) => document.activeElement === element)).toBe(true);
        await focusCanvasSurface(page, surface);

        await page.keyboard.press("Control+z");
        await expect(page.locator(`[data-node-id="${secondId}"]`)).toHaveCount(0);
        await expect(page.locator(`[data-node-id="${firstId}"]`)).toHaveCount(1);

        await page.keyboard.press("Control+z");
        await expect(page.locator("[data-node-id]")).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("F6 图片导入立即出现上传占位节点并原位填充", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("F6 upload placeholder"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;
    const fixture = uploadFixture();
    let releaseUpload: (() => Promise<void>) | null = null;

    // 上传请求先挂起：占位节点稳定停在“上传中”，不依赖真实慢网络，也不会真的落盘。
    await page.route("**/api/reference-assets", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        releaseUpload = () =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ token: "permanent/e2e-f6.webp", key: "permanent/e2e-f6.webp", url: "/api/reference-assets/permanent/e2e-f6.webp", bytes: fixture.length, mimeType: "image/webp" }),
            });
    });
    // 上传成功后应用会读取这个站内媒体地址量尺寸：直接返回同一份 WebP。
    await page.route("**/api/reference-assets/permanent/e2e-f6.webp*", async (route) => {
        await route.fulfill({ status: 200, contentType: "image/webp", body: fixture });
    });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");
        await expect(nodes).toHaveCount(0);

        await page.locator('input[type="file"][accept^="image/*,video/*"]').setInputFiles({ name: "canvas-f6-upload.webp", mimeType: "image/webp", buffer: fixture });

        // 上传还没返回时：立刻就有 1 个占位节点，显示文件名 + 上传中 + 取消按钮，且不是“生成中”。
        const placeholder = page.locator('[data-node-id^="image-"]');
        await expect(placeholder).toHaveCount(1);
        await expect(placeholder).toContainText("canvas-f6-upload.webp");
        await expect(placeholder).toContainText("上传中");
        await expect(placeholder.getByRole("button", { name: "取消" })).toBeVisible();
        await expect(page.getByText("生成中")).toHaveCount(0);
        expect(releaseUpload, "上传请求没有被挂起").not.toBeNull();

        // 放行上传：原位填充同一个节点，不新增第二个节点。
        await releaseUpload!();
        await expect(placeholder).toHaveCount(1);
        await expect(nodes).toHaveCount(1);
        await expect(placeholder).not.toContainText("上传中");
        await expect(placeholder.locator("img").first()).toHaveAttribute("src", /\/api\/reference-assets\/permanent\/e2e-f6\.webp/);
        await expect(placeholder).toBeVisible();
        await expectCanvasSaved(page);
        await expect.poll(() => readCanvasNodeCount(request, projectPath)).toBe(1);
        await expect.poll(() => page.locator("[data-node-id]").count()).toBe(1);
        await expect(surface).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

function node(id: string, type: string, x: number, y: number, width: number, height: number, metadata: Record<string, unknown>): CanvasNodeSeed {
    return { id, type, title: id, position: { x, y }, width, height, metadata };
}
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
        // 已观测到的偶发：Playwright 的 APIRequestContext 复用连接时，服务端 5s keep-alive 关闭的空闲连接会让
        // 带 body 的 DELETE 抛 "read ECONNRESET"（undici 不自动重试带 body 的请求）。只对网络层错误原样重发一次，
        // 第二次仍失败就抛出；断言失败不在这里掩盖。
        if (!isConnectionReset(error)) throw error;
        const response = await request.delete("/api/canvas/projects", { data: { ids: [id] } });
        expect(response.ok(), await response.text()).toBe(true);
    }
}

function isConnectionReset(error: unknown) {
    return error instanceof Error && /ECONNRESET|ECONNREFUSED|socket hang up/i.test(error.message);
}

async function readCanvasNodeCount(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: { project: { nodes: unknown[] } } }).data.project.nodes.length;
}

async function readCanvasNodeMetadata(request: APIRequestContext, path: string, nodeId: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    const nodes = ((await response.json()) as { data: { project: { nodes: Array<{ id: string; metadata?: Record<string, unknown> }> } } }).data.project.nodes;
    return nodes.find((item) => item.id === nodeId)?.metadata;
}

async function openCanvas(page: Page, projectId: string) {
    await page.goto(`/canvas/${projectId}`, { waitUntil: "domcontentloaded" });
    const surface = page.locator("[data-canvas-surface]");
    await expect(surface).toBeVisible({ timeout: 20_000 });
    return surface;
}

async function reloadCanvas(page: Page) {
    await page.reload({ waitUntil: "domcontentloaded" });
    const surface = page.locator("[data-canvas-surface]");
    await expect(surface).toBeVisible({ timeout: 20_000 });
    return surface;
}

async function clickCanvasNode(node: Locator, position = { x: 36, y: 36 }) {
    await expect(node).toBeVisible();
    await node.click({ position });
}

// 右上角固定空白点：避开节点、底部工具栏与左下角缩放控件。
async function clickCanvasBlank(page: Page, surface: Locator) {
    const box = await requireBoundingBox(surface);
    await page.mouse.click(box.x + box.width - 80, box.y + 120);
}

async function focusCanvasSurface(page: Page, surface: Locator) {
    await surface.focus();
    await expect.poll(() => page.evaluate(() => document.activeElement === document.querySelector("[data-canvas-surface]"))).toBe(true);
}

// 选中节点后必须把焦点放回画布：焦点在提示词 textarea 里时 Ctrl+C/Ctrl+V 会被当成编辑框操作。
async function selectCanvasNode(page: Page, surface: Locator, node: Locator) {
    await clickCanvasNode(node);
    await expect(page.getByRole("textbox", { name: "节点提示词" })).toBeVisible();
    await focusCanvasSurface(page, surface);
}

async function expectCanvasSaved(page: Page, timeout = 10_000) {
    await expect(page.locator(".canvas-topbar")).toHaveAttribute("data-save-status", "saved", { timeout });
}

async function canvasNodeIds(page: Page) {
    return page.locator("[data-node-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-node-id") || ""));
}

async function expectNewCanvasNode(page: Page, before: string[]) {
    let createdId = "";
    await expect
        .poll(async () => {
            const after = await canvasNodeIds(page);
            createdId = after.find((id) => !before.includes(id)) || "";
            return createdId;
        })
        .not.toBe("");
    return createdId;
}

async function requireBoundingBox(locator: Locator) {
    const box = await locator.boundingBox();
    expect(box, "元素没有可见的 boundingBox").not.toBeNull();
    return box!;
}

// 只做浏览器层能做的事：合成 KeyboardEvent 携带 isComposing，返回该事件是否被应用 preventDefault。
// 真实输入法组合态无法在自动化环境里驱动，所以这里不声称验证了真实 IME。
async function dispatchSyntheticEnter(target: Locator, isComposing: boolean) {
    return target.evaluate((element, composing) => {
        const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: composing, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
    }, isComposing);
}
