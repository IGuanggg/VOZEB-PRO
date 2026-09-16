import { describe, expect, it } from "vitest";

import { getNodeSpec } from "../constants";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { findFreeNodePosition } from "./canvas-page-utils";

function placedNode(id: string, center: { x: number; y: number }, type = CanvasNodeType.Text): CanvasNodeData {
    const spec = getNodeSpec(type);
    return {
        id,
        type,
        title: id,
        position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
        width: spec.width,
        height: spec.height,
        metadata: { content: "", status: "idle" },
    };
}

function placeSequence(count: number, initial: CanvasNodeData[] = []) {
    const nodes = [...initial];
    const centers: { x: number; y: number }[] = [];
    for (let index = 0; index < count; index += 1) {
        const center = findFreeNodePosition(nodes, { x: 0, y: 0 }, CanvasNodeType.Text);
        centers.push(center);
        nodes.push(placedNode(`text-${index}`, center));
    }
    return centers;
}

describe("连续新建节点的落点避让", () => {
    it("空白画布上尊重画布中心点", () => {
        expect(findFreeNodePosition([], { x: 120, y: -80 }, CanvasNodeType.Text)).toEqual({ x: 120, y: -80 });
    });

    it("中心点已被已有节点完全盖住时按固定步长阶梯偏移", () => {
        const existing = placedNode("text-existing", { x: 0, y: 0 });
        const position = findFreeNodePosition([existing], { x: 0, y: 0 }, CanvasNodeType.Text);

        expect(position).not.toEqual({ x: 0, y: 0 });
        expect(position.x).toBeGreaterThan(0);
        expect(position.y).toBeGreaterThan(0);
    });

    it("连续新建三次得到三个互不相同的落点，不再完全堆叠", () => {
        const centers = placeSequence(3);
        expect(new Set(centers.map((center) => `${center.x},${center.y}`)).size).toBe(3);
        expect(centers[0]).toEqual({ x: 0, y: 0 });
    });

    it("偏移是简单可预期的等步长阶梯，不是随机值", () => {
        const centers = placeSequence(2);
        expect(centers[1]).toEqual({ x: centers[0].x + 48, y: centers[0].y + 48 });
    });

    it("部分重叠的已有节点不会被反复避让", () => {
        const overlapping = placedNode("text-offset", { x: 200, y: 200 });
        expect(findFreeNodePosition([overlapping], { x: 0, y: 0 }, CanvasNodeType.Text)).toEqual({ x: 0, y: 0 });
    });

    it("已有节点不属于同类型尺寸时也能正确避让", () => {
        const bigImage = placedNode("image-big", { x: 0, y: 0 }, CanvasNodeType.Image);
        expect(findFreeNodePosition([bigImage], { x: 0, y: 0 }, CanvasNodeType.Text)).not.toEqual({ x: 0, y: 0 });
    });
});
