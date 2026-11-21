// Sokoban solver: per-room push-optimal A* search, rooms solved independently.
//
// A level is a 1-wide hallway (the row the player starts on) with 1-4 rooms
// hanging off it, one door each. Boxes can never leave their room (a box pushed
// into the hallway could never be pushed back), so the level's push-optimal
// count is the sum of the rooms' optima and each room can be solved on its own.
// This program finds the rooms by deleting the hallway row from the floor
// graph, solves each room with A* over pushes, and walks the player between
// rooms along the hallway. Everything is deterministic: iteration orders are
// fixed, ties break on a sequence number, and the search is budgeted by node
// count, never by the wall clock, so two runs write byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];
// Node budgets (expansions). The per-room cap bounds one hard room; the
// global cap bounds the whole run, so a pathological set still finishes and
// writes answers for the instances it could solve instead of timing out.
const MAX_EXPAND_ROOM = 250000;
const MAX_EXPAND_TOTAL = 600000;
let totalExpanded = 0;

type Grid = {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  box: Uint8Array;
  player: number;
};

type Room = {
  // Sorted floor cells of the room (global indices). Boxes never leave these.
  cells: number[];
  cellSet: Uint8Array;
  boxes: number[];
  goals: number[];
  hallRow: number;
  w: number;
  h: number;
};

/** Neighbour of cell c in direction d (0 up, 1 down, 2 left, 3 right), or -1. */
function step(c: number, d: number, w: number, h: number): number {
  const x = c % w;
  const y = (c / w) | 0;
  if (d === 0) return y > 0 ? c - w : -1;
  if (d === 1) return y < h - 1 ? c + w : -1;
  if (d === 2) return x > 0 ? c - 1 : -1;
  return x < w - 1 ? c + 1 : -1;
}

function parseLevel(text: string): Grid {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const box = new Uint8Array(w * h);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') box[i] = 1;
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goal, box, player };
}

/** Flood fill from `from` over walkable cells, avoiding blocked cells. */
function flood(from: number, walkable: Uint8Array, blocked: Uint8Array, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const q = [from];
  seen[from] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(c, d, w, h);
      if (n !== -1 && walkable[n] && !blocked[n] && !seen[n]) {
        seen[n] = 1;
        q.push(n);
      }
    }
  }
  return seen;
}

/** Shortest walk (as move letters) from `from` to `to`, or null. */
function findPath(from: number, to: number, walkable: Uint8Array, blocked: Uint8Array, w: number, h: number): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-2);
  const prevCh = new Array<string>(w * h).fill('');
  const q = [from];
  prev[from] = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(c, d, w, h);
      if (n === -1 || !walkable[n] || blocked[n] || prev[n] !== -2) continue;
      prev[n] = c;
      prevCh[n] = CH[d];
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) {
          s = prevCh[cur] + s;
          cur = prev[cur];
        }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

/** Shortest walk from `from` to the nearest cell of the hallway row. */
function findPathToHallway(from: number, walkable: Uint8Array, blocked: Uint8Array, w: number, h: number, hallRow: number): { path: string; cell: number } | null {
  if ((from / w | 0) === hallRow) return { path: '', cell: from };
  const prev = new Int32Array(w * h).fill(-2);
  const prevCh = new Array<string>(w * h).fill('');
  const q = [from];
  prev[from] = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = step(c, d, w, h);
      if (n === -1 || !walkable[n] || blocked[n] || prev[n] !== -2) continue;
      prev[n] = c;
      prevCh[n] = CH[d];
      if ((n / w | 0) === hallRow) {
        let s = '';
        let cur = n;
        while (cur !== from) {
          s = prevCh[cur] + s;
          cur = prev[cur];
        }
        return { path: s, cell: n };
      }
      q.push(n);
    }
  }
  return null;
}

