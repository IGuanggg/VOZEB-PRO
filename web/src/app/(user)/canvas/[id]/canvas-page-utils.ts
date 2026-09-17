"use client";

import { browserReadableMediaUrl } from "@/lib/browser-media-url";
import { readImageMeta } from "@/lib/image-utils";
import { resolveImageUrl, resolveStoredImageDataUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { resolveMediaUrl, type UploadedFile } from "@/services/file-storage";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { CANVAS_CONFIG_NODE_HEIGHT, NODE_DEFAULT_SIZE, getNodeSpec } from "../constants";
import type { CanvasImageAngleParams } from "../components/canvas-node-angle-dialog";
import type { NodeGenerationInput } from "../components/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "../components/canvas-node-prompt-panel";
import { resolveCanvasGenerationModel } from "../utils/canvas-node-config";
import { fitNodeSize, nodeSizeFromRatio, resizeImageNodeToNaturalRatio } from "../utils/canvas-node-size";
import { PANORAMA_IMAGE_SIZE } from "../utils/canvas-panorama";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type ConnectionHandle, type Position } from "../types";
import { CANVAS_DROP_NODE_OFFSET, NODE_STATUS_ERROR, VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH } from "./canvas-page-elements";

const NODE_CREATE_MAX_ATTEMPTS = 12;

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export async function uploadCanvasImage(input: string | Blob, signal?: AbortSignal): Promise<UploadedImage> {
    const image = await uploadImage(input, signal);
    return { ...image, url: await resolveStoredImageDataUrl(image.storageKey, image.url) };
}

export async function uploadGeneratedCanvasImage(url: string, remoteFallback = "", serverFallback = ""): Promise<UploadedImage> {
    const remoteUrl = isRemoteGeneratedUrl(remoteFallback) ? remoteFallback : isRemoteGeneratedUrl(url) ? url : "";
    const serverUrl = isServerGeneratedUrl(serverFallback) ? serverFallback : isServerGeneratedUrl(url) ? url : "";
    const localUrl = isLocalGeneratedUrl(url) ? url : "";
    const candidates = Array.from(new Set([serverUrl, localUrl, url, remoteUrl].filter(Boolean)));
    for (const candidate of candidates) {
        try {
            const image = await uploadCanvasImage(candidate);
            return { ...image, remoteUrl: remoteUrl || undefined, serverUrl: image.serverUrl || serverUrl || image.url };
        } catch {
            // Try the next fallback source.
        }
    }
    throw new Error("图片保存到服务器失败");
}

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, remoteUrl: image.remoteUrl, serverUrl: image.serverUrl, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

export function canvasNodeReferenceImage(node: CanvasNodeData): ReferenceImage {
    const content = node.metadata?.content || "";
    const remoteUrl = isRemoteGeneratedUrl(node.metadata?.remoteUrl || "") ? node.metadata?.remoteUrl || "" : isRemoteGeneratedUrl(content) ? content : "";
    const serverUrl = isServerGeneratedUrl(node.metadata?.serverUrl || "") ? node.metadata?.serverUrl || "" : isServerGeneratedUrl(content) ? content : "";
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata?.mimeType || "image/png",
        dataUrl: content,
        storageKey: node.metadata?.storageKey,
        url: serverUrl || remoteUrl || undefined,
        remoteUrl: remoteUrl || undefined,
        serverUrl: serverUrl || undefined,
        width: node.metadata?.naturalWidth || node.width,
        height: node.metadata?.naturalHeight || node.height,
    };
}

export function isRemoteGeneratedUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

export function isLocalGeneratedUrl(value: string) {
    return value.startsWith("data:") || value.startsWith("blob:");
}

