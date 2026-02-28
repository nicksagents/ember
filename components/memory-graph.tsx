"use client";

import { useEffect, useRef } from "react";

type MemoryNode = {
  id: string;
  content: string;
  type: string;
  tags: string[];
  confirmed: boolean;
  confidence: number;
  useCount: number;
  size: number;
  lastUsed: string | null;
};

type MemoryLink = { source: string; target: string; weight: number };

type MemoryGraphData = {
  nodes: MemoryNode[];
  links: MemoryLink[];
};

type RenderNode = MemoryNode & {
  x: number;
  y: number;
  z: number;
  radius: number;
  screenX: number;
  screenY: number;
  depthScale: number;
};

type RenderLink = { a: number; b: number; weight: number };

const COLOR_BY_TYPE: Record<string, [number, number, number]> = {
  identity: [248, 250, 252],
  preference: [251, 146, 60],
  workflow: [239, 68, 68],
  project: [253, 186, 116],
  reference: [161, 161, 170],
  cluster: [255, 237, 213],
};

function getColor(type: string) {
  return COLOR_BY_TYPE[String(type || "").toLowerCase()] || [251, 146, 60];
}

function getNodePosition(index: number, total: number, radius: number) {
  const t = total <= 1 ? 0.5 : index / (total - 1);
  const phi = Math.acos(1 - 2 * t);
  const theta = Math.PI * (1 + Math.sqrt(5)) * index;
  const x = Math.cos(theta) * Math.sin(phi);
  const y = Math.cos(phi);
  const z = Math.sin(theta) * Math.sin(phi);

  // Widen the cloud so it reads more like a brain/web than a sphere.
  const warpX = x * radius * 1.55;
  const warpY = y * radius * 0.92 * (1 - Math.min(0.35, Math.abs(x) * 0.22));
  const warpZ = z * radius * 1.18;

  return { x: warpX, y: warpY, z: warpZ };
}

