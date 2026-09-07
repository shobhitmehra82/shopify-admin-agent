// Reads the server-sent event stream from POST /api/chat.
//
// EventSource can only issue GET requests, so the stream is consumed from
// fetch() by hand. Frames are `event: <name>\ndata: <json>\n\n`.

/**
 * @param {string} url
 * @param {object} body JSON request body
 * @param {(event: string, data: object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function streamEvents(url, body, onEvent, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    // Errors before the stream opens come back as plain JSON.
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed with ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // A chunk can split mid-frame, so keep the trailing partial in the buffer.
    const frames = buffer.split("\n\n");
    buffer = frames.pop();

    for (const frame of frames) {
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try {
        onEvent(event, JSON.parse(data.join("\n")));
      } catch {
        // Ignore a frame we cannot parse rather than killing the stream.
      }
    }
  }
}