export function isServerGeneratedUrl(value: string) {
    return value.startsWith("/api/generation-log-assets/");
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return {
        content: video.url,
        storageKey: video.storageKey,
        remoteUrl: video.remoteUrl,
        serverUrl: video.serverUrl,
        status: "success",
        naturalWidth: video.width,
        naturalHeight: video.height,
        bytes: video.bytes,
        mimeType: video.mimeType || "video/mp4",
        durationMs: video.durationMs,
    };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, remoteUrl: audio.remoteUrl, serverUrl: audio.serverUrl, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

export type CanvasUploadKind = "image" | "video" | "audio";

const CANVAS_UPLOAD_NODE_TYPE: Record<CanvasUploadKind, CanvasNodeType> = {
    image: CanvasNodeType.Image,
    video: CanvasNodeType.Video,
    audio: CanvasNodeType.Audio,
};

// 刷新或撤销之后页面内存里的原始 File 已不可得：只能提示重新选择文件，不能假装能恢复上传。
export const CANVAS_UPLOAD_RESTART_HINT = "原文件已不在页面内存中，请重新选择文件上传";

// 多文件导入的落点与顺序在导入开始时一次算好，后续只按序号原位填充，不随网络返回顺序改变。
export function canvasUploadPositions(center: Position, count: number): Position[] {
    return Array.from({ length: count }, (_, index) => ({ x: center.x + index * CANVAS_DROP_NODE_OFFSET, y: center.y + index * CANVAS_DROP_NODE_OFFSET }));
}

export function isCanvasUploadFile(kind: CanvasUploadKind, file: File) {
    if (!file.size) return false;
    return kind === "audio" ? isAudioFile(file) : file.type.startsWith(`${kind}/`);
}

// 上传占位节点是专有上传状态：不带生成任务句柄，也不带 blob:/data: 预览地址（metadata 会整体持久化到服务端）。
export function canvasUploadPlaceholderNode(kind: CanvasUploadKind, id: string, file: File, position: Position): CanvasNodeData {
    const spec = NODE_DEFAULT_SIZE[CANVAS_UPLOAD_NODE_TYPE[kind]];
    return {
        id,
        type: CANVAS_UPLOAD_NODE_TYPE[kind],
        title: file.name,
        position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
        width: spec.width,
        height: spec.height,
        metadata: { status: "uploading" },
    };
}

export function isCanvasUploadPlaceholder(node: CanvasNodeData | undefined) {
    return Boolean(node && (isCanvasUploading(node) || node.metadata?.uploadFailed));
}

/** 仍在等结果的上传占位节点：只有这种节点会在回填后变更历史步骤归属。 */
export function isCanvasUploading(node: CanvasNodeData | undefined) {
    return node?.metadata?.status === "uploading";
}

/**
 * 恢复没有内存任务的上传占位快照时，把它变成明确可操作的重选文件状态：
 * 刷新恢复、撤销/重做回到占位快照都必须走这一条，不能恢复成永远等不到结果的“上传中”。
 * 节点完全没变时返回原数组，避免无意义的重渲染。
 */
export function restoreCanvasUploadNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    if (!nodes.some((node) => isCanvasUploading(node) && !readCanvasUploadTask(node.id))) return nodes;
    return nodes.map((node) => (isCanvasUploading(node) && !readCanvasUploadTask(node.id) ? restoreCanvasUploadNode(node) : node));
}

/** 依据“是否还有内存任务”把上传占位节点标成可重试错误；有任务的继续等回填。 */
export function restoreCanvasUploadNode(node: CanvasNodeData): CanvasNodeData {
    if (!isCanvasUploading(node) || readCanvasUploadTask(node.id)) return node;
    return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, uploadFailed: true, errorDetails: CANVAS_UPLOAD_RESTART_HINT } };
}

// 上传成功后原位填充同一个节点：保持中心点、换成服务端媒体 metadata，不新建节点。
export function canvasUploadFillPatch(node: CanvasNodeData, kind: CanvasUploadKind, media: UploadedImage | UploadedFile): Partial<CanvasNodeData> {
    const metadata = kind === "image" ? imageMetadata(media as UploadedImage) : kind === "video" ? videoMetadata(media) : audioMetadata(media);
    const spec = NODE_DEFAULT_SIZE[CANVAS_UPLOAD_NODE_TYPE[kind]];
    const naturalWidth = metadata.naturalWidth || (kind === "video" ? 1280 : spec.width);
    const naturalHeight = metadata.naturalHeight || (kind === "video" ? 720 : spec.height);
    const size = kind === "audio" ? spec : kind === "video" ? fitNodeSize(naturalWidth, naturalHeight, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT) : fitNodeSize(naturalWidth, naturalHeight);
    return { width: size.width, height: size.height, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 }, metadata };
}

