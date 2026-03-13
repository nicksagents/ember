function mentionsServerTarget(userContent) {
  const text = String(userContent || "").toLowerCase();
  return (
    /\b(server|dev server|development server|localhost|0\.0\.0\.0|127\.0\.0\.1|port\s+\d{2,5})\b/.test(
      text
    ) ||
    /\bnpm run dev\b/.test(text)
  );
}

function looksLikeServerActionRequest(userContent) {
  const text = String(userContent || "").toLowerCase().trim();
  if (!text) return false;
  if (
    /\b(?:kill|stop|shutdown|shut down|terminate|end|close|free up|restart|reboot|reload|relaunch|verify|check|confirm|make sure)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (/^(?:can|could|would|will)\s+you\b/.test(text)) return true;
  if (/^(?:please|help me(?:\s+to)?|i need you to|need you to)\b/.test(text)) {
    return true;
  }
  if (
    /^(?:start|run|host|serve|launch|boot|restart|reboot|reload|relaunch|stop|shutdown|shut down|terminate|end|close|kill|free up|verify|check|confirm|make sure)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (
    /\b(?:is|are)\s+(?:it|the\s+(?:server|site|app|port)|localhost|127\.0\.0\.1|0\.0\.0\.0)\s+(?:running|up|live|reachable|responding|free)\b/.test(
      text
    )
  ) {
    return true;
  }
  if (/\bnpm run dev\b/.test(text)) return true;
  return false;
}

export function looksLikeServerTaskRequest(userContent) {
  return (
    mentionsServerTarget(userContent) &&
    looksLikeServerActionRequest(userContent)
  );
}

export function extractRequestedPort(userContent, fallback = 3000) {
  const text = String(userContent || "");
  const match =
    text.match(/\bport\s+(\d{2,5})\b/i) ||
    text.match(/:(\d{2,5})\b/) ||
    text.match(/\bon\s+(\d{2,5})\b/i);
  const port = Number.parseInt(match?.[1] || "", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return fallback;
  return port;
}

export function extractRequestedHost(userContent, fallback = "0.0.0.0") {
  const text = String(userContent || "").toLowerCase();
  if (text.includes("0.0.0.0")) return "0.0.0.0";
  if (text.includes("127.0.0.1")) return "127.0.0.1";
  if (text.includes("localhost")) return "127.0.0.1";
  return fallback;
}

export function classifyProcessTask(userContent) {
  if (!looksLikeServerTaskRequest(userContent)) return null;
  const text = String(userContent || "").toLowerCase();
  const port = extractRequestedPort(userContent, 3000);
  const host = extractRequestedHost(userContent, "0.0.0.0");

  const isStop =
    /\b(kill|stop|shutdown|shut down|terminate|end|close)\b/.test(text) ||
    /\bfree up\b/.test(text);
  const isRestart =
    /\b(restart|reboot|reload|relaunch)\b/.test(text) ||
    (/\bstart\b/.test(text) && isStop);
  const isVerify =
    /\b(verify|check|confirm|is it running|make sure)\b/.test(text) &&
    !/\b(start|run|host|serve|launch)\b/.test(text);
  const isStart =
    /\b(start|run|host|serve|launch|boot)\b/.test(text) ||
    /\bnpm run dev\b/.test(text);

  let intent = "inspect";
  if (isRestart) intent = "restart";
  else if (isStop) intent = "stop";
  else if (isStart) intent = "start";
  else if (isVerify) intent = "verify_up";

  return { intent, host, port };
}
