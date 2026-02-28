"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface EmberEyeProps {
  className?: string;
  isTyping?: boolean;
  isThinking?: boolean;
}

type Dust = {
  x: number;
  y: number;
  ox: number;
  oy: number;
  speed: number;
};

type MotionState = {
  leftLookX: number;
  leftLookY: number;
  rightLookX: number;
  rightLookY: number;
  lookX: number;
  lookY: number;
  blink: number;
  shimmer: number;
};

const DUST_COUNT = 34;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function resetDust(dust: Dust) {
  dust.x = 0.5;
  dust.y = 0.5;
  dust.ox = 0.5;
  dust.oy = 0.5;
}

function createDust(seedOffset: number): Dust {
  return {
    x: 0.5,
    y: 0.5,
    ox: 0.5,
    oy: 0.5,
    speed: 0.0018 + Math.random() * 0.0036 + seedOffset * 0.00015,
  };
}

function renderIris(
  canvas: HTMLCanvasElement | null,
  dusts: Dust[],
  time: number,
  lookX: number,
  lookY: number,
  isThinking: boolean,
  phaseOffset: number
) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const size = Math.max(1, Math.floor(rect.width));
  const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const targetSize = Math.max(1, Math.floor(size * ratio));

  if (canvas.width !== targetSize || canvas.height !== targetSize) {
    canvas.width = targetSize;
    canvas.height = targetSize;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();

  const gradient = ctx.createRadialGradient(
    size * 0.42 + lookX * 4,
    size * 0.38 + lookY * 4,
    size * 0.05,
    size / 2,
    size / 2,
    size * 0.56
  );
  gradient.addColorStop(0, "rgba(245,232,212,0.96)");
  gradient.addColorStop(0.18, "rgba(252,179,82,0.95)");
  gradient.addColorStop(0.42, "rgba(238,103,34,0.94)");
  gradient.addColorStop(0.72, "rgba(119,24,12,0.95)");
  gradient.addColorStop(1, "rgba(0,0,0,0.97)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  ctx.lineCap = "round";
  const spokeCount = 28;
  for (let index = 0; index < spokeCount; index += 1) {
    const angle =
      (index / spokeCount) * Math.PI * 2 + time * 0.00028 + phaseOffset;
    const inner = size * (0.14 + ((index % 4) * 0.008));
    const outer = size * (0.48 + ((index % 3) * 0.014));
    ctx.beginPath();
    ctx.moveTo(
      size / 2 + Math.cos(angle) * inner,
      size / 2 + Math.sin(angle) * inner
    );
    ctx.lineTo(
      size / 2 + Math.cos(angle) * outer,
      size / 2 + Math.sin(angle) * outer
    );
    ctx.strokeStyle =
      index % 4 === 0 ? "rgba(255,243,225,0.2)" : "rgba(21,5,2,0.22)";
    ctx.lineWidth = 0.6 + (index % 4) * 0.25;
    ctx.stroke();
  }

  ctx.strokeStyle = isThinking
    ? "rgba(255,241,218,0.2)"
    : "rgba(10,2,1,0.12)";
  for (const dust of dusts) {
    dust.ox = dust.x;
    dust.oy = dust.y;
    const angle =
      Math.sin(time * 0.001 + dust.speed * 420 + phaseOffset) * Math.PI +
      Math.random() * Math.PI * 2;
    dust.x += Math.cos(angle) * dust.speed;
    dust.y += Math.sin(angle) * dust.speed;
    const dx = dust.x - 0.5;
    const dy = dust.y - 0.5;
    if (Math.hypot(dx, dy) > 0.48) {
      resetDust(dust);
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(dust.ox * size, dust.oy * size);
    ctx.lineTo(dust.x * size, dust.y * size);
    ctx.lineWidth = 0.35 + (1 - Math.hypot(dx, dy) / 0.48) * 1.1;
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.arc(size * 0.34, size * 0.28, size * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.beginPath();
  ctx.arc(size * 0.25, size * 0.2, size * 0.042, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function EyeOrb({
  eyeRef,
  canvasRef,
  lookX,
  lookY,
  blink,
  shimmer,
  isTyping,
  isThinking,
  phaseOffset,
}: {
  eyeRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  lookX: number;
  lookY: number;
  blink: number;
  shimmer: number;
  isTyping: boolean;
  isThinking: boolean;
  phaseOffset: number;
}) {
  const lidHeight = `${8 + blink * 42}%`;
  const irisShiftX = lookX * 13;
  const irisShiftY = lookY * 11;
  const pupilShiftX = lookX * 24;
  const pupilShiftY = lookY * 20;
  const pupilScale = isThinking ? 0.92 : isTyping ? 0.84 : 0.88;

  return (
    <div
      ref={eyeRef}
      className="relative h-[44px] w-[44px] overflow-hidden rounded-full border border-white/8 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.18),rgba(255,255,255,0.03)_34%,rgba(0,0,0,0.82)_82%)]"
    >
      <div className="absolute inset-[5%] rounded-full bg-[radial-gradient(circle_at_48%_40%,rgba(223,218,208,0.96),rgba(202,197,188,0.94)_46%,rgba(161,157,150,0.85)_72%,rgba(22,22,22,0.9)_100%)]" />
      <div className="absolute inset-[15%] rounded-full bg-[radial-gradient(circle_at_48%_44%,rgba(255,255,255,0.08),rgba(255,255,255,0.03)_34%,rgba(0,0,0,0.28)_100%)]" />

      <div
        className="absolute left-1/2 top-1/2 h-[54%] w-[54%] rounded-full border border-black/25 shadow-[0_0_0_1px_rgba(255,255,255,0.03),inset_0_0_20px_rgba(0,0,0,0.36)]"
        style={{
          transform: `translate(calc(-50% + ${irisShiftX}px), calc(-50% + ${irisShiftY}px))`,
        }}
      >
        <div className="absolute inset-0 overflow-hidden rounded-full">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full rounded-full opacity-95"
          />
        </div>
        <div
          className="absolute left-1/2 top-1/2 h-[44%] w-[44%] rounded-full bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_0_18px_rgba(0,0,0,0.78)]"
          style={{
            transform: `translate(calc(-50% + ${pupilShiftX * 0.34}px), calc(-50% + ${pupilShiftY * 0.34}px)) scale(${pupilScale})`,
          }}
        />
        <div
          className="absolute inset-0 rounded-full"
          style={{
            boxShadow: `inset 0 0 ${14 + shimmer * 6}px rgba(255,255,255,${0.05 + shimmer * 0.1})`,
          }}
        />
      </div>

      <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_32%_26%,rgba(255,255,255,0.22),transparent_18%),radial-gradient(circle_at_70%_74%,rgba(255,255,255,0.05),transparent_16%)]" />
      <div
        className="absolute inset-x-0 top-0 rounded-b-[100%] bg-[linear-gradient(180deg,rgba(8,8,8,0.98),rgba(16,16,16,0.9))]"
        style={{ height: lidHeight }}
      />
      <div
        className="absolute inset-x-0 bottom-0 rounded-t-[100%] bg-[linear-gradient(180deg,rgba(16,16,16,0.9),rgba(8,8,8,0.98))]"
        style={{ height: lidHeight }}
      />
      <div
        className="absolute left-[16%] top-[10%] h-[12%] w-[44%] rounded-full bg-white/10 blur-md"
        style={{ transform: `rotate(${phaseOffset * 6}deg)` }}
      />
    </div>
  );
}

export function EmberEye({
  className,
  isTyping = false,
  isThinking = false,
}: EmberEyeProps) {
  const leftEyeRef = useRef<HTMLDivElement>(null);
  const rightEyeRef = useRef<HTMLDivElement>(null);
  const leftCanvasRef = useRef<HTMLCanvasElement>(null);
  const rightCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({
    x: 0,
    y: 0,
    active: false,
    lastMoveAt: 0,
  });
  const motionRef = useRef({
    leftLookX: 0,
    leftLookY: 0,
    rightLookX: 0,
    rightLookY: 0,
    lookX: 0,
    lookY: 0,
    blink: 0,
    nextBlinkAt: 0,
    blinkState: "idle" as "idle" | "closing" | "opening",
    holdUntil: 0,
    phase: Math.random() * Math.PI * 2,
  });
  const leftDustsRef = useRef<Dust[]>(
    Array.from({ length: DUST_COUNT }, (_, index) => createDust(index))
  );
  const rightDustsRef = useRef<Dust[]>(
    Array.from({ length: DUST_COUNT }, (_, index) => createDust(index + 1.5))
  );
  const [motion, setMotion] = useState<MotionState>({
    leftLookX: 0,
    leftLookY: 0,
    rightLookX: 0,
    rightLookY: 0,
    lookX: 0,
    lookY: 0,
    blink: 0,
    shimmer: 0.18,
  });

  useEffect(() => {
    const pointerHandler = (event: PointerEvent) => {
      pointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        active: true,
        lastMoveAt: performance.now(),
      };
    };

    const clearPointer = () => {
      pointerRef.current.active = false;
    };

    window.addEventListener("pointermove", pointerHandler, { passive: true });
    window.addEventListener("pointerleave", clearPointer);
    window.addEventListener("pointercancel", clearPointer);

    return () => {
      window.removeEventListener("pointermove", pointerHandler);
      window.removeEventListener("pointerleave", clearPointer);
      window.removeEventListener("pointercancel", clearPointer);
    };
  }, []);

  useEffect(() => {
    let frame = 0;

    const getEyeTarget = (
      eyeNode: HTMLDivElement | null,
      time: number,
      side: "left" | "right"
    ) => {
      let targetX =
        Math.sin(time * 0.0006 + motionRef.current.phase + (side === "left" ? 0.35 : -0.35)) *
        0.07;
      let targetY =
        Math.cos(time * 0.00042 + motionRef.current.phase * 1.2 + (side === "left" ? 0.22 : -0.22)) *
        0.05;

      if (
        eyeNode &&
        pointerRef.current.active &&
        time - pointerRef.current.lastMoveAt < 2200
      ) {
        const rect = eyeNode.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = pointerRef.current.x - centerX;
        const dy = pointerRef.current.y - centerY;
        const normalizedX = clamp(dx / (window.innerWidth * 0.16), -1, 1);
        const normalizedY = clamp(dy / (window.innerHeight * 0.18), -1, 1);
        targetX = normalizedX * 0.36;
        targetY = normalizedY * 0.28;

        const distance = Math.hypot(dx, dy);
        const closeness = clamp(1 - distance / Math.min(window.innerWidth, window.innerHeight), 0, 1);
        targetX *= 1 + closeness * 0.16;
        targetY *= 1 + closeness * 0.08;
      }

      if (isTyping) {
        targetX *= 0.92;
        targetY *= 0.92;
      }

      if (isThinking) {
        targetX += Math.sin(time * 0.0042 + (side === "left" ? 0.4 : -0.4)) * 0.035;
        targetY += Math.cos(time * 0.0031 + (side === "left" ? 0.2 : -0.2)) * 0.025;
      }

      return {
        x: clamp(targetX, -0.42, 0.42),
        y: clamp(targetY, -0.32, 0.32),
      };
    };

    const tick = (time: number) => {
      const motionState = motionRef.current;
      const leftTarget = getEyeTarget(leftEyeRef.current, time, "left");
      const rightTarget = getEyeTarget(rightEyeRef.current, time, "right");
      const followStrength = isThinking ? 0.24 : 0.2;

      motionState.leftLookX +=
        (leftTarget.x - motionState.leftLookX) * followStrength;
      motionState.leftLookY +=
        (leftTarget.y - motionState.leftLookY) * followStrength;
      motionState.rightLookX +=
        (rightTarget.x - motionState.rightLookX) * followStrength;
      motionState.rightLookY +=
        (rightTarget.y - motionState.rightLookY) * followStrength;
      motionState.lookX +=
        ((leftTarget.x + rightTarget.x) / 2 - motionState.lookX) * followStrength;
      motionState.lookY +=
        ((leftTarget.y + rightTarget.y) / 2 - motionState.lookY) * followStrength;

      if (!motionState.nextBlinkAt) {
        motionState.nextBlinkAt = time + 1600 + Math.random() * 2200;
      }

      if (motionState.blinkState === "idle" && time >= motionState.nextBlinkAt) {
        motionState.blinkState = "closing";
      }

      if (motionState.blinkState === "closing") {
        motionState.blink = Math.min(1, motionState.blink + (isThinking ? 0.28 : 0.22));
        if (motionState.blink >= 1) {
          motionState.blinkState = "opening";
          motionState.holdUntil = time + (isThinking ? 90 : 35);
        }
      } else if (motionState.blinkState === "opening" && time >= motionState.holdUntil) {
        motionState.blink = Math.max(0, motionState.blink - 0.24);
        if (motionState.blink <= 0) {
          motionState.blinkState = "idle";
          motionState.nextBlinkAt =
            time +
            (isThinking ? 1100 : 2100) +
            Math.random() * (isTyping ? 1400 : 2600);
        }
      }

      const shimmer = isThinking
        ? 0.72 + Math.sin(time * 0.006) * 0.2
        : isTyping
          ? 0.34 + Math.sin(time * 0.0032) * 0.06
          : 0.16;

      setMotion({
        leftLookX: motionState.leftLookX,
        leftLookY: motionState.leftLookY,
        rightLookX: motionState.rightLookX,
        rightLookY: motionState.rightLookY,
        lookX: motionState.lookX,
        lookY: motionState.lookY,
        blink: motionState.blink,
        shimmer,
      });

      renderIris(
        leftCanvasRef.current,
        leftDustsRef.current,
        time,
        motionState.leftLookX,
        motionState.leftLookY,
        isThinking,
        0.12
      );
      renderIris(
        rightCanvasRef.current,
        rightDustsRef.current,
        time,
        motionState.rightLookX,
        motionState.rightLookY,
        isThinking,
        -0.08
      );

      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isThinking, isTyping]);

  const statusGlow = isThinking
    ? "shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_0_34px_rgba(239,68,68,0.18)]"
    : isTyping
      ? "shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_0_24px_rgba(249,115,22,0.12)]"
      : "shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_10px_22px_rgba(0,0,0,0.4)]";

  return (
    <div
      aria-label="Ember"
      className={cn("flex items-center gap-1", className)}
    >
      <div className={cn("rounded-full p-1", statusGlow)}>
        <EyeOrb
          eyeRef={leftEyeRef}
          canvasRef={leftCanvasRef}
          lookX={motion.leftLookX}
          lookY={motion.leftLookY}
          blink={motion.blink}
          shimmer={motion.shimmer}
          isTyping={isTyping}
          isThinking={isThinking}
          phaseOffset={0.12}
        />
      </div>
      <div className={cn("rounded-full p-1", statusGlow)}>
        <EyeOrb
          eyeRef={rightEyeRef}
          canvasRef={rightCanvasRef}
          lookX={motion.rightLookX}
          lookY={motion.rightLookY}
          blink={motion.blink}
          shimmer={motion.shimmer}
          isTyping={isTyping}
          isThinking={isThinking}
          phaseOffset={-0.08}
        />
      </div>
    </div>
  );
}
