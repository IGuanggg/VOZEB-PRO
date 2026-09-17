import type { CanvasNodeData } from "../types";

import type { CanvasHistoryEntry } from "./canvas-page-elements";

/** 画布历史时间线：past 顶是 HEAD 的直接前态，future 顶是 HEAD 的直接后态。 */
export type CanvasHistoryTimeline = { past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] };

export type CanvasHistoryAction = "commit" | "undo" | "redo";

export type CanvasHistoryTransition = {
    timeline: CanvasHistoryTimeline;
    /** 转换后写入历史的 HEAD 快照；撤销/重做时就是要写回屏幕的快照。 */
    head: CanvasHistoryEntry;
    /** 需要写回屏幕的历史快照；纯提交（含重做被新编辑清空）时为 null。 */
    entry: CanvasHistoryEntry | null;
};

/** 语义操作边界状态：是否正在拖动节点、正在编辑的文本节点。 */
export type CanvasHistoryBoundary = { dragging: boolean; editingNodeId: string | null };

/** 屏幕变化进入历史的方式：语义边界立即提交 / 离散操作走合并窗口 / 只累积。 */
export type CanvasHistoryCommitPlan = "flush" | "schedule" | "hold";

/** 既有历史深度上限：past 最多保留 50 步。 */
export const CANVAS_HISTORY_PAST_LIMIT = 50;

/** 离散操作沿用的合并窗口，保持项目原有 180ms，不缩短也不新增延时。 */
export const CANVAS_HISTORY_MERGE_WINDOW_MS = 180;

/** 连线、会话、背景等非节点字段同引用。 */
function isSameCanvasHistoryFields(previous: CanvasHistoryEntry, next: CanvasHistoryEntry): boolean {
    return previous.connections === next.connections && previous.chatSessions === next.chatSessions && previous.activeChatId === next.activeChatId && previous.backgroundMode === next.backgroundMode && previous.showImageInfo === next.showImageInfo;
}

/** 节点、连线、会话等都以不可变替换更新，字段引用相同即代表同一屏幕状态。 */
export function isSameCanvasHistoryEntry(previous: CanvasHistoryEntry | null, next: CanvasHistoryEntry | null): boolean {
    return previous === next || Boolean(previous && next && previous.nodes === next.nodes && isSameCanvasHistoryFields(previous, next));
}

/** 把快照压入 past：重复快照不入栈，并保持 50 步上限。 */
function pushPast(past: CanvasHistoryEntry[], entry: CanvasHistoryEntry): CanvasHistoryEntry[] {
    if (isSameCanvasHistoryEntry(past[past.length - 1] ?? null, entry)) return past;
    return [...past.slice(-(CANVAS_HISTORY_PAST_LIMIT - 1)), entry];
}

/**
 * 历史状态转换的唯一入口。head 是最后写入历史的状态，current 是屏幕当前状态（可能还没提交）。
 * - commit：把未提交的当前状态提交成新的 HEAD，旧 HEAD 入 past，新编辑清空 future；
 * - undo：先把未提交的当前状态提交成新的 HEAD，再退回直接前态；
 * - redo：当前状态若是新编辑则先清空 future，否则前进到 future 顶并保存当前真实状态。
 * 返回 null 表示这次操作不改变历史（状态没变化，或没有可撤销/可重做的快照）。
 */
export function transitionCanvasHistory(timeline: CanvasHistoryTimeline, head: CanvasHistoryEntry | null, current: CanvasHistoryEntry, action: CanvasHistoryAction): CanvasHistoryTransition | null {
    if (!head) return null;
    const pending = !isSameCanvasHistoryEntry(head, current);

    if (action === "commit") {
        if (!pending) return null;
        return { timeline: { past: pushPast(timeline.past, head), future: [] }, head: current, entry: null };
    }

    if (action === "undo") {
        const past = pending ? pushPast(timeline.past, head) : timeline.past;
        const entry = past[past.length - 1];
        if (!entry) return null;
        return { timeline: { past: past.slice(0, -1), future: pending ? [current] : [...timeline.future, head] }, head: entry, entry };
    }

    if (pending) return { timeline: { past: pushPast(timeline.past, head), future: [] }, head: current, entry: null };
    const entry = timeline.future[timeline.future.length - 1];
    if (!entry) return null;
    return { timeline: { past: pushPast(timeline.past, head), future: timeline.future.slice(0, -1) }, head: entry, entry };
}

/** 拖动或文本编辑会话进行中：变化只累积，不按帧、也不按打字停顿拆成多步历史。 */
export function isCanvasHistorySessionActive(boundary: CanvasHistoryBoundary): boolean {
    return boundary.dragging || Boolean(boundary.editingNodeId);
}