export function MemoryGraph({
  graph,
  onSelect,
}: {
  graph: MemoryGraphData;
  onSelect: (node: MemoryNode | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    nodes: RenderNode[];
    links: RenderLink[];
    rotationY: number;
    rotationX: number;
    dragX: number;
    dragY: number;
    dragging: boolean;
    hoverIndex: number;
    pulses: Array<{ linkIndex: number; t: number; speed: number }>;
  }>({
    nodes: [],
    links: [],
    rotationY: 0,
    rotationX: -0.18,
    dragX: 0,
    dragY: 0,
    dragging: false,
    hoverIndex: -1,
    pulses: [],
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    const bounds = () => ({
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });

    const baseRadius = Math.min(bounds().width, bounds().height) * 0.26;
    const nodes: RenderNode[] = graph.nodes.map((node, index) => {
      const position = getNodePosition(index, Math.max(graph.nodes.length, 1), baseRadius);
      return {
        ...node,
        ...position,
        radius: Math.max(1.4, Math.min(6.6, node.size * 2.25)),
        screenX: 0,
        screenY: 0,
        depthScale: 1,
      };
    });

    const indexById = new Map<string, number>();
    nodes.forEach((node, index) => indexById.set(node.id, index));
    const links = graph.links
      .map((link) => {
        const a = indexById.get(link.source);
        const b = indexById.get(link.target);
        if (a == null || b == null) return null;
        return { a, b, weight: link.weight };
      })
      .filter(Boolean) as RenderLink[];

    stateRef.current.nodes = nodes;
    stateRef.current.links = links;
    stateRef.current.hoverIndex = -1;
    stateRef.current.pulses = Array.from({
      length: Math.min(80, Math.max(16, links.length * 2)),
    }).map(() => ({
      linkIndex: Math.floor(Math.random() * Math.max(links.length, 1)),
      t: Math.random(),
      speed: 0.003 + Math.random() * 0.005,
    }));

    const projectNode = (node: RenderNode) => {
      const { width, height } = bounds();
      const state = stateRef.current;
      const cosY = Math.cos(state.rotationY);
      const sinY = Math.sin(state.rotationY);
      const cosX = Math.cos(state.rotationX);
      const sinX = Math.sin(state.rotationX);

      const x1 = node.x * cosY - node.z * sinY;
      const z1 = node.x * sinY + node.z * cosY;
      const y2 = node.y * cosX - z1 * sinX;
      const z2 = node.y * sinX + z1 * cosX;

      const camera = Math.max(width, height) * 1.25;
      const perspective = camera / (camera - z2);

      node.depthScale = perspective;
      node.screenX = width * 0.5 + x1 * perspective + state.dragX;
      node.screenY = height * 0.52 + y2 * perspective + state.dragY;
    };

    const updateHover = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let hoverIndex = -1;
      let minDistance = Infinity;
      for (let i = 0; i < stateRef.current.nodes.length; i += 1) {
        const node = stateRef.current.nodes[i];
        const radius = node.radius * node.depthScale + 6;
        const distance = Math.hypot(x - node.screenX, y - node.screenY);
        if (distance <= radius && distance < minDistance) {
          hoverIndex = i;
          minDistance = distance;
        }
      }
      stateRef.current.hoverIndex = hoverIndex;
    };

    const onMouseMove = (event: MouseEvent) => {
      updateHover(event.clientX, event.clientY);
      if (!stateRef.current.dragging) return;
      stateRef.current.rotationY += event.movementX * 0.006;
      stateRef.current.rotationX = Math.max(
        -0.72,
        Math.min(0.72, stateRef.current.rotationX + event.movementY * 0.004)
      );
    };

    const onMouseDown = () => {
      stateRef.current.dragging = true;
    };

    const onMouseUp = () => {
      stateRef.current.dragging = false;
    };

    const onMouseLeave = () => {
      stateRef.current.dragging = false;
      stateRef.current.hoverIndex = -1;
    };

    const onClick = () => {
      const hovered = stateRef.current.hoverIndex;
      onSelect(hovered >= 0 ? stateRef.current.nodes[hovered] : null);
    };

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("click", onClick);

    let frameId = 0;
    const animate = () => {
      const { width, height } = bounds();
      const state = stateRef.current;

      if (!state.dragging) {
        state.rotationY += 0.0014;
      }

      ctx.clearRect(0, 0, width, height);

      const bg = ctx.createRadialGradient(
        width * 0.5,
        height * 0.45,
        40,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.72
      );
      bg.addColorStop(0, "rgba(22,22,22,0.9)");
      bg.addColorStop(0.5, "rgba(8,8,8,0.98)");
      bg.addColorStop(1, "rgba(3,3,3,1)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      for (let i = 0; i < state.nodes.length; i += 1) {
        projectNode(state.nodes[i]);
      }

      const sortedNodes = [...state.nodes].sort((a, b) => a.depthScale - b.depthScale);

      ctx.lineWidth = 0.75;
      for (const link of state.links) {
        const a = state.nodes[link.a];
        const b = state.nodes[link.b];
        const depth = (a.depthScale + b.depthScale) * 0.5;
        const alpha = Math.max(0.04, Math.min(0.18, link.weight * 0.18 * depth));
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.screenX, a.screenY);
        ctx.lineTo(b.screenX, b.screenY);
        ctx.stroke();
      }

      for (const pulse of state.pulses) {
        const link = state.links[pulse.linkIndex];
        if (!link) continue;
        const a = state.nodes[link.a];
        const b = state.nodes[link.b];
        pulse.t += pulse.speed;
        if (pulse.t > 1) pulse.t = 0;
        const x = a.screenX + (b.screenX - a.screenX) * pulse.t;
        const y = a.screenY + (b.screenY - a.screenY) * pulse.t;
        ctx.fillStyle = "rgba(251,146,60,0.9)";
        ctx.shadowBlur = 14;
        ctx.shadowColor = "rgba(251,146,60,0.75)";
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.shadowBlur = 0;
      for (const node of sortedNodes) {
        const [r, g, b] = getColor(node.type);
        const hover = state.hoverIndex >= 0 && state.nodes[state.hoverIndex]?.id === node.id;
        const glowRadius = node.radius * node.depthScale * (hover ? 7.2 : 5.8);

        const glow = ctx.createRadialGradient(
          node.screenX,
          node.screenY,
          0,
          node.screenX,
          node.screenY,
          glowRadius
        );
        glow.addColorStop(0, `rgba(${r},${g},${b},0.34)`);
        glow.addColorStop(0.35, `rgba(${r},${g},${b},0.14)`);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.screenX, node.screenY, glowRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(${r},${g},${b},${hover ? 1 : 0.9})`;
        ctx.shadowBlur = hover ? 18 : 10;
        ctx.shadowColor = `rgba(${r},${g},${b},0.7)`;
        ctx.beginPath();
        ctx.arc(
          node.screenX,
          node.screenY,
          node.radius * node.depthScale * (hover ? 1.3 : 1),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      frameId = requestAnimationFrame(animate);
    };

    frameId = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
      cancelAnimationFrame(frameId);
    };
  }, [graph, onSelect]);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full cursor-grab active:cursor-grabbing"
    />
  );
}