// 迟到回调保护：节点已被删除、撤销、换过媒体或已切换项目时返回原数组，绝不复活节点，也不写进其他项目。
// isValid 在函数式写入处再校验一次尝试身份：取消后撤销恢复的同 ID 节点、被替换的新尝试都不能被旧回调改写。
export function updateCanvasUploadNode(nodes: CanvasNodeData[], projectId: string, activeProjectId: string, nodeId: string, patch: (node: CanvasNodeData) => Partial<CanvasNodeData>, isValid?: () => boolean): CanvasNodeData[] {
    if (isValid && !isValid()) return nodes;
    const target = projectId === activeProjectId ? nodes.find((node) => node.id === nodeId) : undefined;
    if (!isCanvasUploadPlaceholder(target)) return nodes;
    return nodes.map((node) => (node.id === nodeId ? { ...node, ...patch(node) } : node));
}

export type CanvasUploadTask = {
    projectId: string;
    nodeId: string;
    kind: CanvasUploadKind;
    file: File;
    previewUrl: string;
    controller: AbortController;
};

// 原始 File 与 blob 预览只放在页面内存 Map（按节点 id）：节点 metadata 会持久化到服务端，不能带这些临时内容。
const canvasUploadTasks = new Map<string, CanvasUploadTask>();

export function renewCanvasUploadPreview(task: CanvasUploadTask) {
    if (task.previewUrl) URL.revokeObjectURL(task.previewUrl);
    task.previewUrl = URL.createObjectURL(task.file);
}

export function beginCanvasUploadTask(projectId: string, nodeId: string, kind: CanvasUploadKind, file: File) {
    const task: CanvasUploadTask = { projectId, nodeId, kind, file, previewUrl: "", controller: new AbortController() };
    renewCanvasUploadPreview(task);
    canvasUploadTasks.set(nodeId, task);
    return task;
}

export function readCanvasUploadTask(nodeId: string) {
    return canvasUploadTasks.get(nodeId);
}

export function canvasUploadPreviewUrl(nodeId: string) {
    return canvasUploadTasks.get(nodeId)?.previewUrl || "";
}

export function releaseCanvasUploadPreview(task: CanvasUploadTask) {
    if (!task.previewUrl) return;
    URL.revokeObjectURL(task.previewUrl);
    task.previewUrl = "";
}

export function endCanvasUploadTask(nodeId: string) {
    const task = canvasUploadTasks.get(nodeId);
    if (!task) return;
    releaseCanvasUploadPreview(task);
    canvasUploadTasks.delete(nodeId);
}

export function cancelCanvasUploadTask(nodeId: string) {
    const task = canvasUploadTasks.get(nodeId);
    if (!task) return false;
    task.controller.abort();
    endCanvasUploadTask(nodeId);
    return true;
}

/**
 * 每次尝试的不可变身份校验：只有仍然登记在案、还是同一次尝试、且没有被取消的回调才能写回。
 * 图片尺寸读取不接收 AbortSignal，abort 后异步链仍可能继续，所以不能只靠 abort 判断。
 */
/**
 * 这次尝试本身还有效：没有被更新的一次尝试替换，也没有被取消。
 * 只在写回处使用：函数式 setNodes 会被 React 延后执行，那个时刻登记表可能已经清理，
 * 所以写回判定只看不可变的尝试身份与取消状态。
 */
export function isCanvasUploadAttemptLive(task: CanvasUploadTask, attempt: AbortController) {
    return task.controller === attempt && !attempt.signal.aborted;
}

/**
 * 清理前额外确认登记表里仍然是这次任务：旧尝试结束时不按 nodeId 盲目删除新一次尝试。
 * 图片尺寸读取不接收 AbortSignal，abort 之后异步链仍可能继续，所以不能只靠 abort 判断。
 */
export function isCanvasUploadAttemptCurrent(task: CanvasUploadTask, attempt: AbortController) {
    return readCanvasUploadTask(task.nodeId) === task && isCanvasUploadAttemptLive(task, attempt);
}

/** 节点被删除或取消上传后的图清理：任何一端不存在的连线都不再保留，没有可清理项时返回原数组。 */
export function removeConnectionsForNodes(connections: CanvasConnection[], removedNodeIds: Set<string>) {
    if (!connections.some((connection) => removedNodeIds.has(connection.fromNodeId) || removedNodeIds.has(connection.toNodeId))) return connections;
    return connections.filter((connection) => !removedNodeIds.has(connection.fromNodeId) && !removedNodeIds.has(connection.toNodeId));
}

export function listCanvasUploadTasks() {
    return [...canvasUploadTasks.values()];
}

export function clearCanvasUploadTasks() {
    listCanvasUploadTasks().forEach((task) => {
        task.controller.abort();
        endCanvasUploadTask(task.nodeId);
    });
}

