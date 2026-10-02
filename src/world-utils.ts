// World/character helpers shared by the main process and the renderer, so
// they must stay free of Node and Electron imports.
import type { Character, World } from "./worlds-types";

export const DEFAULT_LOGIN_TEMPLATE = "co {{character}} {{password}}\\r";
export const DEFAULT_PORT = 7777;

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
    characters: [],
  };
}

export function newCharacter(id: string): Character {
  return { id, name: "New Character", password: "" };
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
  return template.replace(/\\([\\rn])|\{\{(character|password)\}\}/g, (_match, escape?: string, key?: string) => {
    if (escape) return escape === "r" ? "\r" : escape === "n" ? "\n" : "\\";
    return key === "character" ? character : password;
  });
}
