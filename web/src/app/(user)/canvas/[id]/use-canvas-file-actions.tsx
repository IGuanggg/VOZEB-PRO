"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef } from "react";

import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { uploadMediaFile } from "@/services/file-storage";
import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";

import { NODE_STATUS_ERROR, NODE_STATUS_SUCCESS, createCanvasNode } from "./canvas-page-elements";
import { readCanvasNodeClipboard, writeCanvasNodeClipboard } from "./canvas-node-clipboard";
import {
    CANVAS_UPLOAD_RESTART_HINT,
    beginCanvasUploadTask,
    canvasUploadFillPatch,
    canvasUploadPlaceholderNode,
    canvasUploadPositions,
    cancelCanvasUploadTask,
    clearCanvasUploadTasks,
    endCanvasUploadTask,
    isCanvasUploadFile,
    isCanvasUploadAttemptCurrent,
    isCanvasUploadAttemptLive,
    isCanvasUploadPlaceholder,
    isGenerationCanceled,
    listCanvasUploadTasks,
    readCanvasUploadTask,
    releaseCanvasUploadPreview,
    removeConnectionsForNodes,
    renewCanvasUploadPreview,
    updateCanvasUploadNode,
    uploadCanvasImage,
    type CanvasUploadKind,
    type CanvasUploadTask,
} from "./canvas-page-utils";

import type { CanvasInteractions } from "./use-canvas-interactions";
import type { CanvasPageState } from "./use-canvas-page-state";

function isNativeEditableTarget(target: EventTarget | null) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    return Boolean((target instanceof Element ? target : null)?.closest("[contenteditable='true'],[data-canvas-no-zoom]"));
}

