import { afterEach, describe, expect, it, vi } from "vitest";

import { CanvasNodeType, type CanvasNodeData } from "../types";

import {
    CANVAS_HISTORY_MERGE_WINDOW_MS,
    CANVAS_HISTORY_PAST_LIMIT,
    isSameCanvasHistoryEntry,
    isStructuralCanvasHistoryChange,
    planCanvasHistoryCommit,
    recordCanvasUploadSettlement,
    settleCanvasHistoryUploads,
    transitionCanvasHistory,
    type CanvasHistoryBoundary,
    type CanvasHistoryTimeline,
} from "./canvas-history";

import type { CanvasHistoryEntry } from "./canvas-page-elements";

/** 与 canvas-page-utils 的 isCanvasUploading 同义：仍在等结果的上传占位节点。 */
function isUploading(node: CanvasNodeData) {
    return node.metadata?.status === "uploading";
}

function state(label: string): CanvasHistoryEntry {
    return {
        nodes: [{ id: `node-${label}`, type: CanvasNodeType.Text, title: label, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: label } }],
        connections: [],
        chatSessions: [],
        activeChatId: label,
        backgroundMode: "lines",
        showImageInfo: false,
    };
}

/** 结构变化：节点集合不同（增删/粘贴/导入）。 */
function nodesState(nodeIds: string[]): CanvasHistoryEntry {
    return {
        nodes: nodeIds.map((id) => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: id } })),
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: false,
    };
}

/** 仅位置变化：真实拖动是同一个节点、同一个集合。 */
function positionState(nodeId: string, x: number): CanvasHistoryEntry {
    return { ...nodesState([nodeId]), nodes: [{ id: nodeId, type: CanvasNodeType.Text, title: nodeId, position: { x, y: 0 }, width: 320, height: 180, metadata: { content: "拖动" } }] };
}

/** 仅内容变化：真实文字编辑是同一个节点、同一个集合。 */
function contentState(nodeId: string, content: string): CanvasHistoryEntry {
    return { ...nodesState([nodeId]), nodes: [{ id: nodeId, type: CanvasNodeType.Text, title: nodeId, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content } }] };
}

/** 仍在等结果的上传占位节点：一个导入批次里先出现的就是这种。 */
function uploadNode(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 240, height: 240, metadata: { status: "uploading" } };
}

/** 回填后的上传节点：保留永久 storageKey，这是撤销/重做必须恢复的结果。 */
function filledNode(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 240, height: 240, metadata: { status: "success", content: `/api/reference-assets/permanent/${id}.webp`, storageKey: `permanent/${id}.webp` } };
}

function textNode(content: string): CanvasNodeData {
    return { id: "node-text", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content } };
}

/** 上传场景的快照：只替换回填的那个节点对象，未变的节点与其余字段沿用同一引用（与真实不可变更新一致）。 */
const NO_CONNECTIONS: CanvasHistoryEntry["connections"] = [];
const NO_SESSIONS: CanvasHistoryEntry["chatSessions"] = [];
function uploadState(nodes: CanvasNodeData[]): CanvasHistoryEntry {
    return { nodes, connections: NO_CONNECTIONS, chatSessions: NO_SESSIONS, activeChatId: null, backgroundMode: "lines", showImageInfo: false };
}

function hasUploadingSnapshot(entry: CanvasHistoryEntry) {
    return entry.nodes.some(isUploading);
}