/** A minimal binary min-heap ordered by (f, h, seq). */
type HeapItem = { f: number; h: number; seq: number; key: string };
class Heap {
  a: HeapItem[] = [];
  get size(): number {
    return this.a.length;
  }
  push(it: HeapItem): void {
    const a = this.a;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(a[i], a[p]) < 0) {
        const t = a[i];
        a[i] = a[p];
        a[p] = t;
        i = p;
      } else break;
    }
  }
  pop(): HeapItem {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as HeapItem;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        const t = a[i];
        a[i] = a[m];
        a[m] = t;
        i = m;
      }
    }
    return top;
  }
}
function cmp(a: HeapItem, b: HeapItem): number {
  if (a.f !== b.f) return a.f - b.f;
  if (a.h !== b.h) return a.h - b.h;
  return a.seq - b.seq;
}

type NodeRec = {
  parent: string;
  boxes: number[];
  player: number;
  from: number;
  to: number;
  dir: number;
  g: number;
};

/**
 * Solve one room push-optimally. The player starts wherever they are (in the
 * hallway); the walkable set is the room's floor plus the whole hallway row,
 * so the player can enter through the door, stand in the hallway to push a
 * box that sits in the doorway, and leave again. Boxes stay on room cells.
 * Returns the moves (walks + pushes) and the player's final hallway cell,
 * or null when the room cannot be solved within the node budget.
 */
