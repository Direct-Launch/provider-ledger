// Tool calls inside an assistant message, and the class each one belongs to.
//
// An OpenCode 2 assistant message carries `content: [ … ]`; an entry is `{ type: "text" }` or a
// tool part `{ type: "tool", id, name, executed?, state: { status, input, content?, metadata? } }`.
// Only the tool's name, the one input field that names a skill or a subagent, the state's status
// and the length of the result text are read. The result text itself is never kept.
import { cleanKey } from './attribution.ts';

export type ToolClass = 'skill' | 'mcp' | 'agent' | 'tool';

export type ToolCall = {
  cls: ToolClass;
  /** The skill, the MCP server, the subagent type or the tool's own name. Never carries a `|`. */
  name: string;
  /** Characters of the returned text when the call had completed; 0 otherwise. */
  contextChars: number;
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const str = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null
);

/** OpenCode's skill tool. Its input names the skill (`name`; this OpenCode build sends `id`). */
const SKILL_TOOL = 'skill';
/** The tools that start a subagent: `task` in OpenCode 1 and 2, `subagent` in builds that renamed it. */
const SUBAGENT_TOOLS = new Set(['task', 'subagent']);
/** `mcp_<server>_<tool>`: the server is the first segment after `mcp_`, which carries no underscore. */
const MCP_NAME = /^mcp_([^_\s]+)_(.+)$/;

/**
 * The class and name of one tool call. A name that does not follow a convention is `tool:<name>`;
 * a server is never guessed from a name that does not carry one.
 */
export const classifyTool = (toolName: string, input: unknown): { cls: ToolClass; name: string } => {
  const own = (cls: ToolClass, name: string | null): { cls: ToolClass; name: string } => {
    const cleaned = name === null ? '' : cleanKey(name);
    return cleaned === '' ? { cls: 'tool', name: cleanKey(toolName) || 'unnamed' } : { cls, name: cleaned };
  };
  const fields = isObject(input) ? input : {};
  if (toolName === SKILL_TOOL) return own('skill', str(fields.name) ?? str(fields.id));
  if (SUBAGENT_TOOLS.has(toolName)) return own('agent', str(fields.subagent_type) ?? str(fields.agent));
  const mcp = MCP_NAME.exec(toolName);
  if (mcp) return own('mcp', mcp[1] ?? null);
  return own('tool', toolName);
};

/** Characters of the text a completed tool state returned. */
const resultChars = (state: Record<string, unknown>): number => {
  if (state.status !== 'completed') return 0;
  let total = 0;
  if (Array.isArray(state.content)) {
    for (const entry of state.content) {
      if (isObject(entry) && entry.type === 'text' && typeof entry.text === 'string') total += entry.text.length;
    }
  } else if (typeof state.output === 'string') {
    // The earlier OpenCode shape kept the result as one string.
    total += state.output.length;
  }
  return total;
};

/** Every tool call of one message, from its `content` (and the older `parts`). Calls with no name are not counted. */
export const toolCallsOf = (raw: unknown): ToolCall[] => {
  if (!isObject(raw)) return [];
  const info = isObject(raw.info) ? raw.info : raw;
  const lists = [raw.content, info.content, raw.parts].filter(Array.isArray);
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const part of list) {
      if (!isObject(part) || part.type !== 'tool') continue;
      const name = str(part.name) ?? str(part.tool);
      if (name === null) continue;
      const id = str(part.id) ?? str(part.callID);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const state = isObject(part.state) ? part.state : {};
      calls.push({ ...classifyTool(name, state.input), contextChars: resultChars(state) });
    }
  }
  return calls;
};

export const toolKey = (date: string, provider: string, model: string, cls: ToolClass, name: string): string => (
  `${date}|${provider}|${model}|${cls}|${name}`
);

export type ParsedToolKey = { date: string; provider: string; model: string; cls: ToolClass; name: string };

const CLASSES: ReadonlySet<string> = new Set<ToolClass>(['skill', 'mcp', 'agent', 'tool']);

/** Neither the class nor the name carries a `|`, so they are what follows the last two bars; a model id may carry some. */
export const parseToolKey = (key: string): ParsedToolKey | null => {
  const first = key.indexOf('|');
  const second = first < 0 ? -1 : key.indexOf('|', first + 1);
  const last = key.lastIndexOf('|');
  const before = last < 0 ? -1 : key.lastIndexOf('|', last - 1);
  if (first < 0 || second < 0 || before <= second || last <= before) return null;
  const cls = key.slice(before + 1, last);
  const name = key.slice(last + 1);
  if (!CLASSES.has(cls) || name === '') return null;
  return { date: key.slice(0, first), provider: key.slice(first + 1, second), model: key.slice(second + 1, before), cls: cls as ToolClass, name };
};