describe("Canvas history transitions", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("undoes to the direct predecessor and redoes the real current state while the latest edit is uncommitted", () => {
        vi.useFakeTimers();
        const a = state("A");
        const b = state("B");
        const c = state("C");
        // 历史里最后提交的是 B，屏幕已经变成 C，但提交还没发生
        const timeline: CanvasHistoryTimeline = { past: [a], future: [] };

        const undo = transitionCanvasHistory(timeline, b, c, "undo");

        expect(undo?.entry?.nodes[0]?.id).toBe("node-B");
        expect(undo?.head).toBe(b);
        expect(undo?.timeline.past[0]).toBe(a);
        expect(undo?.timeline.past).toHaveLength(1);
        expect(undo?.timeline.future[0]).toBe(c);

        vi.advanceTimersByTime(1000); // 事务边界与时间无关，时间流逝不改变结果
        expect(undo?.timeline.future[0]).toBe(c);

        const redo = transitionCanvasHistory(undo!.timeline, undo!.head, b, "redo");

        expect(redo?.entry?.nodes[0]?.id).toBe("node-C");
        expect(redo?.timeline.future).toHaveLength(0);
        expect(redo?.timeline.past.map((item) => item.nodes[0]?.id)).toEqual(["node-A", "node-B"]);
    });

    it("undoes the first edit even though the timeline was empty before it", () => {
        const s0 = state("S0");
        const s1 = state("S1");

        const transition = transitionCanvasHistory({ past: [], future: [] }, s0, s1, "undo");

        expect(transition?.entry).toBe(s0);
        expect(transition?.timeline.past).toHaveLength(0);
        expect(transition?.timeline.future[0]).toBe(s1);
        // 没有未提交变化、也没有历史时，撤销不产生任何转换
        expect(transitionCanvasHistory({ past: [], future: [] }, s0, s0, "undo")).toBeNull();
        expect(transitionCanvasHistory({ past: [], future: [] }, s0, s0, "redo")).toBeNull();
    });

    it("walks consecutive undo and redo steps in order", () => {
        const [s0, s1, s2] = ["S0", "S1", "S2"].map(state);
        let timeline: CanvasHistoryTimeline = { past: [s0, s1], future: [] };
        let head = s2;
        const undone: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const transition = transitionCanvasHistory(timeline, head, head, "undo");
            if (!transition?.entry) break;
            timeline = transition.timeline;
            head = transition.head;
            undone.push(transition.entry.nodes[0]!.id);
        }

        expect(undone).toEqual(["node-S1", "node-S0"]);
        expect(timeline.past).toHaveLength(0);

        const redone: string[] = [];
        for (let index = 0; index < 3; index += 1) {
            const transition = transitionCanvasHistory(timeline, head, head, "redo");
            if (!transition?.entry) break;
            timeline = transition.timeline;
            head = transition.head;
            redone.push(transition.entry.nodes[0]!.id);
        }

        expect(redone).toEqual(["node-S1", "node-S2"]);
        expect(head).toBe(s2);
        expect(timeline.future).toHaveLength(0);
    });

    it("clears the redo stack when a new edit lands after an undo", () => {
        const [s0, s1, s2, s3] = ["S0", "S1", "S2", "S3"].map(state);

        const undone = transitionCanvasHistory({ past: [s0], future: [] }, s1, s2, "undo")!;

        expect(undone.entry).toBe(s1);
        expect(undone.timeline.future[0]).toBe(s2);

        const reedited = transitionCanvasHistory(undone.timeline, undone.head, s3, "commit")!;

        expect(reedited.head).toBe(s3);
        expect(reedited.timeline.future).toHaveLength(0);
        expect(reedited.timeline.past[reedited.timeline.past.length - 1]).toBe(s1);
        expect(transitionCanvasHistory(reedited.timeline, reedited.head, s3, "redo")).toBeNull();

        // 未提交的新编辑先清空 redo 栈，重做因此不会回到被放弃的快照
        const pendingRedo = transitionCanvasHistory(undone.timeline, undone.head, s3, "redo")!;

        expect(pendingRedo.entry).toBeNull();
        expect(pendingRedo.head).toBe(s3);
        expect(pendingRedo.timeline.future).toHaveLength(0);
        expect(pendingRedo.timeline.past[pendingRedo.timeline.past.length - 1]).toBe(s1);
    });

    it("keeps at most 50 past snapshots and stops the undo chain at the oldest retained one", () => {
        const states = Array.from({ length: CANVAS_HISTORY_PAST_LIMIT + 11 }, (_, index) => state(`S${index}`));
        let timeline: CanvasHistoryTimeline = { past: [], future: [] };
        let head = states[0]!;
        for (const next of states.slice(1)) {
            const transition = transitionCanvasHistory(timeline, head, next, "commit")!;
            timeline = transition.timeline;
            head = transition.head;
        }

        expect(head).toBe(states[states.length - 1]);
        expect(timeline.past).toHaveLength(CANVAS_HISTORY_PAST_LIMIT);
        expect(timeline.past[0]).toBe(states[states.length - CANVAS_HISTORY_PAST_LIMIT - 1]);
        expect(timeline.past[CANVAS_HISTORY_PAST_LIMIT - 1]).toBe(states[states.length - 2]);

        let steps = 0;
        for (;;) {
            const transition = transitionCanvasHistory(timeline, head, head, "undo");
            if (!transition) break;
            timeline = transition.timeline;
            head = transition.head;
            steps += 1;
        }

        expect(steps).toBe(CANVAS_HISTORY_PAST_LIMIT);
        expect(head).toBe(states[states.length - CANVAS_HISTORY_PAST_LIMIT - 1]);
    });

    it("treats the same screen state as one history step and schedules no timers", () => {
        vi.useFakeTimers();
        const a = state("A");
        const b = state("B");

        expect(isSameCanvasHistoryEntry(null, a)).toBe(false);
        expect(isSameCanvasHistoryEntry(a, { ...a })).toBe(true);
        expect(isSameCanvasHistoryEntry(a, b)).toBe(false);
        expect(transitionCanvasHistory({ past: [], future: [] }, a, a, "commit")).toBeNull();

        const pending = transitionCanvasHistory({ past: [a], future: [] }, a, b, "commit")!;

        expect(pending.timeline.past).toHaveLength(1);
        expect(pending.timeline.past[0]).toBe(a);
        expect(pending.head).toBe(b);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("Canvas history commit scheduling", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("plans an immediate commit on semantic boundaries, structural changes and the merge window for content edits", () => {
        const idle: CanvasHistoryBoundary = { dragging: false, editingNodeId: null };
        const dragging: CanvasHistoryBoundary = { dragging: true, editingNodeId: null };
        const editing: CanvasHistoryBoundary = { dragging: false, editingNodeId: "node-text" };

        expect(planCanvasHistoryCommit(idle, dragging, { changed: false, structural: false })).toBe("flush");
        expect(planCanvasHistoryCommit(dragging, idle, { changed: true, structural: false })).toBe("flush");
        expect(planCanvasHistoryCommit(idle, editing, { changed: true, structural: false })).toBe("flush");
        expect(planCanvasHistoryCommit(editing, idle, { changed: true, structural: false })).toBe("flush");
        expect(planCanvasHistoryCommit(dragging, dragging, { changed: true, structural: false })).toBe("hold");
        expect(planCanvasHistoryCommit(editing, editing, { changed: true, structural: false })).toBe("hold");
        expect(planCanvasHistoryCommit(idle, idle, { changed: false, structural: false })).toBe("hold");
        expect(planCanvasHistoryCommit(idle, idle, { changed: true, structural: false })).toBe("schedule");
        // 增删节点/连线本身就是语义边界，不等待合并窗口。
        expect(planCanvasHistoryCommit(idle, idle, { changed: true, structural: true })).toBe("flush");
    });

    it("commits structural changes immediately so two separate operations stay two undo steps", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const empty = nodesState([]);
        const one = nodesState(["node-a"]);
        const two = nodesState(["node-a", "node-b"]);
        harness.load(empty);

        harness.change(one);
        harness.change(two); // 不等待合并窗口
        expect(harness.timeline().past).toHaveLength(2);

        expect(harness.undo()).toBe(one); // 第一次撤销只撤掉第二个节点
        expect(harness.undo()).toBe(empty);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps two independent node deletions as two undo steps", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = nodesState(["node-a", "node-b"]);
        const afterDeleteA = nodesState(["node-b"]);
        const afterDeleteB = nodesState([]);
        harness.load(loaded);

        harness.change(afterDeleteA);
        harness.change(afterDeleteB);

        expect(harness.timeline().past).toHaveLength(2);
        expect(harness.undo()).toBe(afterDeleteA); // 第一次撤销只恢复最后一次删除
        expect(harness.undo()).toBe(loaded); // 再撤销才回到更早状态
    });

    it("merges a continuous drag with many node updates into a single history step", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = positionState("node-a", 0);
        const moved = positionState("node-a", 120);
        harness.load(loaded);

        harness.change(loaded, { dragging: true }); // 按下节点：语义边界，此时还没有位置变化
        harness.change(positionState("node-a", 40), { dragging: true }); // 拖动中的多次更新只累积，不按帧拆步
        harness.change(positionState("node-a", 80), { dragging: true });
        harness.change(moved, { dragging: true });
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);
        expect(harness.timeline().past).toHaveLength(0);
        harness.change(moved, { dragging: false }); // 松开节点：边界提交整段拖动

        expect(harness.timeline().past).toHaveLength(1);
        expect(harness.timeline().past[0]).toBe(loaded);
        expect(vi.getTimerCount()).toBe(0);
        expect(harness.undo()).toBe(loaded);
    });

    it("merges a whole text editing session into a single history step", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = contentState("node-a", "原文");
        const edited = contentState("node-a", "原文改好");
        harness.load(loaded);

        harness.change(loaded, { editingNodeId: "node-a" }); // 进入文本编辑：语义边界，此时还没有输入
        harness.change(contentState("node-a", "原文改"), { editingNodeId: "node-a" }); // 编辑会话中的多次输入只累积
        harness.change(edited, { editingNodeId: "node-a" });
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 5);
        expect(harness.timeline().past).toHaveLength(0);
        harness.change(edited, { editingNodeId: null }); // 退出编辑会话：边界提交整段编辑

        expect(harness.timeline().past).toHaveLength(1);
        expect(harness.timeline().past[0]).toBe(loaded);
        expect(harness.undo()).toBe(loaded);
    });

    it("commits the live screen state when the merge window fires", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const loaded = contentState("node-a", "原文");
        harness.load(loaded);

        harness.change(contentState("node-a", "第一次输入")); // 合并窗口开始
        harness.change(contentState("node-a", "第二次输入")); // 窗口重新计算，只提交窗口内的最终状态
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS);

        expect(harness.timeline().past[0]).toBe(loaded);
        expect(harness.undo()).toBe(loaded); // 迟到的合并窗口提交不会把过期快照写回历史
    });
});

