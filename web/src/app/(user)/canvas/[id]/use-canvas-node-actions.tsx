"use client";

import { nanoid } from "nanoid";
import { useCallback } from "react";

import { CanvasNodeType, type CanvasNodeData, type Position } from "../types";
import { resizeImageNodeToNaturalRatio } from "../utils/canvas-node-size";

import { createCanvasNode } from "./canvas-page-elements";
import { createCanvasNodeClipboard, createPastedCanvasNodes, type CanvasNodeClipboardPayload } from "./canvas-node-clipboard";
import { findFreeNodePosition, getGenerationCount } from "./canvas-page-utils";

import type { CanvasPageState } from "./use-canvas-page-state";

import type { CanvasInteractionCore } from "./use-canvas-interaction-core";

export function useCanvasNodeActions({ state, core }: { state: CanvasPageState; core: CanvasInteractionCore }) {
    const {
        clipboardRef,
        projectId,
        updateProject,
        flushProjectSave,
        effectiveConfig,
        nodes,
        setNodes,
        connections,
        setConnections,
        size,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setHoveredNodeId,
        setContextMenu,
        setRunningNodeId,
        setClearConfirmOpen,
        setToolbarNodeId,
        setDialogNodeId,
        setEditingNodeId,
        setEditRequestNonce,
        setInfoNodeId,
        setCropNodeId,
        setMaskEditNodeId,
        setAngleNodeId,
        setPreviewNodeId,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
    } = state;
    const { getCanvasCenter, cancelPendingConnectionCreate } = core;

    const createNode = useCallback(
        (type: CanvasNodeType, position?: Position) => {
            const targetPosition = position || findFreeNodePosition(nodesRef.current, getCanvasCenter(), type);
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type === CanvasNodeType.Text) {
                // 新建文字节点直接进入编辑态，DOM 挂载完成后由 editRequestNonce 聚焦。
                setEditingNodeId(newNode.id);
                setEditRequestNonce((value) => value + 1);
            } else if (type !== CanvasNodeType.Audio) {
                setDialogNodeId(newNode.id);
            }
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const deleteNodes = useCallback((ids: Set<string>) => {
        if (!ids.size) return;
        const allIds = new Set(ids);
        nodesRef.current.forEach((node) => {
            if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
        });
        setNodes((prev) => {
            const next = prev.filter((node) => !allIds.has(node.id));
            return next.map((node) => {
                const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                const primaryNode = next.find((item) => item.id === primaryImageId);
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        batchChildIds: childIds,
                        primaryImageId,
                        content: primaryNode?.metadata?.content || node.metadata.content,
                        naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                        naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                    },
                };
            });
        });
        setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
        setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
        setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
        setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
        setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
        setCropNodeId((current) => (current && allIds.has(current) ? null : current));
        setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
        setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
        setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
        setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
        setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
    }, []);

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const handleImageDimensions = useCallback((nodeId: string, naturalWidth: number, naturalHeight: number) => {
        setNodes((prev) => {
            let changed = false;
            const next = prev.map((node) => {
                if (node.id !== nodeId || node.type !== CanvasNodeType.Image) return node;
                const resized = resizeImageNodeToNaturalRatio(node, naturalWidth, naturalHeight);
                if (resized !== node) changed = true;
                return resized;
            });
            return changed ? next : prev;
        });
    }, []);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        updateProject(projectId, { nodes: [], connections: [] });
        void flushProjectSave(projectId);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
    }, [deselectCanvas, flushProjectSave, projectId, updateProject]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${nanoid()}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const payload = createCanvasNodeClipboard(nodesRef.current, connectionsRef.current, selectedNodeIdsRef.current);
        if (!payload) return null;
        clipboardRef.current = payload;
        return payload;
    }, []);

    const pasteCopiedNodes = useCallback(
        (payload: CanvasNodeClipboardPayload) => {
            if (!payload.nodes.length) return false;

            const pasted = createPastedCanvasNodes(payload, getCanvasCenter());

            setNodes((prev) => [...prev, ...pasted.nodes]);
            setConnections((prev) => [...prev, ...pasted.connections]);
            setSelectedNodeIds(new Set(pasted.nodes.map((node) => node.id)));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(pasted.nodes[0]?.id || null);
            return true;
        },
        [getCanvasCenter],
    );
    return {
        createNode,
        deleteNodes,
        deleteConnection,
        handleImageDimensions,
        deselectCanvas,
        clearCanvas,
        duplicateNode,
        copySelectedNodes,
        pasteCopiedNodes,
    };
}

export type CanvasNodeActions = ReturnType<typeof useCanvasNodeActions>;
