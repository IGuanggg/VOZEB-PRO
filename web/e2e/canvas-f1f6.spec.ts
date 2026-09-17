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

// 站内静态资源，不依赖外网。logo.svg 没有 width/height 属性，浏览器把它的内在尺寸解析成 150x150；
// 这里声明 240x180 只是为了让整例水合时不必探测尺寸。凡是要断言历史步数的用例请改用
// STABLE_IMAGE_METADATA：声明值与浏览器上报值不一致会让图片加载后回填 metadata，多出一步历史。
const IMAGE_METADATA = { content: "/logo.svg", naturalWidth: 240, naturalHeight: 180 };

// 需要几何与元数据都完全静止的用例（撤销/重做步数断言）：logo.svg 没有 width/height 属性，
// 浏览器把它的内在尺寸解析成 150x150，这里必须声明同一个值。声明成别的尺寸会让图片加载后的
// 真实尺寸回填写入 metadata，凭空多出一步与用户操作无关的历史；节点也用方形，避免比例自适应。
const STABLE_IMAGE_METADATA = { content: "/logo.svg", naturalWidth: 150, naturalHeight: 150 };

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

test("R1 新建文字节点输入正文后直接点工具栏新建两张图片，各自一步撤销且正文保留", async ({ page, request }) => {
    // R1 回归：新建文字节点会把页面级 editingNodeId 设成该节点。正文失焦若只改组件内的
    // isEditingContent、不同步清理页面状态，历史规划器就一直 hold，把“正文输入 + 两张新增图片”
    // 并成同一步撤销（一次撤销三个节点一起退回）。
    //
    // 关键：这里绝不点击画布空白。点空白会走 onPaneClick -> deselectCanvas，而 deselectCanvas
    // 本来就带 setEditingNodeId(null)，会顺手把状态清干净、反而掩盖缺陷（这正是第一版测试
    // 在未修复代码上也能通过的原因）。真实用户路径是编辑完直接点工具栏新建。
    const project = await createCanvasProject(request, {
        title: projectTitle("R1 text edit boundary"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");

        // 新建文字节点（自动聚焦）并键入正文。
        await page.getByRole("button", ADD_TEXT_BUTTON).click();
        const textId = await expectNewCanvasNode(page, []);
        const textarea = page.locator(`[data-node-id="${textId}"] ${TEXT_NODE_CONTENT}`);
        await expect.poll(() => textarea.evaluate((element) => document.activeElement === element)).toBe(true);
        const body = "用户刚输入的正文";
        await page.keyboard.type(body);
        await expect(textarea).toHaveValue(body);

        // 焦点仍在正文里，直接点两次工具栏新建图片：不经过 deselectCanvas。
        await page.getByRole("button", { name: "图片", exact: true }).click();
        const firstImage = await expectNewCanvasNode(page, [textId]);
        await page.getByRole("button", { name: "图片", exact: true }).click();
        const secondImage = await expectNewCanvasNode(page, [textId, firstImage]);
        await expect(nodes).toHaveCount(3);

        // 把焦点移出可编辑元素，让 Ctrl+Z 走画布历史而不是浏览器原生文本撤销。
        await focusCanvasSurface(page, surface);

        // 第一次撤销：只去掉第二张图片，第一张图片与文字节点都还在。
        await page.keyboard.press("Control+z");
        await expect(page.locator(`[data-node-id="${secondImage}"]`)).toHaveCount(0);
        await expect(page.locator(`[data-node-id="${firstImage}"]`)).toHaveCount(1);
        await expect(page.locator(`[data-node-id="${textId}"]`)).toHaveCount(1);

        // 第二次撤销：只去掉第一张图片，正文不能被一起撤回。
        await page.keyboard.press("Control+z");
        await expect(page.locator(`[data-node-id="${firstImage}"]`)).toHaveCount(0);
        await expect(page.locator(`[data-node-id="${textId}"]`)).toHaveCount(1);
        await expect(textarea).toHaveValue(body);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R1 点击已有文字正文编辑后直接新建图片，撤销只退回图片", async ({ page, request }) => {
    // R1 的另一条路径：点击已有正文进入编辑同样要建立页面级编辑会话，之后直接新建图片
    // 也必须各自一步撤销（同样不点空白，避免 deselectCanvas 掩盖缺陷）。
    const content = "已有文字节点的正文内容";
    const project = await createCanvasProject(request, {
        title: projectTitle("R1 click existing text"),
        viewport: { x: 80, y: 80, k: 1 },
        nodes: [node("text-edit-existing", "text", 80, 140, 320, 200, { content })],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        const textarea = page.locator(`[data-node-id="text-edit-existing"] ${TEXT_NODE_CONTENT}`);
        await expect(textarea).toHaveValue(content);

        // 点击正文把光标放进句中并插入一个字符。
        await textarea.click({ position: { x: 60, y: 12 } });
        await page.keyboard.type("改");
        const edited = await textarea.inputValue();
        expect(edited).toContain("改");
        expect(edited).not.toBe(content);

        // 直接在正文仍处于编辑态时新建一张图片。
        await page.getByRole("button", { name: "图片", exact: true }).click();
        const imageId = await expectNewCanvasNode(page, ["text-edit-existing"]);

        // 焦点在工具栏按钮上时 Ctrl+Z 会被当编辑框操作忽略，先回到画布表面。
        await focusCanvasSurface(page, surface);

        // 撤销：只应退回这张图片，正文修改必须保留。
        await page.keyboard.press("Control+z");
        await expect(page.locator(`[data-node-id="${imageId}"]`)).toHaveCount(0);
        await expect(page.locator('[data-node-id="text-edit-existing"]')).toHaveCount(1);
        await expect(textarea).toHaveValue(edited);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R5a 撤销草稿后，面板保持打开也要显示并提交撤销后的文本", async ({ page, request }) => {
    // R5 回归：面板把草稿同时存在本地 state 与节点 metadata，同步 effect 原先只依赖 node.id。
    // 撤销恢复的是同一个节点的 promptDraft（id 不变），面板不会同步，输入框与提交值仍是撤销前的文本。
    // 这里不关闭面板、不切换节点，验证同 ID 的历史恢复能刷新普通输入框。
    const project = await createCanvasProject(request, {
        title: projectTitle("R5 draft undo sync"),
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [node("draft-sync-a", "image", 60, 120, 240, 240, { ...STABLE_IMAGE_METADATA, promptDraft: "草稿A" })],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;
    const draftB = "草稿B：把背景换成夜色";

    try {
        const surface = await openCanvas(page, project.id);
        const nodeA = page.locator('[data-node-id="draft-sync-a"]');
        const promptBox = page.getByRole("textbox", { name: "节点提示词" });

        // 打开面板：显示已保存的草稿 A。
        await clickCanvasNode(nodeA);
        await expect(promptBox).toBeVisible();
        await expect(promptBox).toHaveValue("草稿A");

        // 在同一面板里改成 B 并等待服务端保存。
        await promptBox.fill(draftB);
        await expectCanvasSaved(page);
        await expect.poll(async () => readCanvasNodeMetadata(request, projectPath, "draft-sync-a")).toMatchObject({ promptDraft: draftB });

        // 面板保持打开，焦点移回画布后撤销。改了草稿就只应该产生一步历史，
        // 因此一次撤销必须直接回到草稿 A。
        await focusCanvasSurface(page, surface);
        await page.locator('[aria-label="撤销"]').click();
        await expect.poll(async () => ((await readCanvasNodeMetadata(request, projectPath, "draft-sync-a")) as { promptDraft?: string } | null)?.promptDraft ?? "", { timeout: 4_000, intervals: [300] }).toBe("草稿A");

        // 回到 A 后，面板显示的必须是 A；重做应回到 B 且显示同步。
        await expect(promptBox).toHaveValue("草稿A");
        await page.locator('[aria-label="重做"]').click();
        await expect(promptBox).toHaveValue(draftB);
        await expect.poll(async () => readCanvasNodeMetadata(request, projectPath, "draft-sync-a")).toMatchObject({ promptDraft: draftB });
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R5b 撤销草稿后放大编辑器也显示撤销后的文本", async ({ page, request }) => {
    // R5 的另一半验收：普通输入与放大输入必须一致，历史恢复要同时刷新两处。
    const project = await createCanvasProject(request, {
        title: projectTitle("R5 expanded editor sync"),
        viewport: { x: 100, y: 110, k: 1 },
        nodes: [node("draft-expanded-a", "image", 60, 120, 240, 240, { ...STABLE_IMAGE_METADATA, promptDraft: "放大前草稿A" })],
        connections: [],
    });
    const draftB = "放大前草稿B";

    try {
        const surface = await openCanvas(page, project.id);
        const nodeA = page.locator('[data-node-id="draft-expanded-a"]');
        const promptBox = page.getByRole("textbox", { name: "节点提示词" });

        await clickCanvasNode(nodeA);
        await expect(promptBox).toHaveValue("放大前草稿A");
        await promptBox.fill(draftB);
        await expectCanvasSaved(page);

        // 面板保持打开，撤销到 A。
        await focusCanvasSurface(page, surface);
        await page.keyboard.press("Control+z");
        await expect(promptBox).toHaveValue("放大前草稿A");

        // 现在打开放大编辑器：它必须拿到撤销后的值，而不是撤销前的 B。
        await page.getByRole("button", { name: "放大提示词输入" }).click();
        const dialog = page.getByRole("dialog", { name: "编辑提示词" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("textbox", { name: "提示词编辑器" })).toHaveValue("放大前草稿A");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R2 一次导入的多文件回填只占一步撤销，重做恢复永久媒体", async ({ page, request }) => {
    // R2 回归：占位创建只合在一次渲染里（一个导入 = 一步历史），但每个文件成功后的回填原先仍是
    // 普通 nodes 内容变更，会各自走进 180ms 合并窗口、把它前面的“上传中”快照压进历史；
    // 上传任务的原始 File 随后被释放，撤销就会退回没有任务的幽灵占位。
    const project = await createCanvasProject(request, {
        title: projectTitle("R2 upload settle"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });
    const fixture = uploadFixture();
    const files = ["canvas-r2a-one.webp", "canvas-r2a-two.webp"];
    const { release } = await holdCanvasUploads(page, fixture, files);
    let posts = 0;
    page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/api/reference-assets")) posts += 1;
    });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");
        const uploading = nodes.filter({ hasText: "上传中" });
        await expect(nodes).toHaveCount(0);

        await dropCanvasFiles(surface, fixture, files);
        await expect(uploading).toHaveCount(2);

        // A 先返回：节点原位填充成永久媒体。
        await release(files[0]!);
        await expect(uploading).toHaveCount(1);
        // 间隔超过 180ms 合并窗口后再让 B 返回，前后两次回填都必须是导入那一步的内部变化。
        await page.waitForTimeout(260);
        await release(files[1]!);
        await expect(uploading).toHaveCount(0);
        await expect.poll(() => page.locator('[data-node-id] img[src*="/api/reference-assets/permanent/canvas-r2a-"]').count()).toBe(2);
        expect(posts).toBe(2);

        // 一次撤销完整撤回这次导入：两个文件一起消失，而不是先退回一个“上传中”。
        await focusCanvasSurface(page, surface);
        await page.keyboard.press("Control+z");
        await expect(nodes).toHaveCount(0);

        // 重做恢复的是已完成的永久媒体，不会重新发起上传。
        await page.keyboard.press("Control+Shift+z");
        await expect(nodes).toHaveCount(2);
        await expect(uploading).toHaveCount(0);
        expect(posts).toBe(2);
        await expect.poll(() => page.locator('[data-node-id] img[src*="/api/reference-assets/permanent/canvas-r2a-"]').count()).toBe(2);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R2 逆序回填与上传期间的独立文字编辑各自成步", async ({ page, request }) => {
    // R2 的第二半验收：B→A 的返回顺序、上传期间穿插的独立文字编辑，都不能改变撤销顺序，
    // 也不能让文字编辑被回填吞并。
    const content = "上传期间的正文";
    const project = await createCanvasProject(request, {
        title: projectTitle("R2 interleaved edit"),
        viewport: { x: 60, y: 60, k: 1 },
        nodes: [node("r2-text", "text", 60, 140, 320, 200, { content })],
        connections: [],
    });
    const fixture = uploadFixture();
    const files = ["canvas-r2b-one.webp", "canvas-r2b-two.webp"];
    const { release } = await holdCanvasUploads(page, fixture, files);

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");
        const textarea = page.locator(`[data-node-id="r2-text"] ${TEXT_NODE_CONTENT}`);
        const uploading = nodes.filter({ hasText: "上传中" });

        await dropCanvasFiles(surface, fixture, files);
        await expect(uploading).toHaveCount(2);

        // 上传仍在进行时编辑正文：这是一次独立用户操作，必须自己成步。
        await textarea.click();
        await page.keyboard.type("改");
        const edited = await textarea.inputValue();
        expect(edited).toContain("改");
        await focusCanvasSurface(page, surface);

        // 第二个文件先返回、第一个后返回（逆序 + 超过合并窗口）。
        await release(files[1]!);
        await expect(uploading).toHaveCount(1);
        await page.waitForTimeout(260);
        await release(files[0]!);
        await expect(uploading).toHaveCount(0);

        // 时间线：导入 -> 文字编辑。第一次撤销只退回正文，导入的永久媒体保留。
        await page.keyboard.press("Control+z");
        await expect(textarea).toHaveValue(content);
        await expect.poll(() => page.locator('[data-node-id] img[src*="/api/reference-assets/permanent/canvas-r2b-"]').count()).toBe(2);
        await expect(uploading).toHaveCount(0);

        // 第二次撤销才完整撤回导入。
        await page.keyboard.press("Control+z");
        await expect(page.locator('[data-node-id="r2-text"]')).toHaveCount(1);
        await expect(page.locator("[data-node-id] img")).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R2 相邻返回的两个文件同样只占一步撤销", async ({ page, request }) => {
    // R2 的相邻返回：两个文件几乎同时回填（同一个合并窗口内），仍然只能产生一步历史。
    const project = await createCanvasProject(request, {
        title: projectTitle("R2 adjacent settle"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });
    const fixture = uploadFixture();
    const files = ["canvas-r2c-one.webp", "canvas-r2c-two.webp"];
    const { release } = await holdCanvasUploads(page, fixture, files);

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");
        const uploading = nodes.filter({ hasText: "上传中" });

        await dropCanvasFiles(surface, fixture, files);
        await expect(uploading).toHaveCount(2);

        // 不放隔断：两个响应紧挨着回来。
        await release(files[0]!);
        await release(files[1]!);
        await expect(uploading).toHaveCount(0);
        await expect.poll(() => page.locator('[data-node-id] img[src*="/api/reference-assets/permanent/canvas-r2c-"]').count()).toBe(2);

        await focusCanvasSurface(page, surface);
        await page.keyboard.press("Control+z");
        await expect(nodes).toHaveCount(0);

        await page.keyboard.press("Control+Shift+z");
        await expect(nodes).toHaveCount(2);
        await expect(uploading).toHaveCount(0);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("N1 正文中间连续输入时光标停在原位，不因重渲染跳回末尾", async ({ page, request }) => {
    // N1 回归：自动聚焦 effect 依赖每次渲染新建的回调（页面内联 onTextEditStart）与同一个非零
    // editRequestNonce。正文更新页面 nodes 后 effect 重跑，焦点被重新放回末尾，光标从中间跳到最后。
    const project = await createCanvasProject(request, {
        title: projectTitle("N1 caret stability"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        await page.getByRole("button", ADD_TEXT_BUTTON).click();
        const textId = await expectNewCanvasNode(page, []);
        const textarea = page.locator(`[data-node-id="${textId}"] ${TEXT_NODE_CONTENT}`);
        await expect.poll(() => textarea.evaluate((element) => document.activeElement === element)).toBe(true);

        await page.keyboard.type("abcd");
        await expect(textarea).toHaveValue("abcd");
        // 光标移到中间：Home 之后两次右移，然后连续输入两个字符。
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type("X");
        await expect(textarea).toHaveValue("abXcd");
        expect(await caretPosition(textarea)).toBe(3);

        await page.keyboard.type("Y");
        await expect(textarea).toHaveValue("abXYcd");
        expect(await caretPosition(textarea)).toBe(4);
        await expect(surface).toBeVisible();
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("N1 已有非零聚焦请求时点击另一段正文编辑不会跳到末尾", async ({ page, request }) => {
    const content = "已有正文内容足够长，用来确认点击中间进入编辑时光标不会自己跳到末尾。";
    const project = await createCanvasProject(request, {
        title: projectTitle("N1 existing text caret"),
        viewport: { x: 40, y: 80, k: 1 },
        nodes: [node("n1-text", "text", 40, 120, 380, 220, { content })],
        connections: [],
    });

    try {
        const surface = await openCanvas(page, project.id);
        const textarea = page.locator(`[data-node-id="n1-text"] ${TEXT_NODE_CONTENT}`);
        // 先新建一个文字节点，让页面上存在一次非零的聚焦请求。
        await page.getByRole("button", ADD_TEXT_BUTTON).click();
        await expectNewCanvasNode(page, ["n1-text"]);
        await focusCanvasSurface(page, surface);

        // 点击已有正文中间：光标应停在点击位置，不能复用上一个节点的聚焦命令。
        await textarea.click({ position: { x: 60, y: 12 } });
        const clicked = await caretPosition(textarea);
        expect(clicked).toBeLessThan(content.length);
        await page.keyboard.type("改");
        const edited = await textarea.inputValue();
        expect(edited).not.toBe(content);
        expect(edited.endsWith("改")).toBe(false);
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R3 取消后恢复的节点不被迟到的旧上传结果改写", async ({ page, request }) => {
    // R3 回归：图片上传的 HTTP 请求成功之后还要等待不接收 AbortSignal 的尺寸读取。
    // 这里先放行 POST、挂起尺寸读取，再取消上传并撤销恢复同 ID 占位：迟到的旧尝试不得写回。
    const project = await createCanvasProject(request, {
        title: projectTitle("R3 late attempt"),
        viewport: { x: 0, y: 0, k: 1 },
        nodes: [],
        connections: [],
    });
    const fixture = uploadFixture();
    const files = ["canvas-r3-one.webp"];
    const { release, awaitMedia, releaseMedia } = await holdCanvasUploads(page, fixture, files, { holdMedia: true });

    try {
        const surface = await openCanvas(page, project.id);
        const nodes = page.locator("[data-node-id]");

        await dropCanvasFiles(surface, fixture, files);
        const placeholder = page.locator('[data-node-id^="image-"]');
        await expect(placeholder).toHaveCount(1);

        // 服务器已保存，尺寸读取还在途：等它真的挂起后再取消。
        await release(files[0]!);
        await awaitMedia(files[0]!);

        // 取消上传：节点移除、任务中止；随后撤销把同 ID 占位恢复出来（没有内存任务 → 可重试错误态）。
        await placeholder.getByRole("button", { name: "取消" }).click();
        await expect(nodes).toHaveCount(0);
        await focusCanvasSurface(page, surface);
        await page.keyboard.press("Control+z");
        const restored = page.locator('[data-node-id^="image-"]');
        await expect(restored).toHaveCount(1);
        await expect(restored).toContainText("重新选择文件");

        // 释放迟到的尺寸读取：旧尝试的成功回调不得把恢复出来的节点改回 success。
        await releaseMedia(files[0]!);
        await page.waitForTimeout(600);
        await expect(restored.locator("img")).toHaveCount(0);
        await expect(restored).toContainText("重新选择文件");
        await expect(restored).not.toContainText("上传中");
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

test("R6 取消上传同时移除该节点的连线，撤销重做保持图一致", async ({ page, request }) => {
    const project = await createCanvasProject(request, {
        title: projectTitle("R6 cancel graph"),
        viewport: { x: 40, y: 80, k: 1 },
        nodes: [node("r6-text", "text", 40, 400, 320, 200, { content: "连线目标" })],
        connections: [],
    });
    const projectPath = `/api/canvas/projects/${project.id}`;
    const fixture = uploadFixture();
    const files = ["canvas-r6-one.webp"];
    const { release } = await holdCanvasUploads(page, fixture, files);

    try {
        const surface = await openCanvas(page, project.id);
        const placeholder = page.locator('[data-node-id^="image-"]');
        const edges = page.locator("[data-connection-id]");

        await dropCanvasFiles(surface, fixture, files);
        await expect(placeholder).toHaveCount(1);

        // 上传中的占位节点连到文字节点。
        await dragConnectionToNode(page, placeholder, page.locator('[data-node-id="r6-text"]'));
        await expect(edges).toHaveCount(1);
        await expectCanvasSaved(page);

        // 取消上传：节点与关联连线在同一个逻辑操作里移除，不留悬空边。
        await placeholder.getByRole("button", { name: "取消" }).click();
        await expect(placeholder).toHaveCount(0);
        await expect(edges).toHaveCount(0);
        await expectCanvasSaved(page);
        await expect.poll(async () => (await readCanvasProjectGraph(request, projectPath)).connections).toBe(0);

        // 撤销：占位节点和连线一起回来（两端都存在，不是悬空边）。
        await focusCanvasSurface(page, surface);
        await page.keyboard.press("Control+z");
        await expect(placeholder).toHaveCount(1);
        await expect(edges).toHaveCount(1);

        // 重做：再次取消的结果也一样干净。
        await page.keyboard.press("Control+Shift+z");
        await expect(placeholder).toHaveCount(0);
        await expect(edges).toHaveCount(0);
        await expect.poll(async () => (await readCanvasProjectGraph(request, projectPath)).connections).toBe(0);

        await release(files[0]!); // 放行挂起的请求，避免测试结束时仍有在途 fetch
    } finally {
        await deleteCanvasProject(request, project.id);
    }
});

// R4 待确认项（浏览器已复现，竞态未定位）：正文 textarea 的 onPointerDown 与 onMouseDown 都调用同一个
// 带 Ctrl/Shift/Meta toggle 的 onActivateNode。实测同一个手势的净效果不稳定：
//   run 1：Ctrl 点击未选中节点 → 2 个选中；再 Ctrl 点击同一节点 → 仍是 2（等于没切换，or 加了又删）；
//   run 2：Shift 点击已选中节点 → 1（等于只切换一次）。
// 两次都失败，且失败步骤不同 —— 说明这是“两个事件入口在同一手势里各切换一次”的竞态，
// 而不是稳定的双向行为。修复方向：只让一个事件入口改变选择，另一个只隔离冒泡（按 Pointer Events 特性判定回退）。
// 在没有定位到稳定机制前不提交推测性改动，因此用 fixme 固定复现步骤与实测值。
test.fixme("R4 正文区域修饰键点击只切换一次选择（当前竞态：偶发切换两次，待定位）", async ({ page, request }) => {
    const contentA = "第一段正文内容足够长，用来确认点击中间不会把光标抛到末尾。";
    const project = await createCanvasProject(request, {
        title: projectTitle("R4 modifier toggle"),
        viewport: { x: 40, y: 80, k: 1 },
        nodes: [node("r4-text-a", "text", 40, 120, 380, 220, { content: contentA }), node("r4-text-b", "text", 40, 420, 380, 220, { content: "第二段正文" })],
        connections: [],
    });

    try {
        await openCanvas(page, project.id);
        const areaA = page.locator(`[data-node-id="r4-text-a"] ${TEXT_NODE_CONTENT}`);
        const areaB = page.locator(`[data-node-id="r4-text-b"] ${TEXT_NODE_CONTENT}`);
        const clickOptions = { position: { x: 40, y: 10 } } as const;

        // 单选：正文点击只选中本节点，光标留在点击处而不是被抛到末尾。
        await areaA.click(clickOptions);
        await expectSelectedNodeCount(page, 1);
        expect(await caretPosition(areaA)).toBeLessThan(contentA.length);

        // Ctrl 点击未选中节点：加入多选（只切换一次 → 2）。
        await areaB.click({ ...clickOptions, modifiers: ["Control"] });
        await expectSelectedNodeCount(page, 2);

        // Ctrl 点击已选中节点：取消选择（只切换一次 → 1）。实测这里会停在 2。
        await areaB.click({ ...clickOptions, modifiers: ["Control"] });
        await expectSelectedNodeCount(page, 1);

        // Shift / Meta 同义，各自只切换一次。
        await areaB.click({ ...clickOptions, modifiers: ["Shift"] });
        await expectSelectedNodeCount(page, 2);
        await areaB.click({ ...clickOptions, modifiers: ["Meta"] });
        await expectSelectedNodeCount(page, 1);

        // 修饰键点击正文后仍能正常输入，且光标不跳末尾。
        await areaA.click(clickOptions);
        expect(await caretPosition(areaA)).toBeLessThan(contentA.length);
        await page.keyboard.type("改");
        const edited = await areaA.inputValue();
        expect(edited).not.toBe(contentA);
        expect(edited.endsWith("改")).toBe(false);
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

// 多文件导入在真实 UI 里只有拖放一条路径（隐藏 input 只取 files[0]）：合成一次带 DataTransfer 的 drop，
// 占位创建因此和真实拖放一样落在同一个渲染里。
async function dropCanvasFiles(surface: Locator, fixture: Buffer, names: string[]) {
    const box = await requireBoundingBox(surface);
    await surface.evaluate(
        (element, payload) => {
            const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
            const dataTransfer = new DataTransfer();
            payload.names.forEach((name) => dataTransfer.items.add(new File([bytes], name, { type: "image/webp" })));
            element.dispatchEvent(new DragEvent("drop", { dataTransfer, clientX: payload.clientX, clientY: payload.clientY, bubbles: true, cancelable: true }));
        },
        { base64: fixture.toString("base64"), names, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 },
    );
}

// 挂起站内媒体上传：按上传请求里的 originalName 分别放行，用来覆盖 A→B / B→A 的返回顺序，不依赖真实慢网络。
// holdMedia 用于复现“服务器已保存、尺寸读取还没回来”的窗口：那时 abort 已经无法中断异步链。
async function holdCanvasUploads(page: Page, fixture: Buffer, names: string[], options: { holdMedia?: boolean } = {}) {
    const releases = new Map<string, () => Promise<void>>();
    const mediaReleases = new Map<string, () => Promise<void>>();
    const tokenFor = (name: string) => `permanent/${name.replace(/\.webp$/, "")}.webp`;
    await page.route("**/api/reference-assets", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataBuffer()?.toString("utf8") || "";
        const name = names.find((item) => body.includes(item));
        if (!name) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "e2e 只放行本用例声明的文件" }) });
        const token = tokenFor(name);
        releases.set(name, () => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token, key: token, url: `/api/reference-assets/${token}`, bytes: fixture.length, mimeType: "image/webp" }) }));
    });
    await page.route("**/api/reference-assets/permanent/*", async (route) => {
        if (!options.holdMedia) return route.fulfill({ status: 200, contentType: "image/webp", body: fixture });
        const token = new URL(route.request().url()).pathname.replace("/api/reference-assets/", "");
        mediaReleases.set(token, () => route.fulfill({ status: 200, contentType: "image/webp", body: fixture }));
    });
    const waitFor = async (map: Map<string, unknown>, key: string, message: string) => {
        await expect.poll(() => map.has(key), { message }).toBe(true);
    };
    return {
        // 没有收到对应请求时直接失败，不静默跳过。
        async release(name: string) {
            await waitFor(releases, name, `${name} 的上传请求没有被挂起`);
            await releases.get(name)!();
        },
        async awaitMedia(name: string) {
            await waitFor(mediaReleases, tokenFor(name), `${tokenFor(name)} 的尺寸读取没有被挂起`);
        },
        async releaseMedia(name: string) {
            await waitFor(mediaReleases, tokenFor(name), `${tokenFor(name)} 的尺寸读取没有被挂起`);
            await mediaReleases.get(tokenFor(name))!();
        },
    };
}

/** 读回服务端项目里的节点与连线数量：确认取消后没有悬空边落盘。 */
async function readCanvasProjectGraph(request: APIRequestContext, path: string) {
    const response = await request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    const project = ((await response.json()) as { data: { project: { nodes: unknown[]; connections: unknown[] } } }).data.project;
    return { nodes: project.nodes.length, connections: project.connections.length };
}

/** 正文输入框的插入光标位置。 */
async function caretPosition(textarea: Locator) {
    return textarea.evaluate((element) => (element as HTMLTextAreaElement).selectionStart);
}

/** 当前被选中的节点数量：选中态就是节点外框使用画布主题的选中蓝。 */
async function expectSelectedNodeCount(page: Page, count: number) {
    await expect.poll(() => page.locator("[data-node-id] > div").evaluateAll((elements) => elements.filter((element) => getComputedStyle(element).borderColor === "rgb(47, 128, 255)").length)).toBe(count);
}

// 从节点的输出连接点拖到目标节点中心：占位节点与普通节点共用同一套连接点。
async function dragConnectionToNode(page: Page, sourceNode: Locator, targetNode: Locator) {
    const targetBounds = await targetNode.boundingBox();
    expect(targetBounds, "目标节点没有可见的 boundingBox").not.toBeNull();
    await sourceNode.hover();
    const handle = sourceNode.locator('[data-canvas-handle="source"]');
    const bounds = await handle.boundingBox();
    expect(bounds, "源节点没有可见的输出连接点").not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBounds!.x + targetBounds!.width / 2, targetBounds!.y + targetBounds!.height / 2, { steps: 8 });
    await page.mouse.up();
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
