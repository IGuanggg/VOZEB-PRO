import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { CANVAS_NODE_CLIPBOARD_MIME, createCanvasNodeClipboard, createPastedCanvasNodes, readCanvasNodeClipboard, readCanvasNodeClipboardText, writeCanvasNodeClipboard } from "./canvas-node-clipboard";

function fakeClipboard(initial: Record<string, string> = {}, options: { keepCustomMime?: boolean } = {}) {
    const keepCustomMime = options.keepCustomMime !== false;
    const store = new Map(Object.entries(initial));
    return {
        store,
        setData: (type: string, value: string) => {
            store.set(type, value);
        },
        getData: (type: string) => (keepCustomMime || type !== CANVAS_NODE_CLIPBOARD_MIME ? (store.get(type) ?? "") : ""),
    };
}

function imageNode(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
    return {
        id: "image-a",
        type: CanvasNodeType.Image,
        title: "图片 A",
        position: { x: 100, y: 100 },
        width: 200,
        height: 200,
        metadata: { content: "/api/reference-assets/permanent/a.png", storageKey: "permanent/a.png", serverUrl: "/api/reference-assets/permanent/a.png", status: "success" },
        ...overrides,
    };
}

function textNode(id: string, position = { x: 400, y: 400 }): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title: `文本 ${id}`, position, width: 200, height: 160, metadata: { content: "正文", status: "success" } };
}

const connection: CanvasConnection = { id: "conn-1", fromNodeId: "image-a", toNodeId: "text-b" };

describe("节点剪贴板编解码", () => {
    it("自定义 MIME 可以完整往返", () => {
        const clipboard = fakeClipboard();
        const payload = createCanvasNodeClipboard([imageNode()], [], new Set(["image-a"]));
        expect(payload).not.toBeNull();
        writeCanvasNodeClipboard(clipboard, payload!);

        expect(readCanvasNodeClipboard(clipboard)).toEqual(payload);
    });

    it("自定义 MIME 可用时不写 text/plain，避免污染普通输入框的粘贴", () => {
        const clipboard = fakeClipboard();
        const payload = createCanvasNodeClipboard([imageNode()], [], new Set(["image-a"]));
        writeCanvasNodeClipboard(clipboard, payload!);

        expect(clipboard.store.has("text/plain")).toBe(false);
        expect(readCanvasNodeClipboard(clipboard)).toEqual(payload);
    });

    it("浏览器丢弃自定义 MIME 时回退到带版本标记的 text/plain", () => {
        const clipboard = fakeClipboard({}, { keepCustomMime: false });
        const payload = createCanvasNodeClipboard([imageNode()], [], new Set(["image-a"]));
        writeCanvasNodeClipboard(clipboard, payload!);

        expect(clipboard.store.has("text/plain")).toBe(true);
        clipboard.store.delete(CANVAS_NODE_CLIPBOARD_MIME);
        expect(readCanvasNodeClipboard(clipboard)).toEqual(payload);
    });

    it("外部普通文字不会被误认成节点载荷", () => {
        const clipboard = fakeClipboard({ "text/plain": "这是从别处复制的普通文字" });
        expect(readCanvasNodeClipboard(clipboard)).toBeNull();
        expect(readCanvasNodeClipboardText("这是从别处复制的普通文字")).toBeNull();
    });

    it("版本不符或内容损坏时拒绝解析，不会退化成旧节点", () => {
        expect(readCanvasNodeClipboardText(`vozeb-canvas-nodes:v1:{ not json`)).toBeNull();
        expect(readCanvasNodeClipboardText(`vozeb-canvas-nodes:v0:{"version":0,"nodes":[{"id":"image-a","type":"image"}],"connections":[]}`)).toBeNull();
        expect(readCanvasNodeClipboardText(`vozeb-canvas-nodes:v1:{"version":1,"nodes":[],"connections":[]}`)).toBeNull();
    });

    it("没有选中节点时返回空，不写入剪贴板", () => {
        expect(createCanvasNodeClipboard([imageNode(), textNode("text-b")], [connection], new Set())).toBeNull();
    });

    it("只复制选中节点以及两端都在选区内的连线", () => {
        const payload = createCanvasNodeClipboard([imageNode(), textNode("text-b")], [connection], new Set(["image-a", "text-b"]));
        expect(payload?.nodes.map((node) => node.id)).toEqual(["image-a", "text-b"]);
        expect(payload?.connections).toEqual([connection]);

        const partial = createCanvasNodeClipboard([imageNode(), textNode("text-b")], [connection], new Set(["image-a"]));
        expect(partial?.connections).toEqual([]);
    });
});

