"use client";

import { useCallback } from "react";

import { resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { useCanvasStore } from "../stores/use-canvas-store";

import { transitionCanvasHistory } from "./canvas-history";
import { restoreCanvasUploadNodes } from "./canvas-page-utils";
import { CanvasHistoryEntry } from "./canvas-page-elements";

import type { CanvasPageState } from "./use-canvas-page-state";

export function useCanvasNavigationActions({ state }: { state: CanvasPageState }) {
    const siteTitle = usePublicSessionStore((current) => resolveSiteTitle(current.payload?.settings?.site?.title));
    const {
        message,
        router,
        projectId,
        historyRef,
        lastHistoryRef,
        historyCommitTimerRef,
        applyingHistoryRef,
        createProject,
        deleteProjects,
        nodes,
        setNodes,
        connections,
        setConnections,
        chatSessions,
        setChatSessions,
        activeChatId,
        setActiveChatId,
        setViewport,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setContextMenu,
        backgroundMode,
        setBackgroundMode,
        showImageInfo,
        setShowImageInfo,
        setHistoryState,
        nodesRef,
        connectionsRef,
        viewportRef,
    } = state;

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const locateCanvasNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const k = Math.min(1, Math.max(0.45, viewportRef.current.k));
            setSelectedNodeIds(new Set([nodeId]));
            setViewport({ x: size.width / 2 - (node.position.x + node.width / 2) * k, y: size.height / 2 - (node.position.y + node.height / 2) * k, k });
        },
        [size.height, size.width],
    );

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const readCurrentEntry = useCallback((): CanvasHistoryEntry => ({ nodes: nodesRef.current, connections: connectionsRef.current, chatSessions, activeChatId, backgroundMode, showImageInfo }), [activeChatId, backgroundMode, chatSessions, showImageInfo]);

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        // 撤销/重做恢复到没有内存任务的上传占位时，把它明确变成可重选文件的状态，绝不恢复成幽灵“上传中”；
        // 归一化后的快照同时写回 HEAD，恢复出来的屏幕状态不会被当成一次新的未提交编辑。
        const nodes = restoreCanvasUploadNodes(entry.nodes);
        const restoredEntry = nodes === entry.nodes ? entry : { ...entry, nodes };
        lastHistoryRef.current = restoredEntry;
        setNodes(nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    // 撤销/重做先把屏幕上还没提交的变化按语义边界提交进历史，再退回直接前态或前进到 future 顶
    const applyHistoryAction = useCallback(
        (action: "undo" | "redo") => {
            const transition = transitionCanvasHistory(historyRef.current, lastHistoryRef.current, readCurrentEntry(), action);
            if (!transition) return;
            historyRef.current = transition.timeline;
            lastHistoryRef.current = transition.head;
            setHistoryState({ canUndo: transition.timeline.past.length > 0, canRedo: transition.timeline.future.length > 0 });
            if (transition.entry) applyHistory(transition.entry);
        },
        [applyHistory, readCurrentEntry],
    );

    const undoCanvas = useCallback(() => applyHistoryAction("undo"), [applyHistoryAction]);

    const redoCanvas = useCallback(() => applyHistoryAction("redo"), [applyHistoryAction]);

    const createAndOpenProject = useCallback(async () => {
        try {
            const id = await createProject(`${siteTitle} 画布 ${useCanvasStore.getState().summaries.length + 1}`);
            router.push(`/canvas/${id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布创建失败");
        }
    }, [createProject, message, router, siteTitle]);

    const deleteCurrentProject = useCallback(async () => {
        try {
            await deleteProjects([projectId]);
            router.push("/canvas");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "画布删除失败");
        }
    }, [deleteProjects, message, projectId, router]);
    return {
        resetViewport,
        locateCanvasNode,
        setZoomScale,
        applyHistory,
        undoCanvas,
        redoCanvas,
        createAndOpenProject,
        deleteCurrentProject,
    };
}

export type CanvasNavigationActions = ReturnType<typeof useCanvasNavigationActions>;