export function useCanvasFileActions({ state, interactions }: { state: CanvasPageState; interactions: CanvasInteractions }) {
    const {
        message,
        projectId,
        nodes,
        setNodes,
        setConnections,
        size,
        setSelectedNodeIds,
        selectedConnectionId,
        setSelectedConnectionId,
        setHoveredNodeId,
        setPendingConnectionCreate,
        setContextMenu,
        setToolbarNodeId,
        setDialogNodeId,
        setEditingNodeId,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        nodesRef,
        selectedNodeIdsRef,
    } = state;
    const { getCanvasCenter, deleteNodes, deleteConnection, copySelectedNodes, pasteCopiedNodes, undoCanvas, redoCanvas } = interactions;

    // 延迟回调里始终读当前项目 id：切换项目、删除节点之后的旧请求回调不能写回。
    const projectIdRef = useRef(projectId);
    projectIdRef.current = projectId;

    const runCanvasUpload = useCallback(
        async (task: CanvasUploadTask) => {
            task.controller = new AbortController();
            // 每次尝试的不可变身份：取消、重试、换项目之后，旧尝试的成功/失败/清理一律失效。
            const attempt = task.controller;
            const { nodeId, kind, file } = task;
            // 写回处校验“这次尝试仍然有效”：身份不可变、取消后一律失效；函数式 setNodes 会被延后执行，
            // 因此不能在这里读登记表（成功路径的清理可能已经先跑完）。
            const isLiveAttempt = () => isCanvasUploadAttemptLive(task, attempt);
            setNodes((prev) => updateCanvasUploadNode(prev, task.projectId, projectIdRef.current, nodeId, () => ({ metadata: { status: "uploading" } }), isLiveAttempt));
            try {
                const media = kind === "image" ? await uploadCanvasImage(file, attempt.signal) : await uploadMediaFile(file, kind, attempt.signal);
                setNodes((prev) => updateCanvasUploadNode(prev, task.projectId, projectIdRef.current, nodeId, (node) => canvasUploadFillPatch(node, kind, media), isLiveAttempt));
            } catch (error) {
                if (!isGenerationCanceled(error) && isLiveAttempt()) {
                    // 单项失败立刻在占位节点上标错并保留重试入口；原始 File 仍留在页面内存 Map 里供重试复用。
                    const errorDetails = `上传失败：${error instanceof Error ? error.message : "请稍后重试"}`;
                    setNodes((prev) => updateCanvasUploadNode(prev, task.projectId, projectIdRef.current, nodeId, () => ({ metadata: { status: NODE_STATUS_ERROR, uploadFailed: true, errorDetails } }), isLiveAttempt));
                    releaseCanvasUploadPreview(task);
                }
                throw error;
            }
            // 清理是同步副作用：额外确认登记表里仍是这次任务，旧尝试不会删掉同 ID 上的新尝试。
            if (isCanvasUploadAttemptCurrent(task, attempt)) endCanvasUploadTask(nodeId);
        },
        [setNodes],
    );

    const createCanvasFileNode = useCallback(
        async (kind: CanvasUploadKind, file: File, position: Position, preserveSelection = false, openDialog = true) => {
            if (!isCanvasUploadFile(kind, file)) throw new Error("文件为空或格式不正确");
            // 基本校验通过后立刻建带稳定 id 的占位节点；上传成功后只按 id 原位填充，绝不新建第二个节点。
            const id = `${kind}-${nanoid()}`;
            const task = beginCanvasUploadTask(projectIdRef.current, id, kind, file);
            setNodes((prev) => [...prev, canvasUploadPlaceholderNode(kind, id, file, position)]);
            setSelectedNodeIds((current) => (preserveSelection ? new Set([...current, id]) : new Set([id])));
            setSelectedConnectionId(null);
            await runCanvasUpload(task);
            if (openDialog) setDialogNodeId(id);
            return id;
        },
        [runCanvasUpload, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds],
    );

    const createImageFileNode = useCallback((file: File, position: Position, preserveSelection = false, openDialog = true) => createCanvasFileNode("image", file, position, preserveSelection, openDialog), [createCanvasFileNode]);

    const createVideoFileNode = useCallback((file: File, position: Position, preserveSelection = false, openDialog = true) => createCanvasFileNode("video", file, position, preserveSelection, openDialog), [createCanvasFileNode]);

    const createAudioFileNode = useCallback((file: File, position: Position, preserveSelection = false) => createCanvasFileNode("audio", file, position, preserveSelection, false), [createCanvasFileNode]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter],
    );

    // 取消上传：abort 后在途回调不再写回，占位节点、关联连线、blob 预览与相关面板在同一个逻辑操作里移除。
    const cancelCanvasUpload = useCallback(
        (nodeId: string) => {
            if (!cancelCanvasUploadTask(nodeId)) return false;
            setNodes((prev) => prev.filter((node) => node.id !== nodeId));
            // 与节点删除共用同一份图清理：任何一端不存在的连线都不留在项目状态里。
            setConnections((prev) => removeConnectionsForNodes(prev, new Set([nodeId])));
            setSelectedNodeIds((current) => (current.has(nodeId) ? new Set([...current].filter((id) => id !== nodeId)) : current));
            setDialogNodeId((current) => (current === nodeId ? null : current));
            return true;
        },
        [setConnections, setDialogNodeId, setNodes, setSelectedNodeIds],
    );

    // 重试必须填回同一个节点：复用页面内存里的原始 File；刷新后 File 不可得，只能提示重新选择文件。
    const retryCanvasUpload = useCallback(
        async (nodeId: string) => {
            const task = readCanvasUploadTask(nodeId);
            if (!task) {
                message.warning(CANVAS_UPLOAD_RESTART_HINT);
                return;
            }
            renewCanvasUploadPreview(task);
            await runCanvasUpload(task).catch(() => undefined);
        },
        [message, runCanvasUpload],
    );

    // 上传占位节点的统一操作入口，返回 true 表示该节点属于上传链，调用方不要再走生成重试。
    const handleCanvasUploadNode = useCallback(
        (node: CanvasNodeData) => {
            if (node.metadata?.status === "uploading") {
                if (cancelCanvasUpload(node.id)) return true;
                // 撤销或复制粘贴可能留下没有内存任务的占位节点：明确提示重新选择文件，并标成可重试的错误。
                message.warning(CANVAS_UPLOAD_RESTART_HINT);
                setNodes((prev) => updateCanvasUploadNode(prev, projectIdRef.current, projectIdRef.current, node.id, () => ({ metadata: { status: NODE_STATUS_ERROR, uploadFailed: true, errorDetails: CANVAS_UPLOAD_RESTART_HINT } })));
                return true;
            }
            if (node.metadata?.uploadFailed) {
                void retryCanvasUpload(node.id);
                return true;
            }
            return false;
        },
        [cancelCanvasUpload, message, retryCanvasUpload, setNodes],
    );

    // 节点被删除、清空、撤销、换过媒体或切换项目后，旧上传释放内存并停止写回。
    useEffect(() => {
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        listCanvasUploadTasks().forEach((task) => {
            if (task.projectId === projectId && isCanvasUploadPlaceholder(nodeById.get(task.nodeId))) return;
            cancelCanvasUploadTask(task.nodeId);
        });
    }, [nodes, projectId]);

    useEffect(() => () => clearCanvasUploadTasks(), []);

    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            if (isNativeEditableTarget(event.target)) return;
            if (!event.clipboardData) return;
            // 只粘贴本次系统剪贴板确认的节点载荷，识别不了就不能默默使用内存里的旧节点。
            const nodePayload = readCanvasNodeClipboard(event.clipboardData);
            if (nodePayload) {
                event.preventDefault();
                if (pasteCopiedNodes(nodePayload)) message.success(`已粘贴 ${nodePayload.nodes.length} 个节点`);
                return;
            }
            const images = clipboardImageFiles(event.clipboardData);
            if (images.length) {
                event.preventDefault();
                setSelectedNodeIds(new Set());
                const center = getCanvasCenter();
                // 落点与顺序在这里一次算好，之后只按序号原位填充，不受网络返回顺序影响。
                const positions = canvasUploadPositions(center, images.length);
                void Promise.allSettled(images.map((file, index) => createImageFileNode(file, positions[index], true, false))).then((results) => {
                    const added = results.filter((result) => result.status === "fulfilled").length;
                    const failures = results.filter((result) => result.status === "rejected" && !isGenerationCanceled(result.reason));
                    if (failures.length) message.error(failures.length === images.length ? "剪切板图片添加失败" : `有 ${failures.length} 张剪切板图片添加失败`);
                    if (added) message.success(`已从剪切板添加 ${added} 张图片`);
                });
                return;
            }
            const text = event.clipboardData?.getData("text/plain") || "";
            if (!text.trim()) return;
            event.preventDefault();
            if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
        };

        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, pasteCopiedNodes, setSelectedNodeIds]);

    useEffect(() => {
        const handleCopy = (event: ClipboardEvent) => {
            if (isNativeEditableTarget(event.target) || !event.clipboardData) return;
            // 用户选中了文字时优先走浏览器原生复制，不抢助手回复和节点正文的复制。
            if (window.getSelection()?.toString().trim()) return;
            const payload = copySelectedNodes();
            if (!payload) return;
            event.preventDefault();
            writeCanvasNodeClipboard(event.clipboardData, payload);
        };

        window.addEventListener("copy", handleCopy);
        return () => window.removeEventListener("copy", handleCopy);
    }, [copySelectedNodes]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (isNativeEditableTarget(event.target)) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                return;
            }

            // Ctrl+C / Ctrl+V 交给原生 copy / paste 事件，按本次剪贴板真实内容分流。

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [deleteConnection, deleteNodes, redoCanvas, selectedConnectionId, undoCanvas]);
    return {
        createImageFileNode,
        createVideoFileNode,
        createAudioFileNode,
        createTextNodeFromClipboard,
        handleCanvasUploadNode,
    };
}

export type CanvasFileActions = ReturnType<typeof useCanvasFileActions>;
