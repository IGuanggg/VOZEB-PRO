import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { CanvasNodePromptPanel, nodeStoredDraft } from "./canvas-node-prompt-panel";

const noop = () => undefined;

function imageNode(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "image-1", type: CanvasNodeType.Image, title: "已有图片", position: { x: 0, y: 0 }, width: 320, height: 320, metadata };
}

function textNode(metadata: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: "text-1", type: CanvasNodeType.Text, title: "已有文本", position: { x: 0, y: 0 }, width: 320, height: 200, metadata };
}

function renderPanel(node: CanvasNodeData) {
    return renderToStaticMarkup(<CanvasNodePromptPanel node={node} isRunning={false} onPromptChange={noop} onConfigChange={noop} onGenerate={noop} onStop={noop} />);
}

describe("节点提示词草稿解析", () => {
    it("已有图片内容且从未编辑草稿时保持空白，不回落成上一轮生成提示词", () => {
        expect(nodeStoredDraft(imageNode({ content: "/api/reference-assets/permanent/image-1.png", prompt: "把这张图改成夜景" }))).toBe("");
    });

    it("已有内容时优先恢复未提交草稿", () => {
        expect(nodeStoredDraft(imageNode({ content: "/api/reference-assets/permanent/image-1.png", prompt: "上一轮生成提示词", promptDraft: "把这张图改成清晨薄雾" }))).toBe("把这张图改成清晨薄雾");
    });

    it("用户主动清空的草稿不会被旧提示词顶回来", () => {
        expect(nodeStoredDraft(imageNode({ content: "/api/reference-assets/permanent/image-1.png", prompt: "上一轮生成提示词", promptDraft: "" }))).toBe("");
    });

    it("文本节点按正文内容判定，草稿同样优先", () => {
        expect(nodeStoredDraft(textNode({ content: "原有正文段落", prompt: "上一轮生成提示词" }))).toBe("");
        expect(nodeStoredDraft(textNode({ content: "原有正文段落", prompt: "上一轮生成提示词", promptDraft: "改写成更口语的表达" }))).toBe("改写成更口语的表达");
    });

    it("还没有内容的新节点沿用生成提示词作为草稿", () => {
        expect(nodeStoredDraft(textNode({ prompt: "写一段产品文案" }))).toBe("写一段产品文案");
        expect(nodeStoredDraft(textNode({ promptDraft: "" }))).toBe("");
    });
});

describe("节点提示词面板恢复", () => {
    it("面板重新挂载时把已保存草稿恢复到输入框", () => {
        const html = renderPanel(imageNode({ content: "/api/reference-assets/permanent/image-1.png", promptDraft: "把这张图改成黄昏光" }));
        expect(html).toContain("把这张图改成黄昏光");
    });

    it("已有内容且没有草稿时输入框为空，不复现旧缺陷", () => {
        const html = renderPanel(imageNode({ content: "/api/reference-assets/permanent/image-1.png", prompt: "上一轮生成提示词" }));
        expect(html).not.toContain("上一轮生成提示词");
    });

    it("两个节点的草稿互不串联", () => {
        expect(nodeStoredDraft(imageNode({ content: "/api/reference-assets/permanent/a.png", promptDraft: "节点 A 的草稿" }))).toBe("节点 A 的草稿");
        expect(nodeStoredDraft(textNode({ content: "节点 B 正文", promptDraft: "节点 B 的草稿" }))).toBe("节点 B 的草稿");
    });
});
