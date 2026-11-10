// Guest conversation window (1.1.14): the last answered user→assistant pairs
// of the thread on screen. Only replies marked `ok` count — error, waiting
// and model-switch bubbles never become "context". The server re-checks and
// trims to the worker's budget.
export const GUEST_HISTORY_TURNS = 10;
export function guestTurns(chat) {
  const out = [];
  const list = Array.isArray(chat) ? chat : [];
  for (let i = 0; i + 1 < list.length; i++) {
    const u = list[i]; const a = list[i + 1];
    if (u && a && u.role === 'user' && a.role === 'assistant' && a.ok
      && typeof u.content === 'string' && typeof a.content === 'string' && a.content.trim()) {
      out.push({ role: 'user', content: u.content }, { role: 'assistant', content: a.content });
      i++;
    }
  }
  return out.slice(-GUEST_HISTORY_TURNS * 2);
}

