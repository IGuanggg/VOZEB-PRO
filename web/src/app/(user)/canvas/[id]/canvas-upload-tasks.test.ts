import { beforeEach, describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CANVAS_DROP_NODE_OFFSET } from "./canvas-page-elements";
import {
    CANVAS_UPLOAD_RESTART_HINT,
    beginCanvasUploadTask,
    canvasUploadFillPatch,
    canvasUploadPlaceholderNode,
    canvasUploadPositions,
    canvasUploadPreviewUrl,
    clearCanvasUploadTasks,
    endCanvasUploadTask,
    hydrateCanvasImages,
    isCanvasUploadFile,
    readCanvasUploadTask,
    releaseCanvasUploadPreview,
    restoreCanvasUploadNodes,
    updateCanvasUploadNode,
} from "./canvas-page-utils";

const PROJECT = "project-a";

describe("画布上传占位节点", () => {
    beforeEach(() => clearCanvasUploadTasks());

    it("多文件落点与顺序在导入开始时一次确定，与网络返回顺序无关", () => {
        const center = { x: 400, y: 200 };
        const files = [file("b.png"), file("a.png"), file("c.png")];
        const positions = canvasUploadPositions(center, files.length);

        expect(positions).toEqual([
            { x: center.x, y: center.y },
            { x: center.x + CANVAS_DROP_NODE_OFFSET, y: center.y + CANVAS_DROP_NODE_OFFSET },
            { x: center.x + CANVAS_DROP_NODE_OFFSET * 2, y: center.y + CANVAS_DROP_NODE_OFFSET * 2 },
        ]);

        const placeholders = files.map((item, index) => canvasUploadPlaceholderNode("image", `image-${index}`, item, positions[index]));
        // 网络按 c、a、b 的顺序返回时也只原位填充原节点，节点顺序始终等于导入顺序。
        const filled = [2, 0, 1].reduce((nodes, index) => updateCanvasUploadNode(nodes, PROJECT, PROJECT, `image-${index}`, (node) => canvasUploadFillPatch(node, "image", image(256, 256))), placeholders);

        expect(filled.map((node) => node.id)).toEqual(["image-0", "image-1", "image-2"]);
        expect(filled.map((node) => node.title)).toEqual(["b.png", "a.png", "c.png"]);
        filled.forEach((node, index) => expect(centerOf(node)).toEqual(centerOf(placeholders[index])));
    });

    it("初始 metadata 只有专有上传状态，不含生成任务句柄与 blob:/data: 预览地址", () => {
        const imageNode = canvasUploadPlaceholderNode("image", "image-1", file("占位图.png"), { x: 0, y: 0 });
        const videoNode = canvasUploadPlaceholderNode("video", "video-1", file("占位视频.mp4"), { x: 0, y: 0 });
        const audioNode = canvasUploadPlaceholderNode("audio", "audio-1", file("占位音频.mp3"), { x: 0, y: 0 });

        expect(imageNode).toMatchObject({ id: "image-1", type: CanvasNodeType.Image, title: "占位图.png", metadata: { status: "uploading" } });
        expect(videoNode.type).toBe(CanvasNodeType.Video);
        expect(audioNode.type).toBe(CanvasNodeType.Audio);
        expect(JSON.stringify([imageNode, videoNode, audioNode])).not.toMatch(/blob:|data:|imageTask|videoTask|audioTask|textTask|agentTask/);
    });

    it("上传成功后按 id 原位填充同一个节点，不新增节点也不动其他节点", () => {
        const placeholder = canvasUploadPlaceholderNode("image", "image-1", file("照片.png"), { x: 300, y: 300 });
        const other = textNode();
        const next = updateCanvasUploadNode([other, placeholder], PROJECT, PROJECT, "image-1", (node) => canvasUploadFillPatch(node, "image", image(1600, 900)));
        const filled = next[1];

        expect(next).toHaveLength(2);
        expect(next[0]).toBe(other);
        expect(filled?.id).toBe("image-1");
        expect(filled?.metadata).toMatchObject({ status: "success", content: "/api/reference-assets/permanent/photo.webp", storageKey: "permanent/photo.webp", naturalWidth: 1600, naturalHeight: 900 });
        expect((filled?.width || 0) / (filled?.height || 1)).toBeCloseTo(16 / 9, 5);
        expect(centerOf(filled as CanvasNodeData)).toEqual(centerOf(placeholder));
    });

    it("迟到的完成回调在节点被删除、已切换项目或已被替换时一律不写回", () => {
        const placeholder = canvasUploadPlaceholderNode("image", "image-1", file("照片.png"), { x: 0, y: 0 });
        const patch = (node: CanvasNodeData) => canvasUploadFillPatch(node, "image", image(256, 256));

        // 节点已被删除（Delete / 清空 / 撤销）：返回原数组，不复活节点。
        expect(updateCanvasUploadNode([], PROJECT, PROJECT, "image-1", patch)).toEqual([]);
        // 已经切换到别的项目：即使节点 id 相同也不写。
        const nodes = [placeholder];
        expect(updateCanvasUploadNode(nodes, PROJECT, "project-b", "image-1", patch)).toBe(nodes);
        // 该节点已被另一次上传替换成真实媒体：旧回调不再覆盖。
        const replaced: CanvasNodeData[] = [{ ...placeholder, metadata: { status: "success", content: "/api/reference-assets/permanent/other.png" } }];
        expect(updateCanvasUploadNode(replaced, PROJECT, PROJECT, "image-1", patch)).toBe(replaced);
    });

    it("刷新恢复时带上传状态的节点不再假装上传中，改为提示重新选择文件", async () => {
        const restored = await hydrateCanvasImages([canvasUploadPlaceholderNode("image", "image-1", file("照片.png"), { x: 0, y: 0 })]);

        expect(restored[0]?.metadata).toMatchObject({ status: "error", uploadFailed: true, errorDetails: CANVAS_UPLOAD_RESTART_HINT });
        expect(restored[0]?.metadata?.content).toBeUndefined();
    });

    it("页面内存 Map 保留原始 File 供重试，成功或取消时释放 blob 预览", () => {
        const original = file("照片.png");
        const task = beginCanvasUploadTask(PROJECT, "image-1", "image", original);

        expect(canvasUploadPreviewUrl("image-1")).toMatch(/^blob:/);
        expect(readCanvasUploadTask("image-1")?.file).toBe(original);

        // 失败：只释放 blob 预览，原始 File 仍留在页面内存里供同一个节点重试。
        releaseCanvasUploadPreview(task);
        expect(canvasUploadPreviewUrl("image-1")).toBe("");
        expect(readCanvasUploadTask("image-1")?.file).toBe(original);

        endCanvasUploadTask("image-1");
        expect(readCanvasUploadTask("image-1")).toBeUndefined();
        expect(canvasUploadPreviewUrl("image-1")).toBe("");
    });

    it("恢复没有内存任务的上传占位时明确变成可重选文件，不影响还有任务的上传", () => {
        const interrupted = canvasUploadPlaceholderNode("image", "image-1", file("打断.png"), { x: 0, y: 0 });
        // 没有任何内存任务（刷新恢复、取消后撤销、重做回旧占位）：不能恢复成永远等不到结果的“上传中”。
        const restored = restoreCanvasUploadNodes([interrupted]);
        expect(restored[0]?.metadata).toMatchObject({ status: "error", uploadFailed: true, errorDetails: CANVAS_UPLOAD_RESTART_HINT });

        // 这次上传还在页面内存里：仍留在“上传中”，等它自己的回填，不能提前标成失败。
        const active = beginCanvasUploadTask(PROJECT, "image-2", "image", file("进行中.png"));
        const pending = canvasUploadPlaceholderNode("image", "image-2", file("进行中.png"), { x: 0, y: 0 });
        expect(restoreCanvasUploadNodes([pending])[0]?.metadata).toMatchObject({ status: "uploading" });
        endCanvasUploadTask(active.nodeId);

        // 已经不是占位的节点与无变化数组都原样返回，不制造额外引用变化。
        const settled = canvasUploadPlaceholderNode("image", "image-3", file("完成.png"), { x: 0, y: 0 });
        const done = { ...settled, metadata: { status: "success" as const, content: "/api/reference-assets/permanent/done.webp" } };
        const untouched = [done];
        expect(restoreCanvasUploadNodes(untouched)).toBe(untouched);
    });

    it("基本校验不通过的文件不占用画布", () => {
        expect(isCanvasUploadFile("image", file("a.png"))).toBe(true);
        expect(isCanvasUploadFile("image", new File([], "empty.png", { type: "image/png" }))).toBe(false);
        expect(isCanvasUploadFile("image", new File(["x"], "a.mp4", { type: "video/mp4" }))).toBe(false);
        expect(isCanvasUploadFile("video", new File(["x"], "a.mp4", { type: "video/mp4" }))).toBe(true);
        expect(isCanvasUploadFile("audio", new File(["x"], "a.mp3", { type: "audio/mpeg" }))).toBe(true);
        expect(isCanvasUploadFile("audio", new File(["x"], "voice.wav", { type: "" }))).toBe(true);
    });
});

function file(name: string) {
    return new File(["canvas-upload"], name, { type: name.endsWith(".mp3") ? "audio/mpeg" : name.endsWith(".mp4") ? "video/mp4" : "image/png" });
}

function image(width: number, height: number) {
    return { url: "/api/reference-assets/permanent/photo.webp", storageKey: "permanent/photo.webp", serverUrl: "/api/reference-assets/permanent/photo.webp", width, height, bytes: 2048, mimeType: "image/webp" };
}

function centerOf(node: CanvasNodeData) {
    return { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
}

function textNode(): CanvasNodeData {
    return { id: "text", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: "内容", status: "success" } };
}