/** 两个快照的非节点字段与节点逐个同引用，只允许节点数组本身不是同一个实例。 */
function isSameCanvasHistoryContent(previous: CanvasHistoryEntry, next: CanvasHistoryEntry): boolean {
    return isSameCanvasHistoryFields(previous, next) && previous.nodes.length === next.nodes.length && previous.nodes.every((node, index) => node === next.nodes[index]);
}

/**
 * 一次导入只占一步历史：异步回填（占位拿到成功结果或可重试的失败）并入发起导入的那一步。
 * - 已入栈快照只吸收这次尝试的媒体字段：快照自己的位置、尺寸、标题与其他用户修改都保留，
 *   否则回填会把用户后来的拖动/缩放写回过去，撤销拖动就失去原来的位置；
 * - HEAD 与屏幕只剩下节点数组实例的区别时直接对齐屏幕状态，回填因此不再新增撤销步；
 * - 期间的用户编辑不在这里处理，仍由调用方按语义边界/合并窗口提交，不会被回填吞并。
 * `isUploading` 是调用方判定的“还在等结果”的占位节点谓词，历史层不引入上传语义。
 */
export function settleCanvasHistoryUploads(
    timeline: CanvasHistoryTimeline,
    head: CanvasHistoryEntry | null,
    current: CanvasHistoryEntry,
    isUploading: (node: CanvasNodeData) => boolean,
): { timeline: CanvasHistoryTimeline; head: CanvasHistoryEntry | null } {
    const uploadingById = new Set((head?.nodes ?? []).filter(isUploading).map((node) => node.id));
    const results = new Map<string, CanvasNodeData>();
    current.nodes.forEach((node) => {
        if (uploadingById.has(node.id) && !isUploading(node)) results.set(node.id, node);
    });
    if (!results.size) return { timeline, head };

    const settleEntry = (entry: CanvasHistoryEntry, live: boolean) => {
        let changed = false;
        const nodes = entry.nodes.map((node) => {
            const result = results.get(node.id);
            if (!result || result === node || !isUploading(node)) return node;
            changed = true;
            // live 只用来判断“HEAD 是否已经等于屏幕状态”，真正写回历史的是只换 metadata 的版本。
            return live ? result : { ...node, metadata: result.metadata };
        });
        return changed ? { ...entry, nodes } : entry;
    };
    const settleEntries = (entries: CanvasHistoryEntry[]) => {
        let changed = false;
        const next = entries.map((entry) => {
            const settled = settleEntry(entry, false);
            if (settled !== entry) changed = true;
            return settled;
        });
        return changed ? next : entries;
    };

    const liveHead = head ? settleEntry(head, true) : null;
    const settledHead = head ? settleEntry(head, false) : null;
    return {
        timeline: { past: settleEntries(timeline.past), future: settleEntries(timeline.future) },
        head: liveHead && liveHead !== head && isSameCanvasHistoryContent(liveHead, current) ? current : settledHead,
    };
}

/**
 * 节点或连线的**身份**发生变化即为结构变化：新增、删除、粘贴、导入、连线增删。
 * 这类变化本身就是语义边界，应当各自成为一步历史，不能被合并窗口和后面的操作黏在一起。
 */
export function isStructuralCanvasHistoryChange(previous: CanvasHistoryEntry, next: CanvasHistoryEntry): boolean {
    if (previous.nodes.length !== next.nodes.length) return true;
    if (previous.connections.length !== next.connections.length) return true;
    const previousNodeIds = new Set(previous.nodes.map((node) => node.id));
    if (next.nodes.some((node) => !previousNodeIds.has(node.id))) return true;
    const previousConnectionIds = new Set(previous.connections.map((connection) => connection.id));
    return next.connections.some((connection) => !previousConnectionIds.has(connection.id));
}

/**
 * 决定屏幕上的变化怎么进历史：
 * - flush：跨越语义边界时立即提交——拖动开始/结束、文本编辑会话开始/切换/结束，
 *   以及**结构变化**（增删节点/连线）。同一 tick 内的批量导入只产生一次渲染，因此仍是一步。
 * - schedule：仅有内容/属性变化（打字、改配置、拖动中的位置）时，沿用原有 180ms 合并窗口，
 *   避免逐字产生历史；
 * - hold：没有变化，或正处在拖动/文本编辑会话中，等下一次边界或合并窗口再提交。
 */
export function planCanvasHistoryCommit(previous: CanvasHistoryBoundary, next: CanvasHistoryBoundary, change: { changed: boolean; structural: boolean }): CanvasHistoryCommitPlan {
    if (previous.dragging !== next.dragging || previous.editingNodeId !== next.editingNodeId) return "flush";
    if (isCanvasHistorySessionActive(next)) return "hold";
    if (change.structural) return "flush";
    return change.changed ? "schedule" : "hold";
}