describe("粘贴节点副本", () => {
    function paste(nodes: CanvasNodeData[], connections: CanvasConnection[] = [], center = { x: 0, y: 0 }) {
        const payload = createCanvasNodeClipboard(nodes, connections, new Set(nodes.map((node) => node.id)));
        expect(payload).not.toBeNull();
        return createPastedCanvasNodes(payload!, center);
    }

    it("重新生成节点与连线身份，不复用原 ID", () => {
        const result = paste([imageNode(), textNode("text-b")], [connection]);
        const ids = result.nodes.map((node) => node.id);

        expect(new Set(ids).size).toBe(2);
        expect(ids).not.toContain("image-a");
        expect(ids).not.toContain("text-b");
        expect(result.connections).toHaveLength(1);
        expect(result.connections[0].id).not.toBe("conn-1");
        expect(result.connections[0].fromNodeId).toBe(ids[0]);
        expect(result.connections[0].toNodeId).toBe(ids[1]);
    });

    it("副本居中到目标画布坐标并保留原有相对位置", () => {
        const result = paste([imageNode(), textNode("text-b", { x: 400, y: 100 })], [], { x: 0, y: 0 });
        const left = Math.min(...result.nodes.map((node) => node.position.x));
        const right = Math.max(...result.nodes.map((node) => node.position.x + node.width));
        expect((left + right) / 2).toBeCloseTo(0);

        const original = Math.abs(400 - 100);
        const copied = Math.abs(result.nodes[1].position.x - result.nodes[0].position.x);
        expect(copied).toBeCloseTo(original);
    });

    it("已有的活动生成任务和 Agent 关联不会绑到副本上", () => {
        const result = paste([
            imageNode({
                metadata: {
                    content: "/api/reference-assets/permanent/a.png",
                    storageKey: "permanent/a.png",
                    serverUrl: "/api/reference-assets/permanent/a.png",
                    status: "loading",
                    videoTask: { id: "task-1", provider: "generation", model: "video-model" },
                    imageTask: { id: "task-2", kind: "edit", model: "image-model" },
                    agentRunId: "run-1",
                    agentTaskId: "agent-task-1",
                    agentGenerationTaskIds: ["task-1"],
                    agentTaskStatus: "running",
                    agentTaskOutputNodeIds: ["image-a"],
                    agentTaskAttempts: 3,
                },
            }),
        ]);

        const metadata = result.nodes[0].metadata;
        expect(metadata?.videoTask).toBeUndefined();
        expect(metadata?.imageTask).toBeUndefined();
        expect(metadata?.agentRunId).toBeUndefined();
        expect(metadata?.agentTaskId).toBeUndefined();
        expect(metadata?.agentGenerationTaskIds).toBeUndefined();
        expect(metadata?.agentTaskStatus).toBeUndefined();
        expect(metadata?.agentTaskOutputNodeIds).toBeUndefined();
        expect(metadata?.agentTaskAttempts).toBeUndefined();
    });

    it("复制已有媒体直接复用原地址，不产生新上传", () => {
        const result = paste([imageNode()]);
        expect(result.nodes[0].metadata?.content).toBe("/api/reference-assets/permanent/a.png");
        expect(result.nodes[0].metadata?.storageKey).toBe("permanent/a.png");
        expect(result.nodes[0].metadata?.serverUrl).toBe("/api/reference-assets/permanent/a.png");
    });

    it("还在生成中的节点副本不会显示成生成中", () => {
        expect(paste([imageNode({ metadata: { status: "loading" } })]).nodes[0].metadata?.status).toBe("idle");
        expect(paste([imageNode({ metadata: { status: "loading", content: "/api/reference-assets/permanent/a.png" } })]).nodes[0].metadata?.status).toBe("success");
    });

    it("组内引用重映射到副本，指向未复制节点的引用被丢弃", () => {
        const root = imageNode({ id: "image-root", metadata: { isBatchRoot: true, batchChildIds: ["image-c1", "image-c2"], primaryImageId: "image-c1" } });
        const child = imageNode({ id: "image-c1", metadata: { batchRootId: "image-root" } });
        const orphan = imageNode({ id: "image-c2" });

        const withBoth = paste([root, child]);
        const copiedRoot = withBoth.nodes.find((node) => node.metadata?.isBatchRoot);
        const copiedChild = withBoth.nodes.find((node) => node.metadata?.batchRootId);
        expect(copiedRoot?.metadata?.batchChildIds).toEqual([copiedChild?.id]);
        expect(copiedRoot?.metadata?.primaryImageId).toBe(copiedChild?.id);
        expect(copiedChild?.metadata?.batchRootId).toBe(copiedRoot?.id);

        const withOrphan = paste([orphan]);
        expect(withOrphan.nodes[0].metadata?.batchRootId).toBeUndefined();
        expect(withOrphan.nodes[0].metadata?.batchChildIds).toBeUndefined();
        expect(withOrphan.nodes[0].metadata?.isBatchRoot).toBeUndefined();
    });

    it("节点引用只保留指向本次副本的项", () => {
        const result = paste([imageNode({ metadata: { references: ["text-b", "node-missing"] } }), textNode("text-b")]);
        const copiedImage = result.nodes[0];
        const copiedText = result.nodes[1];
        expect(copiedImage.metadata?.references).toEqual([copiedText.id]);
    });
});