export function replaceCanvasNodeMediaMetadata(current: CanvasNodeMetadata | undefined, media: CanvasNodeMetadata, patch: CanvasNodeMetadata = {}): CanvasNodeMetadata {
    return {
        ...current,
        prompt: undefined,
        sourcePrompt: undefined,
        panoramaSourcePrompt: undefined,
        generationType: undefined,
        model: undefined,
        size: undefined,
        quality: undefined,
        count: undefined,
        seconds: undefined,
        vquality: undefined,
        generateAudio: undefined,
        watermark: undefined,
        videoReferenceMode: undefined,
        videoFirstFrame: undefined,
        videoLastFrame: undefined,
        videoReferences: undefined,
        audioVoice: undefined,
        audioFormat: undefined,
        audioSpeed: undefined,
        audioInstructions: undefined,
        cameraControl: undefined,
        panoramaProjection: undefined,
        references: undefined,
        isBatchRoot: undefined,
        batchRootId: undefined,
        batchChildIds: undefined,
        batchUsesReferenceImages: undefined,
        primaryImageId: undefined,
        imageBatchExpanded: undefined,
        imageTask: undefined,
        videoTask: undefined,
        textTask: undefined,
        audioTask: undefined,
        errorDetails: undefined,
        // 换成新媒体的节点必须退出“上传失败/重试”链：否则 status=success 与 uploadFailed=true 并存，
        // 节点仍被当成上传占位，旧任务、原始 File 与 blob 预览都不会释放。
        uploadFailed: undefined,
        freeResize: false,
        ...media,
        ...patch,
    };
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions || "",
    };
}

export function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(nodes.map((node) => hydrateCanvasNode(node).catch(() => node)));
}

