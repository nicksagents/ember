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

const COLOR_BY_TYPE: Record<string, string> = {
  identity: "rgba(0,245,255,0.9)",
  preference: "rgba(255,61,247,0.9)",
  workflow: "rgba(110,255,139,0.9)",
  project: "rgba(255,169,77,0.9)",
  reference: "rgba(157,77,255,0.9)",
  cluster: "rgba(255,255,255,0.9)",
};

const getColor = (type: string) =>
  COLOR_BY_TYPE[String(type || "").toLowerCase()] || "rgba(70,199,255,0.9)";

export function MemoryGraph({
  graph,
  onSelect,
}: {
  graph: MemoryGraphData;
  onSelect: (node: MemoryNode | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    nodes: Array<
      MemoryNode & { x: number; y: number; vx: number; vy: number; radius: number }
    >;
    links: Array<{ a: number; b: number; w: number }>;
    offsetX: number;
    offsetY: number;
    zoom: number;
    mouseX: number;
    mouseY: number;
    dragging: boolean;
    dragStartX: number;
    dragStartY: number;
    lastX: number;
    lastY: number;
    pulses?: Array<{ link: number; t: number; speed: number; size: number }>;
  }>({
    nodes: [],
    links: [],
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    mouseX: 0,
    mouseY: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    lastX: 0,
    lastY: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      canvas.width = canvas.clientWidth * window.devicePixelRatio;
      canvas.height = canvas.clientHeight * window.devicePixelRatio;
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const baseW = canvas.clientWidth;
    const baseH = canvas.clientHeight;
    const spread = Math.min(baseW, baseH) * 0.35;
    const centerX = baseW * 0.5;
    const centerY = baseH * 0.5;
    const nodes = graph.nodes.map((node) => ({
      ...node,
      x: centerX + (Math.random() - 0.5) * spread,
      y: centerY + (Math.random() - 0.5) * spread,
      vx: -0.5 + Math.random(),
      vy: -0.5 + Math.random(),
      radius: Math.max(1.5, Math.min(10, node.size * 3.2)),
    }));

    const nodeIndex = new Map<string, number>();
    nodes.forEach((n, i) => nodeIndex.set(n.id, i));
    const links = graph.links
      .map((link) => {
        const a = nodeIndex.get(link.source);
        const b = nodeIndex.get(link.target);
        if (a == null || b == null) return null;
        return { a, b, w: link.weight };
      })
      .filter(Boolean) as Array<{ a: number; b: number; w: number }>;

    stateRef.current.nodes = nodes;
    stateRef.current.links = links;
    stateRef.current.offsetX = 0;
    stateRef.current.offsetY = 0;
    stateRef.current.zoom = 1;

    const onMouseMove = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const state = stateRef.current;
      state.mouseX = x;
      state.mouseY = y;
      if (state.dragging) {
        state.offsetX = state.lastX + (x - state.dragStartX);
        state.offsetY = state.lastY + (y - state.dragStartY);
      }
    };

    const onMouseDown = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const state = stateRef.current;
      state.dragging = true;
      state.dragStartX = x;
      state.dragStartY = y;
      state.lastX = state.offsetX;
      state.lastY = state.offsetY;
    };

    const onMouseUp = () => {
      const state = stateRef.current;
      state.dragging = false;
    };

    const zoomAt = (x: number, y: number, delta: number) => {
      const state = stateRef.current;
      const prevZoom = state.zoom;
      const nextZoom = Math.min(2.4, Math.max(0.6, prevZoom + delta));
      if (nextZoom === prevZoom) return;
      const worldX = (x - state.offsetX) / prevZoom;
      const worldY = (y - state.offsetY) / prevZoom;
      state.zoom = nextZoom;
      state.offsetX = x - worldX * nextZoom;
      state.offsetY = y - worldY * nextZoom;
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const delta = Math.sign(event.deltaY) * -0.08;
      zoomAt(x, y, delta);
    };

    const onClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const state = stateRef.current;
      const zoom = state.zoom;
      const ox = state.offsetX;
      const oy = state.offsetY;
      const clicked = state.nodes.find((node) => {
        const dx = x - (node.x * zoom + ox);
        const dy = y - (node.y * zoom + oy);
        return Math.hypot(dx, dy) <= node.radius * zoom + 4;
      });
      onSelect(clicked || null);
    };

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("click", onClick);

    const touchState = { lastDist: 0 };
    const getTouchDistance = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.hypot(dx, dy);
    };
    const onTouchStart = (event: TouchEvent) => {
      const state = stateRef.current;
      if (event.touches.length === 1) {
        const rect = canvas.getBoundingClientRect();
        const x = event.touches[0].clientX - rect.left;
        const y = event.touches[0].clientY - rect.top;
        state.dragging = true;
        state.dragStartX = x;
        state.dragStartY = y;
        state.lastX = state.offsetX;
        state.lastY = state.offsetY;
      } else if (event.touches.length === 2) {
        touchState.lastDist = getTouchDistance(event.touches);
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      const state = stateRef.current;
      const rect = canvas.getBoundingClientRect();
      if (event.touches.length === 1) {
        const x = event.touches[0].clientX - rect.left;
        const y = event.touches[0].clientY - rect.top;
        if (state.dragging) {
          state.offsetX = state.lastX + (x - state.dragStartX);
          state.offsetY = state.lastY + (y - state.dragStartY);
        }
      } else if (event.touches.length === 2) {
        const dist = getTouchDistance(event.touches);
        const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left;
        const midY = (event.touches[0].clientY + event.touches[1].clientY) / 2 - rect.top;
        if (touchState.lastDist) {
          const delta = (dist - touchState.lastDist) * 0.002;
          zoomAt(midX, midY, delta);
        }
        touchState.lastDist = dist;
      }
    };
    const onTouchEnd = () => {
      const state = stateRef.current;
      state.dragging = false;
      touchState.lastDist = 0;
    };
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    let raf = 0;
    const animate = () => {
      const state = stateRef.current;
      const { nodes, links, mouseX, mouseY, offsetX, offsetY, zoom } = state;
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

      // Move nodes
      const pad = 24;
      nodes.forEach((node) => {
        node.x += node.vx * 0.2;
        node.y += node.vy * 0.2;
        if (node.x < pad) {
          node.x = pad;
          node.vx *= -1;
        }
        if (node.x > canvas.clientWidth - pad) {
          node.x = canvas.clientWidth - pad;
          node.vx *= -1;
        }
        if (node.y < pad) {
          node.y = pad;
          node.vy *= -1;
        }
        if (node.y > canvas.clientHeight - pad) {
          node.y = canvas.clientHeight - pad;
          node.vy *= -1;
        }
      });

      // Draw connections
      ctx.lineWidth = 0.6;
      const maxDistance = 240;
      const dense = nodes.length <= 280;
      const step = dense ? 1 : Math.ceil(nodes.length / 220);
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j += step) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist > maxDistance) continue;
          const alpha = Math.max(0.08, Math.min(0.5, (maxDistance - dist) / 240));
          ctx.strokeStyle = `rgba(246,255,122,${alpha})`;
          ctx.beginPath();
          ctx.moveTo(a.x * zoom + offsetX, a.y * zoom + offsetY);
          ctx.lineTo(b.x * zoom + offsetX, b.y * zoom + offsetY);
          ctx.stroke();
        }
      }

      // Electric pulses along related links (API links)
      if (!stateRef.current.pulses) {
        const pulseCount = Math.min(1000, links.length * 3);
        stateRef.current.pulses = Array.from({ length: pulseCount }, () => ({
          link: Math.floor(Math.random() * Math.max(1, links.length)),
          t: Math.random(),
          speed: 0.002 + Math.random() * 0.006,
          size: 1 + Math.random() * 2.2,
        }));
      }
      const pulses = stateRef.current.pulses as Array<{
        link: number;
        t: number;
        speed: number;
        size: number;
      }>;
      ctx.shadowBlur = 18;
      ctx.shadowColor = "rgba(120,240,255,0.9)";
      pulses.forEach((pulse) => {
        const link = links[pulse.link];
        if (!link) return;
        const a = nodes[link.a];
        const b = nodes[link.b];
        pulse.t += pulse.speed;
        if (pulse.t > 1) pulse.t = 0;
        const x = a.x + (b.x - a.x) * pulse.t;
        const y = a.y + (b.y - a.y) * pulse.t;
        ctx.beginPath();
        ctx.fillStyle = "rgba(145,230,255,0.95)";
        ctx.arc(x * zoom + offsetX, y * zoom + offsetY, pulse.size, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw dots
      nodes.forEach((node) => {
        const dx = mouseX - (node.x * zoom + offsetX);
        const dy = mouseY - (node.y * zoom + offsetY);
        const hover = Math.hypot(dx, dy) < node.radius * zoom * 1.6;
        const glow = ctx.createRadialGradient(
          node.x * zoom + offsetX,
          node.y * zoom + offsetY,
          0,
          node.x * zoom + offsetX,
          node.y * zoom + offsetY,
          node.radius * zoom * 6
        );
        glow.addColorStop(0, getColor(node.type));
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.beginPath();
        ctx.fillStyle = glow;
        ctx.globalAlpha = hover ? 0.9 : 0.65;
        ctx.arc(
          node.x * zoom + offsetX,
          node.y * zoom + offsetY,
          node.radius * zoom * 6,
          0,
          Math.PI * 2
        );
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.fillStyle = getColor(node.type);
        ctx.shadowBlur = hover ? 18 : 12;
        ctx.shadowColor = getColor(node.type);
        ctx.arc(
          node.x * zoom + offsetX,
          node.y * zoom + offsetY,
          node.radius * zoom * (hover ? 1.2 : 1),
          0,
          Math.PI * 2
        );
        ctx.fill();
      });

      raf = requestAnimationFrame(animate);
    };

    raf = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      cancelAnimationFrame(raf);
    };
  }, [graph, onSelect]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