function solveRoom(room: Room, grid: Grid, startPlayer: number, startBoxes: number[]): { moves: string; endPlayer: number } | null {
  const { w, h, cells, cellSet, goals, hallRow } = room;
  const goalSet = new Uint8Array(w * h);
  for (const g of goals) goalSet[g] = 1;

  // Walkable cells: the room's floor plus every floor cell of the hallway row.
  const walkable = new Uint8Array(w * h);
  for (const c of cells) walkable[c] = 1;
  for (let x = 0; x < w; x++) {
    const c = hallRow * w + x;
    if (!grid.wall[c]) walkable[c] = 1;
  }
  const isBoxCell = (c: number): boolean => c !== -1 && cellSet[c] === 1;
  const isStandCell = (c: number): boolean => c !== -1 && walkable[c] === 1;

  // All-pairs shortest distances between room cells (boxes move only here),
  // as a flat array indexed by cell so the heuristic is a few array reads.
  const distArr: (Int32Array | undefined)[] = new Array(w * h);
  for (const s of cells) {
    const d = new Int32Array(w * h).fill(-1);
    d[s] = 0;
    const q = [s];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      for (let dir = 0; dir < 4; dir++) {
        const n = step(c, dir, w, h);
        if (n !== -1 && cellSet[n] && d[n] === -1) {
          d[n] = d[c] + 1;
          q.push(n);
        }
      }
    }
    distArr[s] = d;
  }

  // Dead squares: a non-goal room cell a box can never leave towards a goal.
  // Least fixpoint: a cell is dead when every push from it is impossible, is
  // made from a cell the player cannot stand on, or lands on a dead cell.
  // (Boxes only hinder each other, so a cell dead for one box alone is dead.)
  const dead = new Uint8Array(w * h);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of cells) {
      if (goalSet[c] || dead[c]) continue;
      let allBad = true;
      for (let d = 0; d < 4; d++) {
        const dest = step(c, d, w, h);
        const stand = step(c, d ^ 1, w, h);
        if (isBoxCell(dest) && isStandCell(stand) && !dead[dest]) {
          allBad = false;
          break;
        }
      }
      if (allBad) {
        dead[c] = 1;
        changed = true;
      }
    }
  }

  // 2x2 blocks: a block whose four cells are all boxes or cells the player
  // cannot stand on, holding a box off its goal, can never be undone: every
  // push of a box in the block needs a destination or a standing cell inside
  // it. Only blocks touching the moved box can newly appear, so index them
  // by cell.
  const blocksByCell = new Map<number, number[][]>();
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const b = [y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1];
      if (!b.some((c) => cellSet[c])) continue;
      for (const c of b) {
        const list = blocksByCell.get(c);
        if (list) list.push(b);
        else blocksByCell.set(c, [b]);
      }
    }
  }
  // `boxSet` holds the boxes before the push; the box that moved went from
  // `from` to `moved`, so a block cell holds a box exactly when it is
  // `moved`, or it was a box and is not `from`.
  const deadlock2x2 = (moved: number, from: number, boxSet: Set<number>): boolean => {
    const list = blocksByCell.get(moved);
    if (!list) return false;
    for (const b of list) {
      let hasBadBox = false;
      let allBlocked = true;
      for (const c of b) {
        const isBox = c === moved || (c !== from && boxSet.has(c));
        if (isBox) {
          if (!goalSet[c]) hasBadBox = true;
        } else if (isStandCell(c)) {
          allBlocked = false;
          break;
        }
      }
      if (allBlocked && hasBadBox) return true;
    }
    return false;
  };

  // Admissible heuristic: the cheapest assignment of boxes to goals, summed
  // over precomputed distances. One push moves one box one cell, so the
  // assignment cost can fall by at most 1 per push: the heuristic is
  // consistent and A* is push-optimal.
  const heuristic = (boxes: number[]): number => {
    const n = boxes.length;
    // The generator gives as many goals as boxes; if a level ever did not,
    // fall back to the (still admissible) sum of each box's nearest goal.
    if (goals.length !== n) {
      let s = 0;
      for (const b of boxes) {
        const d = distArr[b] as Int32Array;
        let m = Infinity;
        for (const g of goals) if (d[g] !== -1 && d[g] < m) m = d[g];
        if (m === Infinity) return Infinity;
        s += m;
      }
      return s;
    }
    const perm = goals.slice();
    let best = Infinity;
    const rec = (k: number): void => {
      if (k === n) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = (distArr[boxes[i]] as Int32Array)[perm[i]];
          if (d === -1) return;
          s += d;
          if (s >= best) return;
        }
        if (s < best) best = s;
        return;
      }
      for (let i = k; i < n; i++) {
        const t = perm[k];
        perm[k] = perm[i];
        perm[i] = t;
        rec(k + 1);
        perm[i] = perm[k];
        perm[k] = t;
      }
    };
    rec(0);
    return best;
  };

  const keyOf = (boxes: number[], player: number): string => boxes.join(',') + '|' + player;

  const start = startBoxes.slice().sort((a, b) => a - b);
  const startKey = keyOf(start, startPlayer);
  const nodes = new Map<string, NodeRec>();
  nodes.set(startKey, { parent: '', boxes: start, player: startPlayer, from: -1, to: -1, dir: -1, g: 0 });
  const best = new Map<string, number>();
  best.set(startKey, 0);
  const h0 = heuristic(start);
  if (h0 === Infinity) return null;
  const heap = new Heap();
  let seq = 0;
  heap.push({ f: h0, h: h0, seq: seq++, key: startKey });

  let expanded = 0;
  let goalKey = '';
  while (heap.size > 0) {
    const cur = heap.pop();
    const rec = nodes.get(cur.key) as NodeRec;
    if (rec.g !== best.get(cur.key)) continue; // stale heap entry
    const boxSet = new Set(rec.boxes);
    const blocked = new Uint8Array(w * h);
    for (const b of rec.boxes) blocked[b] = 1;
    const reach = flood(rec.player, walkable, blocked, w, h);
    // Goal: every box on a goal and the player able to walk back out to the
    // hallway (through the door) from where the last push left them.
    let solved = true;
    for (const b of rec.boxes) {
      if (!goalSet[b]) {
        solved = false;
        break;
      }
    }
    if (solved) {
      let canExit = false;
      for (let x = 0; x < w; x++) {
        if (reach[hallRow * w + x]) {
          canExit = true;
          break;
        }
      }
      if (canExit) {
        goalKey = cur.key;
        break;
      }
    }
    expanded++;
    totalExpanded++;
    if (expanded > MAX_EXPAND_ROOM || totalExpanded > MAX_EXPAND_TOTAL) return null;
    for (let i = 0; i < rec.boxes.length; i++) {
      const b = rec.boxes[i];
      for (let d = 0; d < 4; d++) {
        const dest = step(b, d, w, h);
        if (!isBoxCell(dest) || boxSet.has(dest)) continue;
        const stand = step(b, d ^ 1, w, h);
        if (!isStandCell(stand) || boxSet.has(stand)) continue;
        if (!reach[stand]) continue;
        if (dead[dest]) continue;
        if (deadlock2x2(dest, b, boxSet)) continue;
        const nb = rec.boxes.slice();
        nb[i] = dest;
        nb.sort((a, b2) => a - b2);
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const g2 = rec.g + 1;
        const k2 = keyOf(nb, b);
        const prev = best.get(k2);
        if (prev !== undefined && prev <= g2) continue;
        best.set(k2, g2);
        nodes.set(k2, { parent: cur.key, boxes: nb, player: b, from: b, to: dest, dir: d, g: g2 });
        heap.push({ f: g2 + hh, h: hh, seq: seq++, key: k2 });
      }
    }
  }
  if (goalKey === '') return null;

  // Rebuild the move string: for each push, walk the player to the pushing
  // square (shortest path, boxes as obstacles), then the push itself; finally
  // walk out to the hallway.
  const pushes: NodeRec[] = [];
  let r = nodes.get(goalKey) as NodeRec;
  while (r.parent !== '') {
    pushes.push(r);
    r = nodes.get(r.parent) as NodeRec;
  }
  pushes.reverse();
  let moves = '';
  let player = startPlayer;
  const curBoxes = new Set(start);
  const blocked = new Uint8Array(w * h);
  for (const b of start) blocked[b] = 1;
  for (const p of pushes) {
    const stand = step(p.from, p.dir ^ 1, w, h);
    const path = findPath(player, stand, walkable, blocked, w, h);
    if (path === null) return null;
    moves += path;
    moves += CH[p.dir];
    blocked[p.from] = 0;
    blocked[p.to] = 1;
    curBoxes.delete(p.from);
    curBoxes.add(p.to);
    player = p.from;
  }
  const exit = findPathToHallway(player, walkable, blocked, w, h, hallRow);
  if (exit === null) return null;
  moves += exit.path;
  return { moves, endPlayer: exit.cell };
}

