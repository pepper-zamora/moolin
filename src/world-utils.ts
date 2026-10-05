// World/character helpers shared by the main process and the renderer, so
// they must stay free of Node and Electron imports.
import type { Character, GlobalSettings, TriState, World } from "./worlds-types";

export const DEFAULT_LOGIN_TEMPLATE = 'co "{{character}}" {{password}}\\r';
export const DEFAULT_PORT = 7777;

// Word wrap starts off (today's plain column-wrap behavior is unchanged
// until someone opts in); echo keeps its long-standing default-on behavior.
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = { wordWrap: false, echoCommands: true };

// Character → World → Global: the first override that isn't "inherit" wins,
// else Global's plain boolean. Callers pass overrides most-specific first.
export function resolveTriState(global: boolean, ...overrides: TriState[]): boolean {
  for (const override of overrides) {
    if (override === "on") return true;
    if (override === "off") return false;
  }
  return global;
}

export function newWorld(id: string): World {
  return {
    id,
    name: "New World",
    host: "",
    port: DEFAULT_PORT,
    tls: false,
    tlsAllowUntrusted: false,
    autoLogin: true,
    loginTemplate: DEFAULT_LOGIN_TEMPLATE,
    echoCommands: "inherit",
    wordWrap: "inherit",
    characters: [],
  };
}

export function newCharacter(id: string): Character {
  return { id, name: "New Character", password: "", echoCommands: "inherit", wordWrap: "inherit" };
}

export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

// Whether a world has enough filled in to connect to.
export function isConnectable(world: World): boolean {
  return world.host.trim().length > 0 && isValidPort(world.port);
}

export function worldLabel(world: World): string {
  return world.name.trim() || world.host.trim() || "Unnamed world";
}

export function characterLabel(character: Character): string {
  return character.name.trim() || "Unnamed character";
}

// "Character - World" or just "World", as used in window titles and menus.
export function targetLabel(world: World, character: Character | null): string {
  return character ? `${characterLabel(character)} - ${worldLabel(world)}` : worldLabel(world);
}

// Expands {{character}} and {{password}}, plus the escapes \r, \n and \\.
// Done in one pass so substituted text is never itself unescaped.
export function expandLoginTemplate(template: string, character: string, password: string): string {
  return template.replace(/\\([\\rn])|\{\{(character|password)\}\}/g, (_match, escaped?: string, key?: string) => {
    if (escaped) return escaped === "r" ? "\r" : escaped === "n" ? "\n" : "\\";
    return key === "character" ? character : password;
  });
}

// A confirmation question, with its consequences spelled out beneath it.
export interface Prompt {
  message: string;
  detail: string;
}

// How many characters a world's delete prompt names before summarizing.
const PROMPT_MAX_NAMES = 5;

const LOGS_KEPT = "Session logs already written are kept. This can't be undone.";

// Asked before deleting a world, making plain that its characters go with it.
export function deleteWorldPrompt(world: World): Prompt {
  const count = world.characters.length;
  const message = `Delete the world "${worldLabel(world)}"?`;
  if (count === 0) return { message, detail: `It has no characters. ${LOGS_KEPT}` };
  const names = world.characters.slice(0, PROMPT_MAX_NAMES).map((c) => `"${characterLabel(c)}"`);
  if (count > PROMPT_MAX_NAMES) names.push(`${count - PROMPT_MAX_NAMES} more`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const its = count === 1 ? "Its character" : `All ${count} of its characters`;
  return { message, detail: `${its}, ${list}, will be deleted too. ${LOGS_KEPT}` };
}

export function deleteCharacterPrompt(world: World, character: Character): Prompt {
  return {
    message: `Delete the character "${characterLabel(character)}" from "${worldLabel(world)}"?`,
    detail: LOGS_KEPT,
  };
}
