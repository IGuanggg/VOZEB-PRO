import { nanoid } from "nanoid";

import { type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "../types";
import { NODE_STATUS_IDLE, NODE_STATUS_LOADING, NODE_STATUS_SUCCESS } from "./canvas-page-elements";

export const CANVAS_NODE_CLIPBOARD_MIME = "application/x-vozeb-canvas-nodes";

const CLIPBOARD_TEXT_PREFIX = "vozeb-canvas-nodes:v1:";
const CLIPBOARD_VERSION = 1;

export type CanvasNodeClipboardPayload = {
    version: number;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ClipboardWriter = Pick<DataTransfer, "setData" | "getData">;
type ClipboardReader = Pick<DataTransfer, "getData">;

// 上游任务句柄和 Agent 关联不能带到副本上，否则副本会接管原节点的活动任务。
const UNSAFE_COPY_KEYS: (keyof CanvasNodeMetadata)[] = [
    "videoTask",
    "imageTask",
    "textTask",
    "audioTask",
    "agentRunId",
    "agentTaskId",
    "agentGenerationTaskIds",
    "agentTaskStatus",
    "agentTaskDependencies",
    "agentTaskOutputNodeIds",
    "agentTaskAttempts",
    "agentTaskError",
];

export function writeCanvasNodeClipboard(data: ClipboardWriter, payload: CanvasNodeClipboardPayload) {
    const json = JSON.stringify(payload);
    data.setData(CANVAS_NODE_CLIPBOARD_MIME, json);
    // 先探测本次浏览器是否真的保留了自定义 MIME；只有在不支持时才写 text/plain 回退，
    // 避免复制节点后往普通输入框粘贴时插入一段载荷 JSON。
    if (data.getData(CANVAS_NODE_CLIPBOARD_MIME) !== json) data.setData("text/plain", `${CLIPBOARD_TEXT_PREFIX}${json}`);
}

export function readCanvasNodeClipboard(data: ClipboardReader): CanvasNodeClipboardPayload | null {
    return parseCanvasNodeClipboard(data.getData(CANVAS_NODE_CLIPBOARD_MIME)) ?? readCanvasNodeClipboardText(data.getData("text/plain"));
}

export function readCanvasNodeClipboardText(text: string): CanvasNodeClipboardPayload | null {
    return text.startsWith(CLIPBOARD_TEXT_PREFIX) ? parseCanvasNodeClipboard(text.slice(CLIPBOARD_TEXT_PREFIX.length)) : null;
}

function parseCanvasNodeClipboard(json: string): CanvasNodeClipboardPayload | null {
    if (!json) return null;
    try {
        const parsed = JSON.parse(json) as Partial<CanvasNodeClipboardPayload> | null;
        if (!parsed || typeof parsed !== "object" || parsed.version !== CLIPBOARD_VERSION) return null;
        if (!Array.isArray(parsed.nodes) || !parsed.nodes.length) return null;
        // 识别成功之前必须验证粘贴会直接使用的每个字段：缺字段时宁可整份按不识别处理，
        // 走普通文本回退，也不能半插入或在粘贴时抛未捕获异常。
        if (!parsed.nodes.every(isClipboardNode)) return null;
        const connections = Array.isArray(parsed.connections) ? parsed.connections : [];
        if (!connections.every(isClipboardConnection)) return null;
        return { version: parsed.version, nodes: parsed.nodes, connections };
    } catch {
        return null;
    }
}

/** 粘贴会直接用这些字段算边界、改标题并按 id 重映射组内引用。 */
function isClipboardNode(value: unknown): value is CanvasNodeData {
    if (!value || typeof value !== "object") return false;
    const node = value as Partial<CanvasNodeData>;
    if (typeof node.id !== "string" || typeof node.type !== "string" || typeof node.title !== "string") return false;
    if (!Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) return false;
    if (!Number.isFinite(node.width) || !Number.isFinite(node.height)) return false;
    if (node.metadata !== undefined && (!node.metadata || typeof node.metadata !== "object")) return false;
    return [node.metadata?.batchChildIds, node.metadata?.references, node.metadata?.brandKit?.approvedNodeIds, node.metadata?.brandKit?.rejectedNodeIds].every(isOptionalIdList);
}

function isOptionalIdList(value: unknown) {
    return value === undefined || (Array.isArray(value) && value.every((id) => typeof id === "string"));
}

/** 连线两端都要能重映射到本次副本，缺一端就会留下悬空边。 */
function isClipboardConnection(value: unknown): value is CanvasConnection {
    if (!value || typeof value !== "object") return false;
    const connection = value as Partial<CanvasConnection>;
    return typeof connection.id === "string" && typeof connection.fromNodeId === "string" && typeof connection.toNodeId === "string";
}

export function createCanvasNodeClipboard(nodes: CanvasNodeData[], connections: CanvasConnection[], selectedIds: Set<string>): CanvasNodeClipboardPayload | null {
    const copiedNodes = nodes.filter((node) => selectedIds.has(node.id)).map((node) => ({ ...node, position: { ...node.position }, metadata: node.metadata ? { ...node.metadata } : undefined }));
    if (!copiedNodes.length) return null;

    const copiedIds = new Set(copiedNodes.map((node) => node.id));
    return {
        version: CLIPBOARD_VERSION,
        nodes: copiedNodes,
        connections: connections.filter((connection) => copiedIds.has(connection.fromNodeId) && copiedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
    };
}

export function createPastedCanvasNodes(payload: CanvasNodeClipboardPayload, center: Position) {
    const bounds = payload.nodes.reduce(
        (acc, node) => ({
            left: Math.min(acc.left, node.position.x),
            top: Math.min(acc.top, node.position.y),
            right: Math.max(acc.right, node.position.x + node.width),
            bottom: Math.max(acc.bottom, node.position.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const dx = center.x - (bounds.left + bounds.right) / 2;
    const dy = center.y - (bounds.top + bounds.bottom) / 2;

    const idMap = new Map<string, string>();
    payload.nodes.forEach((node) => idMap.set(node.id, `${node.type}-${nanoid()}`));

    const nodes = payload.nodes.map((node) => ({
        ...node,
        id: idMap.get(node.id) as string,
        title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
        position: { x: node.position.x + dx, y: node.position.y + dy },
        metadata: copyNodeMetadata(node.metadata, idMap),
    }));

    const connections = payload.connections.flatMap((connection) => {
        const fromNodeId = idMap.get(connection.fromNodeId);
        const toNodeId = idMap.get(connection.toNodeId);
        return fromNodeId && toNodeId ? [{ ...connection, id: `conn-${nanoid()}`, fromNodeId, toNodeId }] : [];
    });

    return { nodes, connections };
}

function copyNodeMetadata(metadata: CanvasNodeMetadata | undefined, idMap: Map<string, string>) {
    if (!metadata) return undefined;
    const next: CanvasNodeMetadata = { ...metadata };
    UNSAFE_COPY_KEYS.forEach((key) => delete next[key]);

    if (next.status === NODE_STATUS_LOADING) next.status = next.content ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE;

    // 组内引用只能指向本次一起复制的节点，指向未复制节点的引用必须丢弃。
    const batchChildIds = remapIds(next.batchChildIds, idMap);
    if (batchChildIds.length) {
        next.batchChildIds = batchChildIds;
        next.primaryImageId = (next.primaryImageId && idMap.get(next.primaryImageId)) || batchChildIds[0];
    } else {
        delete next.batchChildIds;
        delete next.primaryImageId;
        delete next.isBatchRoot;
    }
    const batchRootId = next.batchRootId ? idMap.get(next.batchRootId) : undefined;
    if (batchRootId) next.batchRootId = batchRootId;
    else delete next.batchRootId;

    const references = remapIds(next.references, idMap);
    if (references.length) next.references = references;
    else delete next.references;

    if (next.brandKit) {
        next.brandKit = {
            ...next.brandKit,
            approvedNodeIds: remapIds(next.brandKit.approvedNodeIds, idMap),
            rejectedNodeIds: remapIds(next.brandKit.rejectedNodeIds, idMap),
        };
    }

    return next;
}

function remapIds(ids: string[] | undefined, idMap: Map<string, string>) {
    return (ids || []).flatMap((id) => {
        const mapped = idMap.get(id);
        return mapped ? [mapped] : [];
    });
}