/** Split a level into its rooms: floor components once the hallway row is cut. */
function findRooms(grid: Grid): Room[] {
  const { w, h } = grid;
  const hallRow = (grid.player / w) | 0;
  const visited = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let c = 0; c < w * h; c++) {
    if (grid.wall[c] || (c / w | 0) === hallRow || visited[c]) continue;
    const comp: number[] = [];
    const q = [c];
    visited[c] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi];
      comp.push(x);
      for (let d = 0; d < 4; d++) {
        const n = step(x, d, w, h);
        if (n !== -1 && !grid.wall[n] && (n / w | 0) !== hallRow && !visited[n]) {
          visited[n] = 1;
          q.push(n);
        }
      }
    }
    comp.sort((a, b) => a - b);
    const boxes = comp.filter((x) => grid.box[x]);
    const goals = comp.filter((x) => grid.goal[x]);
    if (boxes.length === 0) continue;
    const cellSet = new Uint8Array(w * h);
    for (const x of comp) cellSet[x] = 1;
    rooms.push({ cells: comp, cellSet, boxes, goals, hallRow, w, h });
  }
  // Deterministic order: by lowest cell index.
  rooms.sort((a, b) => a.cells[0] - b.cells[0]);
  return rooms;
}

function solveLevel(text: string): string {
  const grid = parseLevel(text);
  const rooms = findRooms(grid);
  let moves = '';
  let player = grid.player;
  for (const room of rooms) {
    const res = solveRoom(room, grid, player, room.boxes);
    if (res === null) return ''; // unsolved room: a valid but empty answer
    moves += res.moves;
    player = res.endPlayer;
  }
  return moves;
}

for (const id of readdirSync(I, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