/**
 * R2 回归：一次导入（占位创建 + 各文件异步回填）在历史里只占一步。
 * 回填结果写回导入那一步，撤销/重做拿到的是已完成的永久媒体，而不是没有内存任务的“上传中”。
 */
describe("Canvas history upload settle", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    /** 一次导入 A/B：占位先出现，随后按给定顺序回填。 */
    function uploadScenario() {
        const empty = uploadState([]);
        const pending = uploadState([uploadNode("image-a"), uploadNode("image-b")]);
        const afterA = uploadState([filledNode("image-a"), pending.nodes[1]!]);
        const afterB = uploadState([afterA.nodes[0]!, filledNode("image-b")]);
        return { empty, pending, afterA, afterB };
    }

    it("keeps a drag undo step when upload completes before pointerup", () => {
        const harness = createCommitHarness();
        const empty = uploadState([]);
        const initial = uploadState([uploadNode("image-a")]);
        const moving = uploadState([{ ...initial.nodes[0]!, position: { x: 200, y: 0 } }]);
        const media = { status: "success" as const, content: "/api/reference-assets/permanent/image-a.webp", storageKey: "permanent/image-a.webp" };
        const finished = uploadState([{ ...moving.nodes[0]!, metadata: media }]);
        recordCanvasUploadSettlement(finished.nodes[0]!, (node) => ({ ...node, metadata: media }));

        harness.load(empty);
        harness.change(initial);
        harness.change(initial, { dragging: true });
        harness.change(moving, { dragging: true });
        harness.change(finished, { dragging: true });
        harness.change(finished, { dragging: false });

        const beforeMove = harness.undo();
        expect(beforeMove?.nodes[0]?.position.x).toBe(0);
        expect(beforeMove?.nodes[0]?.metadata?.storageKey).toBe(media.storageKey);
        expect(harness.redo()?.nodes[0]?.position.x).toBe(200);
        expect(harness.undo()?.nodes[0]?.position.x).toBe(0);
        expect(harness.undo()?.nodes).toHaveLength(0);
    });

    it("settles each finished file into the import step instead of creating undo steps", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const { empty, pending, afterA, afterB } = uploadScenario();
        harness.load(empty);

        harness.change(pending); // 占位创建：结构变化，导入本身成为一步
        expect(harness.timeline().past).toHaveLength(1);

        harness.change(afterA); // A 先回填并超过合并窗口
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);
        expect(harness.timeline().past).toHaveLength(1);

        harness.change(afterB); // B 再回填
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);
        expect(harness.timeline().past).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);

        // 一次撤销就完整撤回这次导入，且不会退回带“上传中”的占位快照。
        const undo = harness.undo();
        expect(undo).toBe(empty);
        expect(harness.timeline().future).toHaveLength(1);
        expect(hasUploadingSnapshot(harness.timeline().future[0]!)).toBe(false);
    });

    it("keeps B→A completion order on the same single undo step", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const empty = uploadState([]);
        const pending = uploadState([uploadNode("image-a"), uploadNode("image-b")]);
        // 返回顺序互换：B 先成功、A 后成功，历史结果必须与 A→B 一致。
        const afterB = uploadState([pending.nodes[0]!, filledNode("image-b")]);
        const afterBoth = uploadState([filledNode("image-a"), afterB.nodes[1]!]);
        harness.load(empty);

        harness.change(pending);
        harness.change(afterB);
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);
        harness.change(afterBoth);
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);

        expect(harness.timeline().past).toHaveLength(1);
        expect(harness.undo()).toBe(empty);
    });

    it("keeps adjacent completions in the same tick on the same single step", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const empty = uploadState([]);
        const pending = uploadState([uploadNode("image-a"), uploadNode("image-b")]);
        const both = uploadState([filledNode("image-a"), filledNode("image-b")]);
        harness.load(empty);

        harness.change(pending);
        harness.change(both); // 两个文件在同一 tick 回填：一次渲染

        expect(harness.timeline().past).toHaveLength(1);
        expect(harness.undo()).toBe(empty);
    });

    it("keeps redo on the finished permanent media instead of a task-less uploading placeholder", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const { empty, pending, afterA, afterB } = uploadScenario();
        harness.load(empty);

        harness.change(pending);
        harness.change(afterA);
        harness.change(afterB);
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);

        expect(harness.undo()).toBe(empty);

        // 重做必须回到已完成的永久媒体：既不是占位，也不需要重新上传。
        const redo = harness.redo();
        expect(redo).toBe(afterB);
        expect(redo?.nodes.map((node) => node.metadata?.storageKey)).toEqual(["permanent/image-a.webp", "permanent/image-b.webp"]);
        expect(hasUploadingSnapshot(redo!)).toBe(false);
    });

    it("settles only the media fields so a dragged placeholder keeps its own history", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const placeholder = uploadNode("image-a"); // 占位节点在 x=0
        const initial = uploadState([placeholder]);
        const movedPlaceholder = { ...placeholder, position: { x: 200, y: 0 } };
        const dragged = uploadState([movedPlaceholder]);
        const finished = uploadState([{ ...movedPlaceholder, metadata: { status: "success", content: "/api/reference-assets/permanent/image-a.webp", storageKey: "permanent/image-a.webp" } }]);
        harness.load(uploadState([]));

        harness.change(initial); // 导入：一步
        harness.change(initial, { dragging: true }); // 按下节点
        harness.change(dragged, { dragging: true }); // 拖动中只累积
        harness.change(dragged, { dragging: false }); // 松开：拖动成一步
        expect(harness.timeline().past).toHaveLength(2);

        harness.change(finished); // 上传成功：并入导入那一步，不新增撤销步也不改旧快照
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);
        expect(harness.timeline().past).toHaveLength(2);

        // 撤销拖动：位置回到 0，同时拿到这次上传的永久媒体结果。
        const undo = harness.undo();
        expect(undo?.nodes[0]?.position).toEqual({ x: 0, y: 0 });
        expect(undo?.nodes[0]?.metadata?.storageKey).toBe("permanent/image-a.webp");
        expect(undo?.nodes[0]?.metadata?.status).toBe("success");
        expect(hasUploadingSnapshot(undo!)).toBe(false);
    });

    it("does not swallow an independent text edit made while the import is still uploading", () => {
        vi.useFakeTimers();
        const harness = createCommitHarness();
        const base = uploadState([textNode("原文")]);
        // 导入只追加占位：既有文字节点保持同一引用，符合真实不可变更新。
        const pending = uploadState([base.nodes[0]!, uploadNode("image-a"), uploadNode("image-b")]);
        const edited = textNode("原文改");
        const afterEdit = uploadState([edited, pending.nodes[1]!, pending.nodes[2]!]);
        const filledA = filledNode("image-a");
        const filledB = filledNode("image-b");
        harness.load(base);

        harness.change(pending); // 导入：一步
        harness.change(afterEdit); // 上传期间的独立文字编辑
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS); // 文字编辑按合并窗口各自成步
        harness.change(uploadState([edited, filledA, pending.nodes[2]!])); // A 回填并入导入那一步
        harness.change(uploadState([edited, filledA, filledB])); // B 回填并入导入那一步
        vi.advanceTimersByTime(CANVAS_HISTORY_MERGE_WINDOW_MS * 3);

        // 第一次撤销只退回文字编辑：正文恢复成原文，导入的图片和永久 storageKey 都保留。
        const first = harness.undo();
        expect(first?.nodes.map((node) => node.metadata?.content)).toEqual(["原文", "/api/reference-assets/permanent/image-a.webp", "/api/reference-assets/permanent/image-b.webp"]);
        expect(first?.nodes.some((node) => node.metadata?.content === "原文改")).toBe(false);
        expect(hasUploadingSnapshot(first!)).toBe(false);

        // 第二次撤销才完整撤回导入，正文回到最初。
        const second = harness.undo();
        expect(second).toBe(base);
        expect(hasUploadingSnapshot(second!)).toBe(false);
    });
});