async function hydrateCanvasNode(node: CanvasNodeData) {
    // 从服务端恢复出来的上传占位节点已经没有原始 File，只能标成可重试的错误并提示重新选择文件。
    if (isCanvasUploading(node)) return restoreCanvasUploadNode(node);
    const content = node.metadata?.content;
    const fallbackContent = generatedContentFallback(content, node.metadata?.remoteUrl, node.metadata?.serverUrl);
    if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && node.metadata?.storageKey) return { ...node, metadata: { ...node.metadata, content: await resolveMediaUrl(node.metadata.storageKey, fallbackContent) } };
    if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && content?.startsWith("blob:") && fallbackContent) return { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && !content && fallbackContent) return { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    if (!isCanvasImageNodeType(node.type) || !fallbackContent) return node;
    let hydratedNode = node;
    if (node.metadata?.storageKey) hydratedNode = { ...node, metadata: { ...node.metadata, content: await resolveStoredImageDataUrl(node.metadata.storageKey, fallbackContent) } };
    else if (content?.startsWith("blob:") && fallbackContent) hydratedNode = { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    else if (!content && fallbackContent) hydratedNode = { ...node, metadata: { ...node.metadata, content: fallbackContent } };
    const contentValue = content || "";
    if (contentValue.startsWith("data:image/")) hydratedNode = { ...node, metadata: { ...node.metadata, ...imageMetadata(await uploadCanvasImage(contentValue)) } };
    if (hydratedNode.type === CanvasNodeType.Panorama) return hydratedNode;
    const naturalWidth = hydratedNode.metadata?.naturalWidth;
    const naturalHeight = hydratedNode.metadata?.naturalHeight;
    if (naturalWidth && naturalHeight) return resizeImageNodeToNaturalRatio(hydratedNode, naturalWidth, naturalHeight);
    const dimensions = await readImageMeta(hydratedNode.metadata?.content || fallbackContent);
    return resizeImageNodeToNaturalRatio(hydratedNode, dimensions.width, dimensions.height);
}

export function generatedContentFallback(content?: string, remoteFallback?: string, serverFallback?: string) {
    const value = content || "";
    const localValue = value.startsWith("data:") ? value : "";
    const remoteUrl = isRemoteGeneratedUrl(remoteFallback || "") ? remoteFallback || "" : isRemoteGeneratedUrl(value) ? value : "";
    const serverUrl = isServerGeneratedUrl(serverFallback || "") ? serverFallback || "" : isServerGeneratedUrl(value) ? value : "";
    const fallback = serverUrl || localValue || (value && !value.startsWith("blob:") ? value : "") || remoteUrl;
    return browserReadableMediaUrl(fallback);
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        try {
            if (item.storageKey) return { ...item, dataUrl: await resolveStoredImageDataUrl(item.storageKey, item.dataUrl) };
            if (item.dataUrl?.startsWith("data:image/")) {
                const image = await uploadCanvasImage(item.dataUrl);
                return { ...item, dataUrl: image.url, storageKey: image.storageKey };
            }
        } catch {
            return item;
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    const value = Math.floor(Number(count));
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

// 连续在空白处新建时按固定步长阶梯偏移，避免节点完全堆在同一点；用户指定位置时不调用。
export function findFreeNodePosition(nodes: CanvasNodeData[], center: Position, type: CanvasNodeType): Position {
    const spec = getNodeSpec(type);
    for (let index = 0; index < NODE_CREATE_MAX_ATTEMPTS; index += 1) {
        const position = { x: center.x + index * CANVAS_DROP_NODE_OFFSET, y: center.y + index * CANVAS_DROP_NODE_OFFSET };
        if (!nodes.some((node) => coversPosition(node, position, spec))) return position;
    }
    return center;
}

function coversPosition(node: CanvasNodeData, center: Position, spec: { width: number; height: number }) {
    const left = center.x - spec.width / 2;
    const top = center.y - spec.height / 2;
    return node.position.x <= left && node.position.y <= top && node.position.x + node.width >= left + spec.width && node.position.y + node.height >= top + spec.height;
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    if (node.type === CanvasNodeType.Config && typeof safePatch.configDetailsOpen === "boolean") {
        return { ...next, height: safePatch.configDetailsOpen ? CANVAS_CONFIG_NODE_HEIGHT.expanded : CANVAS_CONFIG_NODE_HEIGHT.collapsed };
    }
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : node.type === CanvasNodeType.Panorama ? NODE_DEFAULT_SIZE[CanvasNodeType.Panorama] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    if (node.type === CanvasNodeType.Panorama) return { ...next, metadata: { ...next.metadata, size: PANORAMA_IMAGE_SIZE } };
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}

export function normalizeCanvasConfigNodeLayout(node: CanvasNodeData) {
    if (node.type !== CanvasNodeType.Config) return node;
    const configDetailsOpen = node.metadata?.configDetailsOpen === true;
    const height = configDetailsOpen ? CANVAS_CONFIG_NODE_HEIGHT.expanded : CANVAS_CONFIG_NODE_HEIGHT.collapsed;
    if (node.height === height && node.metadata?.configDetailsOpen === configDetailsOpen) return node;
    return { ...node, height, metadata: { ...node.metadata, configDetailsOpen } };
}

export function getConnectionTargetAnchor(node: CanvasNodeData, current: ConnectionHandle) {
    return {
        x: current.handleType === "source" ? node.position.x : node.position.x + node.width,
        y: node.position.y + node.height / 2,
    };
}

export function normalizeConnection(firstNodeId: string, secondNodeId: string, nodes: CanvasNodeData[], firstHandleType: "source" | "target") {
    const first = nodes.find((node) => node.id === firstNodeId);
    const second = nodes.find((node) => node.id === secondNodeId);
    if (!first || !second || first.id === second.id) return null;
    if (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config) return null;
    if (second.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    if (first.type === CanvasNodeType.Config && firstHandleType === "target") return { fromNodeId: second.id, toNodeId: first.id };
    if (first.type === CanvasNodeType.Config) return { fromNodeId: first.id, toNodeId: second.id };
    return { fromNodeId: first.id, toNodeId: second.id };
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const model = resolveCanvasGenerationModel(config, mode, node?.metadata?.model);
    return {
        ...config,
        model,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.type === CanvasNodeType.Panorama ? PANORAMA_IMAGE_SIZE : node?.metadata?.size || config.size || defaultConfig.size,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
    };
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || !isCanvasImageNodeType(node.type) || !node.metadata?.content) return [];
    return [canvasNodeReferenceImage(node)];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function isHiddenBatchChild(node: CanvasNodeData, nodes: CanvasNodeData[], collapsingBatchIds?: Set<string>) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    if (root && collapsingBatchIds?.has(rootId)) return false;
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function isHiddenBatchConnectionEndpoint(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const rootId = node.metadata?.batchRootId;
    if (!rootId) return false;
    const root = nodes.find((item) => item.id === rootId);
    return Boolean(root && !root.metadata?.imageBatchExpanded);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${params.wideAngle ? "广角" : "标准"}镜头`;
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
