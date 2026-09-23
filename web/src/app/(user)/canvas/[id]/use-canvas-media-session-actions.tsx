"use client";

import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback } from "react";

import { droppedFiles, preventFileDragEvent } from "@/lib/file-drop";
import { readImageMeta } from "@/lib/image-utils";
import { CanvasNodeType, type CanvasAssistantSession, type Position } from "../types";
import { isPanoramaRatio } from "../utils/canvas-panorama";

import { canvasUploadPositions, isAudioFile, isGenerationCanceled } from "./canvas-page-utils";

import type { CanvasInteractions } from "./use-canvas-interactions";
import type { CanvasPageState } from "./use-canvas-page-state";

import type { CanvasFileActions } from "./use-canvas-file-actions";

export function useCanvasMediaSessionActions({ state, interactions, files }: { state: CanvasPageState; interactions: CanvasInteractions; files: CanvasFileActions }) {
    const {
        message,
        projectId,
        containerRef,
        imageInputRef,
        uploadTargetRef,
        renameProject,
        currentProject,
        setNodes,
        setChatSessions,
        setActiveChatId,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        setDialogNodeId,
        setTitleEditing,
        titleDraft,
        setTitleDraft,
        nodesRef,
    } = state;
    const { screenToCanvas } = interactions;
    const { createImageFileNode, createVideoFileNode, createAudioFileNode, replaceCanvasFileNode } = files;

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            const target = uploadTargetRef.current;
            if (!file) return;
            if (!file.type.startsWith("image/") && !file.type.startsWith("video/") && !isAudioFile(file)) {
                uploadTargetRef.current = null;
                event.target.value = "";
                message.error("请选择图片、视频、MP3 或 WAV 文件");
                return;
            }

            try {
                if (target?.nodeId) {
                    const targetNode = nodesRef.current.find((node) => node.id === target.nodeId);
                    if (!targetNode) return;
                    if (targetNode.type === CanvasNodeType.Panorama && file.type.startsWith("image/")) {
                        const objectUrl = URL.createObjectURL(file);
                        const dimensions = await readImageMeta(objectUrl).finally(() => URL.revokeObjectURL(objectUrl));
                        if (!isPanoramaRatio(dimensions.width, dimensions.height)) {
                            message.error("全景图必须接近 2:1 比例，例如 2048x1024");
                            return;
                        }
                    }
                    await replaceCanvasFileNode(targetNode, isAudioFile(file) ? "audio" : file.type.startsWith("video/") ? "video" : "image", file);
                } else {
                    const position = target?.position || screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                    await (isAudioFile(file) ? createAudioFileNode(file, position) : file.type.startsWith("video/") ? createVideoFileNode(file, position) : createImageFileNode(file, position));
                }
            } catch (error) {
                if (isGenerationCanceled(error)) return; // 用户主动取消上传时不再报错
                message.error(error instanceof Error ? error.message : "文件添加失败，请稍后重试");
            } finally {
                uploadTargetRef.current = null;
                event.target.value = "";
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, replaceCanvasFileNode, message, nodesRef, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (!preventFileDragEvent(event)) return;
            const files = droppedFiles(event, (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item));
            if (!files.length) return;

            const pos = screenToCanvas(event.clientX, event.clientY);
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            // 多文件落点与顺序在导入开始时一次算好，与各文件的网络返回顺序无关。
            const positions = canvasUploadPositions(pos, files.length);
            const creations = files.map((file, index) => {
                const nextPos = positions[index];
                return isAudioFile(file) ? createAudioFileNode(file, nextPos, true) : file.type.startsWith("video/") ? createVideoFileNode(file, nextPos, true, false) : createImageFileNode(file, nextPos, true, false);
            });
            void Promise.allSettled(creations).then((results) => {
                const failures = results.filter((result) => result.status === "rejected" && !isGenerationCanceled(result.reason));
                if (failures.length) message.error(failures.length === files.length ? "文件添加失败" : `有 ${failures.length} 个文件添加失败`);
            });
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, message, screenToCanvas, setSelectedConnectionId, setSelectedNodeIds],
    );

    const pasteAssistantImage = useCallback(
        async (file: File) => {
            const position = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const nodeId = await createImageFileNode(file, position, true);
            message.success("图片已添加到本轮引用");
            return nodeId;
        },
        [createImageFileNode, message, screenToCanvas, size.height, size.width],
    );

    const handleAssistantSessionsChange = useCallback((sessions: CanvasAssistantSession[], activeId: string | null) => {
        setChatSessions(sessions);
        setActiveChatId(activeId);
    }, []);

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) renameProject(projectId, nextTitle);
        setTitleEditing(false);
    }, [projectId, renameProject, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);
    return {
        handleUploadRequest,
        handleImageInputChange,
        handleDrop,
        pasteAssistantImage,
        handleAssistantSessionsChange,
        startTitleEditing,
        finishTitleEditing,
        preventCanvasContextMenu,
    };
}

export type CanvasMediaSessionActions = ReturnType<typeof useCanvasMediaSessionActions>;
