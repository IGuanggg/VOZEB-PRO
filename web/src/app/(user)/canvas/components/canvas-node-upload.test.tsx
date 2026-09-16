import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { NodeContent } from "./canvas-node-content";
import { beginCanvasUploadTask, clearCanvasUploadTasks } from "../[id]/canvas-page-utils";

const noop = () => undefined;

describe("画布上传占位渲染", () => {
    beforeEach(() => useThemeStore.setState({ theme: "light" }));
    afterEach(() => clearCanvasUploadTasks());

    it("上传中显示文件名、不定进度与取消入口，且不复用生成中占位", () => {
        const node = uploadNode("image-upload", "夏日海边.png", { status: "uploading" });
        beginCanvasUploadTask("project-a", node.id, "image", new File(["preview"], "夏日海边.png", { type: "image/png" }));

        const markup = renderContent(node);

        expect(markup).toContain("上传中");
        expect(markup).toContain("夏日海边.png");
        expect(markup).toContain("blob:");
        expect(markup).toContain("取消");
        expect(markup).toContain("animate-spin");
        expect(markup).not.toContain("生成中");
        // 上传层没有真实进度：不能出现百分比进度条、progressbar 语义或百分比读数。
        expect(markup).not.toMatch(/width:\s*\d+%|progressbar|aria-valuenow|<span[^>]*>\s*\d+%/);
    });

    it("上传失败时给出明确错误与重试入口", () => {
        const markup = renderContent(uploadNode("image-failed", "夏日海边.png", { status: "error", uploadFailed: true, errorDetails: "上传失败：网络中断" }));

        expect(markup).toContain("上传失败：网络中断");
        expect(markup).toContain("重试");
        expect(markup).not.toContain("生成中");
    });

    it("视频占位不用 blob 预览冒充图片缩略图", () => {
        const node = uploadNode("video-upload", "夏日海边.mp4", { status: "uploading" }, CanvasNodeType.Video);
        beginCanvasUploadTask("project-a", node.id, "video", new File(["preview"], "夏日海边.mp4", { type: "video/mp4" }));

        const markup = renderContent(node);

        expect(markup).toContain("上传中");
        expect(markup).toContain("夏日海边.mp4");
        expect(markup).not.toContain("<img");
    });
});

function renderContent(node: CanvasNodeData) {
    return renderToStaticMarkup(
        <NodeContent
            node={node}
            theme={canvasThemes.light}
            isEditingContent={false}
            textareaRef={{ current: null }}
            isBatchRoot={false}
            batchCount={0}
            batchExpanded={false}
            batchOpening={false}
            batchRecovering={false}
            onContentChange={noop}
            onStopEditing={noop}
            mentionReferences={[]}
        />,
    );
}

function uploadNode(id: string, title: string, metadata: CanvasNodeData["metadata"], type = CanvasNodeType.Image): CanvasNodeData {
    return { id, type, title, position: { x: 0, y: 0 }, width: 340, height: 240, metadata };
}
