function createTelegramService({ botToken, chatId, timeoutMs = 8000 } = {}) {
  const enabled = Boolean(botToken && chatId);
  const endpoint = enabled ? `https://api.telegram.org/bot${botToken}/sendMessage` : null;

  async function sendWaitingNotification({ sessionName, patternName, matchedText, excerpt, resetTime, timestamp }) {
    if (!enabled || !endpoint) {
      return { ok: false, skipped: true, reason: "not_configured" };
    }

    const MAX_EXCERPT = 800;
    const excerptTrimmed = excerpt && excerpt.length > MAX_EXCERPT
      ? "…" + excerpt.slice(-(MAX_EXCERPT - 1))
      : (excerpt || "(empty)");

    const body = {
      chat_id: chatId,
      text:
        `Session: ${sessionName}\n\n` +
        `AI is waiting for input.\n` +
        `Matched pattern: ${patternName || "unknown"}\n` +
        `Matched text: ${matchedText || "n/a"}\n` +
        `Rate limit reset: ${resetTime || "n/a"}\n` +
        `Detected at: ${timestamp}\n\n` +
        `Recent output:\n` +
        `${excerptTrimmed}`,
    };

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return { ok: false, error: `telegram_http_${resp.status}:${errText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || "telegram_request_failed" };
    }
  }

  return {
    enabled,
    sendWaitingNotification,
  };
}

module.exports = { createTelegramService };