/**
 * 与 use-canvas-persistence-effects 相同的提交调度循环：提交时机由真实的 planCanvasHistoryCommit /
 * transitionCanvasHistory 决定，先按真实实现结算上传回填，离散操作走 180ms 合并窗口，语义边界立即提交。
 * 仓库没有 @testing-library，React effect 本身不在 vitest 里执行，这里只回归这套调度契约。
 */
function createCommitHarness() {
    let timeline: CanvasHistoryTimeline = { past: [], future: [] };
    let head: CanvasHistoryEntry | null = null;
    let screen: CanvasHistoryEntry | null = null;
    let boundary: CanvasHistoryBoundary = { dragging: false, editingNodeId: null };
    let timer: ReturnType<typeof setTimeout> | null = null;

    const commitPending = () => {
        const transition = transitionCanvasHistory(timeline, head, screen!, "commit");
        if (!transition) return;
        timeline = transition.timeline;
        head = transition.head;
    };

    return {
        load(entry: CanvasHistoryEntry) {
            head = entry;
            screen = entry;
        },
        change(entry: CanvasHistoryEntry, next: Partial<CanvasHistoryBoundary> = {}) {
            const nextBoundary = { ...boundary, ...next };
            // 与真实 effect 相同：先结算上传回填，再按结算后的 HEAD 规划这次变化
            const settled = settleCanvasHistoryUploads(timeline, head, entry, isUploading);
            timeline = settled.timeline;
            head = settled.head;
            const plan = planCanvasHistoryCommit(boundary, nextBoundary, { changed: !isSameCanvasHistoryEntry(head, entry), structural: Boolean(head) && isStructuralCanvasHistoryChange(head!, entry) });
            boundary = nextBoundary;
            screen = entry;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (plan === "flush") commitPending();
            if (plan === "schedule")
                timer = setTimeout(() => {
                    timer = null;
                    commitPending();
                }, CANVAS_HISTORY_MERGE_WINDOW_MS);
        },
        undo() {
            const transition = transitionCanvasHistory(timeline, head, screen!, "undo");
            if (!transition) return null;
            timeline = transition.timeline;
            head = transition.head;
            screen = transition.entry ?? transition.head;
            return transition.entry;
        },
        redo() {
            const transition = transitionCanvasHistory(timeline, head, screen!, "redo");
            if (!transition) return null;
            timeline = transition.timeline;
            head = transition.head;
            screen = transition.entry ?? transition.head;
            return transition.entry;
        },
        timeline: () => timeline,
    };
}
