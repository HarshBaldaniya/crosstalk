// Every page's keyboard shortcuts, in one place, for the sheet on the top bar (? on any page).
import type { BoardTab } from "../src/core/protocol";

type Keys = [string[], string][];
export interface KeySection {
  title: string;
  keys: Keys;
}

const EVERYWHERE: KeySection = {
  title: "Everywhere",
  keys: [
    [["T"], "Tower"],
    [["U"], "Fuel"],
    [["M"], "Map"],
    [["C"], "Commands"],
    [["?"], "These shortcuts"],
  ],
};

const TOWER: Keys = [
  [["/"], "Find a chat"],
  [["N"], "New Claude chat"],
  [["L"], "Show or hide the chat list"],
  [["1"], "Arrange by channels"],
  [["2"], "Arrange by time"],
  [["3"], "Arrange by agent"],
  [["4"], "Arrange by folder"],
  [["0"], "Fit the Tower"],
  [["F"], "Focus: the Tower takes the whole window"],
  [["Delete"], "Take the selected cards off"],
  [["Esc"], "Close a menu, clear the search, deselect, leave focus"],
];

const FUEL: Keys = [
  [["D"], "Today"],
  [["A"], "All time"],
  [["R"], "Read every agent's plan limits again"],
  [["F"], "Focus: the page takes the whole window"],
  [["Esc"], "Leave focus"],
];

const MAP: Keys = [
  [["/"], "Find a file or function"],
  [["+"], "Zoom in"],
  [["−"], "Zoom out"],
  [["0"], "Show everything"],
  [["Esc"], "Clear what is picked"],
];

const COMMANDS: Keys = [
  [["/"], "Find a command"],
  [["↑", "↓"], "Previous or next command"],
  [["Esc"], "Clear the search"],
];

export const PAGE_KEYS: Record<BoardTab, KeySection[]> = {
  board: [{ title: "Tower", keys: TOWER }, EVERYWHERE],
  usage: [{ title: "Fuel", keys: FUEL }, EVERYWHERE],
  code: [{ title: "Map", keys: MAP }, EVERYWHERE],
  library: [{ title: "Commands", keys: COMMANDS }, EVERYWHERE],
  runs: [EVERYWHERE],
};
